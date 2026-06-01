import type { PgBoss } from 'pg-boss';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { OrderStatus } from '@orkoruta/shared';
import { assertTransition } from '../services/orders/state_machine.js';
import { getParameterInt } from '../lib/parameter.js';
import { logger } from '../middleware/logger.js';

export const ORDER_EXPIRATION_JOB = 'order_expiration';
const CRON = '*/5 * * * *';

async function expireAndCloseOrder(
  clientId: number,
  orderId: bigint,
  fromStatus: OrderStatus,
  closureReason: string,
): Promise<void> {
  assertTransition(fromStatus, OrderStatus.EXPIRED, 'SYSTEM', {});
  assertTransition(OrderStatus.EXPIRED, OrderStatus.CLOSED, 'SYSTEM', {});

  await withTenant(clientId, 'ADMIN_RUTA', async (tx) => {
    const now = new Date();
    const expired = await tx.orders.updateMany({
      where: { id: orderId, client_id: BigInt(clientId), order_status: fromStatus },
      data: { order_status: OrderStatus.EXPIRED, updated_at: now },
    });

    if (expired.count === 0) return;

    await tx.orders.updateMany({
      where: { id: orderId, client_id: BigInt(clientId), order_status: OrderStatus.EXPIRED },
      data: {
        order_status: OrderStatus.CLOSED,
        closure_reason: closureReason,
        refund_status: 'REFUND_NOT_REQUIRED',
        closed_at: now,
        updated_at: now,
      },
    });
  });
}

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
    await expireAndCloseOrder(clientId, order.id, OrderStatus.DRAFT, 'EXPIRED');
    logger.info({ orderId: String(order.id), clientId }, 'DRAFT order expired and closed by system');
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
    await expireAndCloseOrder(clientId, order.id, OrderStatus.PENDING_CONFIRM, 'EXPIRED');
    logger.info({ orderId: String(order.id), clientId }, 'PENDING_CONFIRM order expired and closed by system');
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
