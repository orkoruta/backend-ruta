import type { PgBoss } from 'pg-boss';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { getParameterInt } from '../lib/parameter.js';
import { logger } from '../lib/logger.js';

/**
 * Borra las fotos de recibo guardadas en base64 pasada su vigencia.
 *
 * Mientras no haya object storage, la evidencia del cobro contra entrega vive
 * dentro del JSONB `payments.collection_evidence` como data URI. Son cientos de
 * kB por pago dentro de Postgres, así que **no se guardan para siempre**: a los
 * N días se purgan.
 *
 * **No se borra la fila ni se pone a `null`.** Se deja una marca
 * (`{ purged_at, had_evidence: true }`) para poder distinguir «este cobro nunca
 * tuvo foto» de «la tuvo y expiró». Sin esa distinción, un pago antiguo
 * parecería no haber tenido nunca respaldo, que es justo lo contrario de lo que
 * pasó.
 *
 * `payments` no está en la lista de tablas append-only (regla 4.4), así que el
 * UPDATE aquí es legítimo.
 */

export const PURGE_COLLECTION_EVIDENCE_JOB = 'purge_collection_evidence';

/** Diario de madrugada: no hay prisa y la ventana está tranquila. */
const CRON = '30 3 * * *';

const RETENTION_PARAM = 'storage.evidence_retention_days';
const DEFAULT_RETENTION_DAYS = 14;

/** Forma de la evidencia guardada. `url` puede ser data URI o URL http(s). */
type StoredEvidence = {
  url?: string;
  notes?: string;
  purged_at?: string;
  had_evidence?: boolean;
} | null;

/** Solo se purga lo que pesa: un data URI. Una URL http(s) no ocupa nada. */
function isDataUri(url: string | undefined): boolean {
  return Boolean(url?.startsWith('data:'));
}

export async function registerPurgeCollectionEvidenceJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(PURGE_COLLECTION_EVIDENCE_JOB);
  await boss.schedule(PURGE_COLLECTION_EVIDENCE_JOB, CRON);
  await boss.work(PURGE_COLLECTION_EVIDENCE_JOB, async () => {
    await processPurgeCollectionEvidence();
  });
  logger.info({ job: PURGE_COLLECTION_EVIDENCE_JOB }, 'Job registered');
}

export async function processPurgeCollectionEvidence(): Promise<void> {
  const clients = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findMany({
      where: { status: 'ACTIVE', id: { gt: 0n } },
      select: { id: true },
    }),
  );

  for (const client of clients) {
    const clientId = Number(client.id);
    try {
      await purgeClientEvidence(clientId);
    } catch (err) {
      logger.error({ err, clientId }, 'purge_collection_evidence: fallo en el cliente');
    }
  }
}

async function purgeClientEvidence(clientId: number): Promise<void> {
  const days = await getParameterInt(clientId, RETENTION_PARAM, 0)
    || await getParameterInt(0, RETENTION_PARAM, DEFAULT_RETENTION_DAYS);

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const candidates = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
    tx.payments.findMany({
      where: {
        client_id: BigInt(clientId),
        collected_at: { lt: cutoff, not: null },
        // Prisma no admite `not: null` sobre una columna Json, así que el
        // descarte de los pagos sin evidencia se hace en memoria, justo debajo.
      },
      select: { id: true, collection_evidence: true, collected_at: true },
      take: 500,
    }),
  );

  // Se purga solo lo que pesa: un data URI. Los pagos sin evidencia y los que
  // ya guardan una URL http(s) se descartan aquí.
  const toPurge = candidates.filter((p) => isDataUri((p.collection_evidence as StoredEvidence)?.url));
  if (toPurge.length === 0) return;

  let purged = 0;
  const now = new Date();

  for (const payment of toPurge) {
    const previous = (payment.collection_evidence ?? {}) as StoredEvidence;
    try {
      await withTenant(clientId, 'ADMIN_CLIENT', (tx) =>
        tx.payments.update({
          where: { id_client_id: { id: payment.id, client_id: BigInt(clientId) } },
          data: {
            collection_evidence: {
              // Las notas se conservan: pesan nada y son el único contexto que
              // queda del cobro una vez se va la foto.
              ...(previous?.notes ? { notes: previous.notes } : {}),
              had_evidence: true,
              purged_at: now.toISOString(),
            },
            updated_at: now,
          },
        }),
      );
      purged += 1;
    } catch (err) {
      logger.warn(
        { err, clientId, paymentId: String(payment.id) },
        'purge_collection_evidence: no se pudo purgar el pago, se omite',
      );
    }
  }

  logger.info(
    { clientId, purged, retentionDays: days },
    'purge_collection_evidence: evidencias en base64 purgadas',
  );
}
