import { PgBoss } from 'pg-boss';
import { env } from '../config/env.js';
import { logger } from '../middleware/logger.js';
import { registerOrderExpirationJob } from './order_expiration.job.js';
import { registerPaymentTimeoutJob } from './payment_timeout.job.js';
import { registerCleanupIdempotencyJob } from './cleanup_idempotency.job.js';
import { registerCleanupSessionsJob } from './cleanup_sessions.job.js';
import { registerValidateOrderJob } from './validate_order.job.js'; // 2.BACK-2
import { registerAutoConfirmDeliveredJob } from './auto_confirm_delivered.job.js'; // 3.BACK-6

let initPromise: Promise<void> | null = null;

export async function initMaintenanceJobs(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (env.NODE_ENV === 'test') return;

    const boss = new PgBoss(env.DATABASE_URL);
    await boss.start();

    await registerOrderExpirationJob(boss);
    await registerPaymentTimeoutJob(boss);
    await registerCleanupIdempotencyJob(boss);
    await registerCleanupSessionsJob(boss);
    await registerValidateOrderJob(boss); // 2.BACK-2
    await registerAutoConfirmDeliveredJob(boss); // 3.BACK-6

    logger.info('Maintenance jobs initialized');
  })();

  return initPromise;
}
