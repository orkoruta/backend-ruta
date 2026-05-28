import type { PgBoss } from 'pg-boss';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { OrderStatus, PaymentStatus } from '@orkoruta/shared';
import { assertTransition } from '../services/orders/state_machine.js';
import { processOrderValidation } from '../services/orders/validation.service.js';
import { logger } from '../middleware/logger.js';

export const VALIDATE_ORDER_JOB = 'validate_order';
const CRON = '*/1 * * * *';

export async function registerValidateOrderJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(VALIDATE_ORDER_JOB);
  await boss.schedule(VALIDATE_ORDER_JOB, CRON);
  await boss.work(VALIDATE_ORDER_JOB, async () => {
    await processValidateOrders();
  });
  logger.info({ job: VALIDATE_ORDER_JOB }, 'Job registered');
}

export async function processValidateOrders(): Promise<void> {
  // Flujo 1 (creación) only applies to FULL clients
  const clients = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findMany({
      where: { status: 'ACTIVE', id: { gt: 0n }, client_type: 'FULL' },
      select: { id: true },
    }),
  );

  for (const client of clients) {
    await validateOrdersForClient(Number(client.id));
  }
}

export async function validateOrdersForClient(clientId: number): Promise<void> {
  // Orders ready for validation:
  // - COD orders (payment_status PENDING_COLLECTION): no online payment needed
  // - Online orders with confirmed payment (payment_status PAID)
  const pendingOrders = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.orders.findMany({
      where: {
        client_id: BigInt(clientId),
        order_status: OrderStatus.ORDER_SUBMITTED,
        OR: [
          { payment_status: PaymentStatus.PENDING_COLLECTION },
          { payment_status: PaymentStatus.PAID },
        ],
      },
      select: { id: true },
    }),
  );

  if (pendingOrders.length === 0) return;

  logger.info({ clientId, count: pendingOrders.length }, 'Orders ready for validation');

  for (const order of pendingOrders) {
    const orderId = Number(order.id);
    try {
      // Transition ORDER_SUBMITTED → ORDER_VALIDATING (re-check to avoid race conditions)
      await withTenant(clientId, 'ADMIN_RUTA', async (tx) => {
        const current = await tx.orders.findUnique({
          where: { id_client_id: { id: order.id, client_id: BigInt(clientId) } },
          select: { order_status: true },
        });
        if (!current || current.order_status !== OrderStatus.ORDER_SUBMITTED) return;

        assertTransition(current.order_status as OrderStatus, OrderStatus.ORDER_VALIDATING, 'SYSTEM');

        await tx.orders.update({
          where: { id_client_id: { id: order.id, client_id: BigInt(clientId) } },
          data: { order_status: OrderStatus.ORDER_VALIDATING, updated_at: new Date() },
        });
      });

      await processOrderValidation(orderId, clientId);
    } catch (err) {
      logger.error({ orderId, clientId, err }, 'Failed to validate order');
    }
  }
}
