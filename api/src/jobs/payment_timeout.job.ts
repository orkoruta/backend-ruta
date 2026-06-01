import type { PgBoss } from 'pg-boss';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { OrderStatus } from '@orkoruta/shared';
import { assertTransition } from '../services/orders/state_machine.js';
import { getParameterInt } from '../lib/parameter.js';
import { logger } from '../middleware/logger.js';

export const PAYMENT_TIMEOUT_JOB = 'payment_timeout';
const CRON = '*/2 * * * *';

export async function registerPaymentTimeoutJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(PAYMENT_TIMEOUT_JOB);
  await boss.schedule(PAYMENT_TIMEOUT_JOB, CRON);
  await boss.work(PAYMENT_TIMEOUT_JOB, async () => {
    await processPaymentTimeout();
  });
  logger.info({ job: PAYMENT_TIMEOUT_JOB }, 'Job registered');
}

export async function processPaymentTimeout(): Promise<void> {
  // Payment online only applies to FULL clients (Flujo 1, Bloque 3)
  const clients = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findMany({
      where: { status: 'ACTIVE', id: { gt: 0n }, client_type: 'FULL' },
      select: { id: true },
    })
  );

  for (const client of clients) {
    const clientId = Number(client.id);
    const timeoutMinutes = await resolveParamInt(
      clientId,
      'order.pending_online_payment_timeout_minutes',
      15,
    );
    await timeoutPendingPayments(clientId, timeoutMinutes);
  }
}

export async function timeoutPendingPayments(
  clientId: number,
  timeoutMinutes: number,
): Promise<void> {
  // submitted_at is set when order moves to ORDER_SUBMITTED (Flujo 1, Bloque 3-1)
  const threshold = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  const timedOutOrders = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.orders.findMany({
      where: {
        client_id: BigInt(clientId),
        order_status: OrderStatus.ORDER_SUBMITTED,
        payment_status: 'PENDING_ONLINE_PAYMENT',
        submitted_at: { lt: threshold, not: null },
      },
      select: { id: true },
    })
  );

  if (timedOutOrders.length === 0) return;

  logger.info(
    { clientId, count: timedOutOrders.length },
    'Orders with PENDING_ONLINE_PAYMENT timed out',
  );

  for (const order of timedOutOrders) {
    assertTransition(OrderStatus.ORDER_SUBMITTED, OrderStatus.EXPIRED, 'SYSTEM', {});
    assertTransition(OrderStatus.EXPIRED, OrderStatus.CLOSED, 'SYSTEM', {});
    await withTenant(clientId, 'ADMIN_RUTA', async (tx) => {
      const now = new Date();
      const expired = await tx.orders.updateMany({
        where: { id: order.id, client_id: BigInt(clientId), order_status: OrderStatus.ORDER_SUBMITTED },
        data: { order_status: OrderStatus.EXPIRED, updated_at: now },
      });

      if (expired.count === 0) return;

      await tx.orders.updateMany({
        where: { id: order.id, client_id: BigInt(clientId), order_status: OrderStatus.EXPIRED },
        data: {
          order_status: OrderStatus.CLOSED,
          closure_reason: 'PAYMENT_TIMEOUT',
          refund_status: 'REFUND_NOT_REQUIRED',
          closed_at: now,
          updated_at: now,
        },
      });
    });
    logger.info({ orderId: String(order.id), clientId }, 'Payment timed out, order expired and closed by system');
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
