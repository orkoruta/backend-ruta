/**
 * at_pickup_expiration.job.ts
 *
 * Job que expira pedidos AT_PICKUP_POINT que superan el plazo de retiro.
 * Se ejecuta cada 5 minutos. Solo aplica a Clientes FULL activos.
 *
 * Parámetro: `pickup.expiration_hours` (fallback: 48h).
 * Transición: AT_PICKUP_POINT → PICKUP_EXPIRED → CLOSED (actor: SYSTEM, atómica).
 * Si payment_status = PAID: refund_status se marca como REFUND_PENDING.
 */

import type { PgBoss } from 'pg-boss';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { OrderStatus, PaymentStatus } from '@orkoruta/shared';
import { logger } from '../lib/logger.js';
import { assertTransition } from '../services/orders/state_machine.js';
import { resolveParamInt } from '../lib/parameter_resolver.js';

export const AT_PICKUP_EXPIRATION_JOB = 'at_pickup_expiration';
const CRON = '*/5 * * * *';

// Default fallback: 48h si no hay parámetro configurado en ningún nivel
const AT_PICKUP_EXPIRATION_DEFAULT_HOURS = 48;

export async function registerAtPickupExpirationJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(AT_PICKUP_EXPIRATION_JOB);
  await boss.schedule(AT_PICKUP_EXPIRATION_JOB, CRON);
  await boss.work(AT_PICKUP_EXPIRATION_JOB, async () => {
    await processAtPickupExpiration();
  });
  logger.info({ job: AT_PICKUP_EXPIRATION_JOB }, 'Job registered');
}

export async function processAtPickupExpiration(): Promise<void> {
  const clients = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findMany({
      where: { status: 'ACTIVE', id: { gt: 0n }, client_type: 'FULL' },
      select: { id: true },
    }),
  );

  for (const client of clients) {
    const clientId = Number(client.id);
    const expirationHours = await resolveParamInt(
      clientId,
      'pickup.expiration_hours',
      AT_PICKUP_EXPIRATION_DEFAULT_HOURS,
    );
    await expireAtPickupPointOrders(clientId, expirationHours * 60);
  }
}

export async function expireAtPickupPointOrders(
  clientId: number,
  expirationMinutes: number,
): Promise<void> {
  const threshold = new Date(Date.now() - expirationMinutes * 60 * 1000);

  const orders = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.orders.findMany({
      where: {
        client_id: BigInt(clientId),
        order_status: OrderStatus.AT_PICKUP_POINT,
        updated_at: { lt: threshold },
      },
      select: { id: true, payment_status: true },
    }),
  );

  if (orders.length === 0) return;

  logger.info({ clientId, count: orders.length }, 'AT_PICKUP_POINT orders ready to expire');

  for (const order of orders) {
    assertTransition(OrderStatus.AT_PICKUP_POINT, OrderStatus.PICKUP_EXPIRED, 'SYSTEM', {});
    assertTransition(OrderStatus.PICKUP_EXPIRED, OrderStatus.CLOSED, 'SYSTEM', {});

    const refundStatus =
      order.payment_status === PaymentStatus.PAID ? 'REFUND_PENDING' : 'REFUND_NOT_REQUIRED';

    await withTenant(clientId, 'ADMIN_RUTA', async (tx) => {
      const now = new Date();
      const expired = await tx.orders.updateMany({
        where: {
          id: order.id,
          client_id: BigInt(clientId),
          order_status: OrderStatus.AT_PICKUP_POINT,
        },
        data: { order_status: OrderStatus.PICKUP_EXPIRED, updated_at: now },
      });
      if (expired.count === 0) return;
      await tx.orders.updateMany({
        where: {
          id: order.id,
          client_id: BigInt(clientId),
          order_status: OrderStatus.PICKUP_EXPIRED,
        },
        data: {
          order_status: OrderStatus.CLOSED,
          closure_reason: 'PICKUP_EXPIRED',
          refund_status: refundStatus,
          closed_at: now,
          updated_at: now,
        },
      });
    });

    logger.info(
      { orderId: String(order.id), clientId, refundStatus },
      'AT_PICKUP_POINT order expired and closed by system',
    );
  }
}
