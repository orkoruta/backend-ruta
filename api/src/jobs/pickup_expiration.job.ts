/**
 * pickup_expiration.job.ts — 4.BACK-1
 *
 * Job que expira pedidos READY_FOR_PICKUP que superan el plazo configurado.
 * Se ejecuta cada 5 minutos. Solo aplica a Clientes FULL activos.
 *
 * Parámetro: `order.pickup_expiration_minutes` (fallback: 1440 min = 24h).
 * Transición: READY_FOR_PICKUP → EXPIRED (actor: SYSTEM).
 */

import type { PgBoss } from 'pg-boss';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { OrderStatus } from '@orkoruta/shared';
import { logger } from '../middleware/logger.js';
import { assertTransition } from '../services/orders/state_machine.js';
import { resolveParamInt } from './order_expiration.job.js';

export const PICKUP_EXPIRATION_JOB = 'pickup_expiration';
const CRON = '*/5 * * * *';

// Default fallback (24h) si no hay parámetro configurado en ningún nivel
const PICKUP_EXPIRATION_DEFAULT_MINUTES = 1440;

export async function registerPickupExpirationJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(PICKUP_EXPIRATION_JOB);
  await boss.schedule(PICKUP_EXPIRATION_JOB, CRON);
  await boss.work(PICKUP_EXPIRATION_JOB, async () => {
    await processPickupExpiration();
  });
  logger.info({ job: PICKUP_EXPIRATION_JOB }, 'Job registered');
}

export async function processPickupExpiration(): Promise<void> {
  // Pickup flow only applies to FULL clients
  const clients = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findMany({
      where: { status: 'ACTIVE', id: { gt: 0n }, client_type: 'FULL' },
      select: { id: true },
    }),
  );

  for (const client of clients) {
    const clientId = Number(client.id);
    const expirationMinutes = await resolveParamInt(
      clientId,
      'order.pickup_expiration_minutes',
      PICKUP_EXPIRATION_DEFAULT_MINUTES,
    );
    await expireReadyForPickupOrders(clientId, expirationMinutes);
  }
}

export async function expireReadyForPickupOrders(
  clientId: number,
  expirationMinutes: number,
): Promise<void> {
  const threshold = new Date(Date.now() - expirationMinutes * 60 * 1000);

  const orders = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.orders.findMany({
      where: {
        client_id: BigInt(clientId),
        order_status: OrderStatus.READY_FOR_PICKUP,
        updated_at: { lt: threshold },
      },
      select: { id: true },
    }),
  );

  if (orders.length === 0) return;

  logger.info({ clientId, count: orders.length }, 'READY_FOR_PICKUP orders ready to expire');

  for (const order of orders) {
    assertTransition(OrderStatus.READY_FOR_PICKUP, OrderStatus.EXPIRED, 'SYSTEM', {});
    await withTenant(clientId, 'ADMIN_RUTA', (tx) =>
      tx.orders.updateMany({
        where: { id: order.id, client_id: BigInt(clientId) },
        data: {
          order_status: OrderStatus.EXPIRED,
          updated_at: new Date(),
        },
      }),
    );
    logger.info(
      { orderId: String(order.id), clientId },
      'READY_FOR_PICKUP order expired by system',
    );
  }
}
