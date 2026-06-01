import type { PgBoss } from 'pg-boss';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { getParameterInt } from '../lib/parameter.js';
import { logger } from '../lib/logger.js';

export const CLEANUP_SESSIONS_JOB = 'cleanup_sessions';
// Daily at 03:00 UTC — low-traffic window
const CRON = '0 3 * * *';

export async function registerCleanupSessionsJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(CLEANUP_SESSIONS_JOB);
  await boss.schedule(CLEANUP_SESSIONS_JOB, CRON);
  await boss.work(CLEANUP_SESSIONS_JOB, async () => {
    await processCleanupSessions();
  });
  logger.info({ job: CLEANUP_SESSIONS_JOB }, 'Job registered');
}

export async function processCleanupSessions(): Promise<void> {
  // Sessions table is partitioned by client_id; iterate all clients including 0
  // (platform client for ADMIN_RUTA sessions).
  const clients = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    })
  );

  // Global parameters govern cleanup thresholds (not overrideable per client)
  const revokedDays = await getParameterInt(0, 'session.cleanup_after_revoked_days', 30);
  const expiredDays = await getParameterInt(0, 'session.cleanup_after_expired_days', 30);

  const revokedThreshold = daysAgo(revokedDays);
  const expiredThreshold = daysAgo(expiredDays);

  let totalDeleted = 0;

  for (const client of clients) {
    const clientId = Number(client.id);
    const deleted = await cleanClientSessions(clientId, revokedThreshold, expiredThreshold);
    totalDeleted += deleted;
  }

  if (totalDeleted > 0) {
    logger.info({ totalDeleted }, 'Sessions cleanup complete');
  }
}

export async function cleanClientSessions(
  clientId: number,
  revokedThreshold: Date,
  expiredThreshold: Date,
): Promise<number> {
  const { count } = await withTenant(clientId, 'ADMIN_RUTA', (tx) =>
    tx.sessions.deleteMany({
      where: {
        client_id: BigInt(clientId),
        OR: [
          // Explicitly revoked sessions old enough to purge
          { revoked_at: { not: null, lt: revokedThreshold } },
          // Long-expired sessions (not revoked) ready to purge
          { revoked_at: null, expires_at: { lt: expiredThreshold } },
        ],
      },
    })
  );

  if (count > 0) {
    logger.debug({ clientId, deleted: count }, 'Sessions purged');
  }

  return count;
}

export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
