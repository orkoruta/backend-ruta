import { PgBoss } from 'pg-boss';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { registerOrderExpirationJob } from './order_expiration.job.js';
import { registerPaymentTimeoutJob } from './payment_timeout.job.js';
import { registerCleanupIdempotencyJob } from './cleanup_idempotency.job.js';
import { registerCleanupSessionsJob } from './cleanup_sessions.job.js';
import { registerCleanupGuestBuyersJob } from './cleanup_guest_buyers.job.js';
import { registerPurgeCollectionEvidenceJob } from './purge_collection_evidence.job.js';
import { registerValidateOrderJob } from './validate_order.job.js'; // 2.BACK-2
import { registerAutoConfirmDeliveredJob } from './auto_confirm_delivered.job.js'; // 3.BACK-6
import { registerPickupExpirationJob } from './pickup_expiration.job.js'; // 4.BACK-1
import { registerAtPickupExpirationJob } from './at_pickup_expiration.job.js'; // 4.BACK-1
import { registerWebhookSenderJob } from './webhook_sender.job.js';
import { registerDeliveryEmailJob } from './delivery_email.job.js';
import { registerRecurrenceGeneratorJob } from './recurrence_generator.job.js'; // F3.B4.2.BACK-2

/**
 * Arranque y vigilancia de los jobs de mantenimiento (pg-boss).
 *
 * Antes esto fallaba **en silencio**: si `boss.start()` no conectaba —por
 * ejemplo con las conexiones de la BD agotadas, cosa que pasa con facilidad
 * porque el rol tiene un tope bajo— la promesa quedaba rechazada y memoizada
 * para siempre. La API seguía sirviendo HTTP con normalidad mientras la
 * expiración de pedidos, la recurrencia y los webhooks estaban muertos. Nadie
 * se enteraba hasta que alguien notaba que un pedido no avanzaba.
 *
 * Tres cambios para que eso no vuelva a pasar:
 *
 * 1. **Reintento con backoff.** Un fallo de arranque ya no es definitivo: la BD
 *    suele volver, y cuando vuelve los jobs se levantan solos.
 * 2. **Los errores de pg-boss se escuchan y se registran.** Sin un `on('error')`
 *    se pierden, y encima Node trata un evento `error` sin oyente como excepción.
 * 3. **El estado es consultable** (`getMaintenanceJobsStatus`) y `/healthz/jobs`
 *    lo expone, para que un monitor externo pueda avisar sin que haya que
 *    mirarlo a mano.
 */

export type JobsState =
  /** Apagados a propósito (entorno de test). */
  | 'disabled'
  | 'starting'
  | 'running'
  /** No se pudo arrancar. Se sigue reintentando. */
  | 'failed';

interface JobsStatus {
  state: JobsState;
  since: string;
  /** Último error de arranque o de ejecución, si lo hubo. */
  lastError: string | null;
  lastErrorAt: string | null;
  /** Intentos de arranque fallidos consecutivos. */
  failedAttempts: number;
  /** Errores emitidos por pg-boss ya en marcha (no tumban el arranque). */
  runtimeErrors: number;
}

let bossInstance: PgBoss | null = null;
let startPromise: Promise<void> | null = null;
let retryTimer: NodeJS.Timeout | null = null;

const status: JobsStatus = {
  state: 'disabled',
  since: new Date().toISOString(),
  lastError: null,
  lastErrorAt: null,
  failedAttempts: 0,
  runtimeErrors: 0,
};

function setState(next: JobsState): void {
  if (status.state === next) return;
  status.state = next;
  status.since = new Date().toISOString();
}

function recordError(err: unknown): void {
  status.lastError = err instanceof Error ? err.message : String(err);
  status.lastErrorAt = new Date().toISOString();
}

/** Backoff: 5s, 10s, 20s… con tope de 5 min. Se reintenta indefinidamente. */
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;

function nextRetryDelay(attempt: number): number {
  return Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
}

async function startBoss(): Promise<void> {
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  /*
   * Un evento `error` sin oyente es una excepción no capturada en Node, y
   * pg-boss los emite ante caídas de conexión y fallos de su mantenimiento
   * interno. Escucharlos no arregla el fallo, pero lo hace visible: sin esto
   * los jobs pueden estar muertos y los logs, limpios.
   */
  boss.on('error', (err: unknown) => {
    status.runtimeErrors += 1;
    recordError(err);
    logger.error({ err, runtimeErrors: status.runtimeErrors }, 'pg-boss: error en ejecución');
  });

  await boss.start();
  bossInstance = boss;

  await registerOrderExpirationJob(boss);
  await registerPaymentTimeoutJob(boss);
  await registerCleanupIdempotencyJob(boss);
  await registerCleanupSessionsJob(boss);
  await registerCleanupGuestBuyersJob(boss); // invitados sin pedidos
  await registerPurgeCollectionEvidenceJob(boss); // fotos base64 vencidas
  await registerValidateOrderJob(boss); // 2.BACK-2
  await registerAutoConfirmDeliveredJob(boss); // 3.BACK-6
  await registerPickupExpirationJob(boss); // 4.BACK-1
  await registerAtPickupExpirationJob(boss); // 4.BACK-1
  await registerWebhookSenderJob(boss); // 6.INFRA-3
  await registerDeliveryEmailJob(boss); // aviso de entrega al comprador
  await registerRecurrenceGeneratorJob(boss); // F3.B4.2.BACK-2
}

function scheduleRetry(): void {
  if (retryTimer) return;
  const delay = nextRetryDelay(status.failedAttempts);
  logger.warn(
    { delayMs: delay, failedAttempts: status.failedAttempts },
    'pg-boss: se reintentará el arranque de los jobs',
  );
  retryTimer = setTimeout(() => {
    retryTimer = null;
    // El fallo del reintento ya se registra dentro; aquí solo evita que un
    // rechazo suelto se convierta en unhandled rejection.
    void initMaintenanceJobs().catch(() => undefined);
  }, delay);
  // No debe impedir que el proceso termine si alguien lo cierra.
  retryTimer.unref?.();
}

export async function initMaintenanceJobs(): Promise<void> {
  if (env.NODE_ENV === 'test') {
    setState('disabled');
    return;
  }

  // Ya arrancado o arrancando: no se duplica.
  if (startPromise) return startPromise;

  setState('starting');

  startPromise = startBoss()
    .then(() => {
      status.failedAttempts = 0;
      setState('running');
      logger.info('Maintenance jobs initialized');
    })
    .catch((err: unknown) => {
      status.failedAttempts += 1;
      recordError(err);
      setState('failed');
      bossInstance = null;
      // Clave: se suelta la promesa memoizada. Antes quedaba un rechazo
      // cacheado y ningún intento posterior podía prosperar.
      startPromise = null;
      logger.error(
        { err, failedAttempts: status.failedAttempts },
        'pg-boss: fallo al arrancar los jobs de mantenimiento',
      );
      scheduleRetry();
      throw err;
    });

  return startPromise;
}

/** Instancia compartida. `null` mientras los jobs no estén en marcha. */
export function getMaintenanceBoss(): PgBoss | null {
  return bossInstance;
}

/** Estado para `/healthz/jobs` y para las pruebas. */
export function getMaintenanceJobsStatus(): Readonly<JobsStatus> {
  return { ...status };
}
