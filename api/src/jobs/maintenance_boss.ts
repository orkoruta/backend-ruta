import { PgBoss } from 'pg-boss';
import { env } from '../config/env.js';
import { logger } from '../middleware/logger.js';
import { registerOrderExpirationJob } from './order_expiration.job.js';
import { registerPaymentTimeoutJob } from './payment_timeout.job.js';
import { registerCleanupIdempotencyJob } from './cleanup_idempotency.job.js';
import { registerCleanupSessionsJob } from './cleanup_sessions.job.js';

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

    logger.info('Maintenance jobs initialized');
  })();

  return initPromise;
}
