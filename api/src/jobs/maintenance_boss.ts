import { PgBoss } from 'pg-boss';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { registerOrderExpirationJob } from './order_expiration.job.js';
import { registerPaymentTimeoutJob } from './payment_timeout.job.js';
import { registerCleanupIdempotencyJob } from './cleanup_idempotency.job.js';
import { registerCleanupSessionsJob } from './cleanup_sessions.job.js';
import { registerValidateOrderJob } from './validate_order.job.js'; // 2.BACK-2
import { registerAutoConfirmDeliveredJob } from './auto_confirm_delivered.job.js'; // 3.BACK-6
import { registerPickupExpirationJob } from './pickup_expiration.job.js'; // 4.BACK-1
import { registerAtPickupExpirationJob } from './at_pickup_expiration.job.js'; // 4.BACK-1
import { registerWebhookSenderJob } from './webhook_sender.job.js'; // 6.INFRA-3

let bossInstance: PgBoss | null = null;
let initPromise: Promise<void> | null = null;

export async function initMaintenanceJobs(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (env.NODE_ENV === 'test') return;

    const boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await boss.start();
    bossInstance = boss;

    await registerOrderExpirationJob(boss);
    await registerPaymentTimeoutJob(boss);
    await registerCleanupIdempotencyJob(boss);
    await registerCleanupSessionsJob(boss);
    await registerValidateOrderJob(boss); // 2.BACK-2
    await registerAutoConfirmDeliveredJob(boss); // 3.BACK-6
    await registerPickupExpirationJob(boss); // 4.BACK-1
    await registerAtPickupExpirationJob(boss); // 4.BACK-1
    await registerWebhookSenderJob(boss); // 6.INFRA-3

    logger.info('Maintenance jobs initialized');
  })();

  return initPromise;
}

/** Returns the shared pg-boss instance (only available after initMaintenanceJobs resolves). */
export function getMaintenanceBoss(): PgBoss | null {
  return bossInstance;
}
