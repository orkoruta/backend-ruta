import type { PgBoss } from 'pg-boss';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { logger } from '../middleware/logger.js';

export const CLEANUP_IDEMPOTENCY_JOB = 'cleanup_idempotency';
// Hourly: idempotency_keys carry their expires_at at creation, so hourly cleanup suffices.
const CRON = '0 * * * *';

export async function registerCleanupIdempotencyJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(CLEANUP_IDEMPOTENCY_JOB);
  await boss.schedule(CLEANUP_IDEMPOTENCY_JOB, CRON);
  await boss.work(CLEANUP_IDEMPOTENCY_JOB, async () => {
    await processCleanupIdempotency();
  });
  logger.info({ job: CLEANUP_IDEMPOTENCY_JOB }, 'Job registered');
}

export async function processCleanupIdempotency(): Promise<void> {
  // idempotency_keys is partitioned by client_id; iterate all clients (including 0
  // for ADMIN_RUTA platform keys).
  const clients = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    })
  );

  const now = new Date();
  let totalDeleted = 0;

  for (const client of clients) {
    const clientId = Number(client.id);
    const { count } = await withTenant(clientId, 'ADMIN_RUTA', (tx) =>
      tx.idempotency_keys.deleteMany({
        where: {
          client_id: BigInt(clientId),
          expires_at: { lt: now },
        },
      })
    );
    if (count > 0) {
      totalDeleted += count;
      logger.debug({ clientId, deleted: count }, 'Idempotency keys purged');
    }
  }

  if (totalDeleted > 0) {
    logger.info({ totalDeleted }, 'Idempotency keys cleanup complete');
  }
}
