import type { PgBoss } from 'pg-boss';
import { withTenantReadOnly } from '@orkoruta/db';
import { getParameterInt } from '../lib/parameter.js';
import { logger } from '../middleware/logger.js';

export const ORDER_EXPIRATION_JOB = 'order_expiration';
const CRON = '*/5 * * * *';

export async function registerOrderExpirationJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(ORDER_EXPIRATION_JOB);
  await boss.schedule(ORDER_EXPIRATION_JOB, CRON);
  await boss.work(ORDER_EXPIRATION_JOB, async () => {
    await processOrderExpiration();
  });
  logger.info({ job: ORDER_EXPIRATION_JOB }, 'Job registered');
}

export async function processOrderExpiration(): Promise<void> {
  // Flujo 1 (creación) only applies to FULL clients
  const clients = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findMany({
      where: { status: 'ACTIVE', id: { gt: 0n }, client_type: 'FULL' },
      select: { id: true },
    })
  );

  for (const client of clients) {
    const clientId = Number(client.id);
    const draftMinutes = await resolveParamInt(clientId, 'order.draft_expiration_minutes', 1440);
    const pendingConfirmMinutes = await resolveParamInt(
      clientId,
      'order.pending_confirm_timeout_minutes',
      60,
    );
    await expireDraftOrders(clientId, draftMinutes);
    await expirePendingConfirmOrders(clientId, pendingConfirmMinutes);
  }
}

export async function expireDraftOrders(clientId: number, draftMinutes: number): Promise<void> {
  const threshold = new Date(Date.now() - draftMinutes * 60 * 1000);

  const expiredOrders = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.orders.findMany({
      where: {
        client_id: BigInt(clientId),
        order_status: 'DRAFT',
        created_at: { lt: threshold },
      },
      select: { id: true },
    })
  );

  if (expiredOrders.length === 0) return;

  logger.info({ clientId, count: expiredOrders.length }, 'DRAFT orders ready to expire');

  for (const order of expiredOrders) {
    // TODO 2.BACK-1: uncomment when api/src/services/orders/state_machine.ts is merged
    // from feat/back-2-1. Replace this block with:
    //   await stateMachine.transition(order.id, clientId, { type: 'EXPIRE', actor: 'SYSTEM' });
    logger.warn(
      { orderId: String(order.id), clientId },
      'DRAFT order expired — awaiting state_machine (2.BACK-1)',
    );
  }
}

export async function expirePendingConfirmOrders(
  clientId: number,
  pendingConfirmMinutes: number,
): Promise<void> {
  // updated_at tracks when the order last changed state (entered PENDING_CONFIRM)
  const threshold = new Date(Date.now() - pendingConfirmMinutes * 60 * 1000);

  const expiredOrders = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.orders.findMany({
      where: {
        client_id: BigInt(clientId),
        order_status: 'PENDING_CONFIRM',
        updated_at: { lt: threshold },
      },
      select: { id: true },
    })
  );

  if (expiredOrders.length === 0) return;

  logger.info({ clientId, count: expiredOrders.length }, 'PENDING_CONFIRM orders ready to expire');

  for (const order of expiredOrders) {
    // TODO 2.BACK-1: uncomment when api/src/services/orders/state_machine.ts is merged
    // from feat/back-2-1. Replace this block with:
    //   await stateMachine.transition(order.id, clientId, { type: 'EXPIRE', actor: 'SYSTEM' });
    logger.warn(
      { orderId: String(order.id), clientId },
      'PENDING_CONFIRM order expired — awaiting state_machine (2.BACK-1)',
    );
  }
}

// Looks up client-specific param first, then falls back to global (client_id=0) default.
export async function resolveParamInt(
  clientId: number,
  key: string,
  hardFallback: number,
): Promise<number> {
  const specific = await getParameterInt(clientId, key, 0);
  if (specific > 0) return specific;
  return getParameterInt(0, key, hardFallback);
}
