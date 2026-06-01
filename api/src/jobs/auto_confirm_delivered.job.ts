import type { PgBoss } from 'pg-boss';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { OrderStatus } from '@orkoruta/shared';
import { logger } from '../lib/logger.js';
import { assertTransition } from '../services/orders/state_machine.js';
import { resolveParamInt } from './order_expiration.job.js';

export const AUTO_CONFIRM_DELIVERED_JOB = 'auto_confirm_delivered';
const CRON = '0 * * * *';

export async function registerAutoConfirmDeliveredJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(AUTO_CONFIRM_DELIVERED_JOB);
  await boss.schedule(AUTO_CONFIRM_DELIVERED_JOB, CRON);
  await boss.work(AUTO_CONFIRM_DELIVERED_JOB, async () => {
    await processAutoConfirmDelivered();
  });
  logger.info({ job: AUTO_CONFIRM_DELIVERED_JOB }, 'Job registered');
}

export async function processAutoConfirmDelivered(): Promise<void> {
  const clients = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findMany({
      where: { status: 'ACTIVE', id: { gt: 0n }, client_type: 'FULL' },
      select: { id: true },
    })
  );

  for (const client of clients) {
    const clientId = Number(client.id);
    const hours = await resolveParamInt(clientId, 'closure.auto_confirm_delivered_hours', 72);
    await autoConfirmDeliveredOrders(clientId, hours);
  }
}

export async function autoConfirmDeliveredOrders(clientId: number, hours: number): Promise<void> {
  const threshold = new Date(Date.now() - hours * 60 * 60 * 1000);

  const orders = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.orders.findMany({
      where: {
        client_id: BigInt(clientId),
        order_status: OrderStatus.DELIVERED,
        updated_at: { lt: threshold },
      },
      select: { id: true },
    })
  );

  if (orders.length === 0) return;

  logger.info({ clientId, count: orders.length }, 'DELIVERED orders ready to auto-confirm');

  for (const order of orders) {
    assertTransition(OrderStatus.DELIVERED, OrderStatus.CONFIRMED_BY_SYSTEM, 'SYSTEM', {});
    assertTransition(OrderStatus.CONFIRMED_BY_SYSTEM, OrderStatus.COMPLETED_SUCCESSFULLY, 'SYSTEM', {});
    assertTransition(OrderStatus.COMPLETED_SUCCESSFULLY, OrderStatus.CLOSED, 'SYSTEM', {});
    await withTenant(clientId, 'ADMIN_RUTA', async (tx) => {
      const now = new Date();
      const confirmed = await tx.orders.updateMany({
        where: { id: order.id, client_id: BigInt(clientId), order_status: OrderStatus.DELIVERED },
        data: { order_status: OrderStatus.CONFIRMED_BY_SYSTEM, updated_at: now },
      });
      if (confirmed.count === 0) return;
      await tx.orders.updateMany({
        where: { id: order.id, client_id: BigInt(clientId), order_status: OrderStatus.CONFIRMED_BY_SYSTEM },
        data: { order_status: OrderStatus.COMPLETED_SUCCESSFULLY, updated_at: now },
      });
      await tx.orders.updateMany({
        where: { id: order.id, client_id: BigInt(clientId), order_status: OrderStatus.COMPLETED_SUCCESSFULLY },
        data: {
          order_status: OrderStatus.CLOSED,
          closure_reason: 'COMPLETED_SUCCESSFULLY',
          closed_at: now,
          updated_at: now,
        },
      });
    });
    logger.info({ orderId: String(order.id), clientId }, 'Order auto-confirmed and closed by system');
  }
}
