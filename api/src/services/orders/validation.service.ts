import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { OrderStatus } from '@orkoruta/shared';
import { HttpError } from '../../lib/http_error.js';
import { getParameterInt } from '../../lib/parameter.js';
import { assertTransition } from './state_machine.js';
import { logger } from '../../middleware/logger.js';

export type ValidationOutcome = 'VALIDATION_APPROVED' | 'MANUAL_REVIEW';

export async function determineValidationOutcome(
  orderId: number,
  clientId: number,
): Promise<ValidationOutcome> {
  // Require manual review if the client has set the override parameter
  const forceManual = await getParameterInt(clientId, 'order.force_manual_review', 0);
  if (forceManual === 1) return 'MANUAL_REVIEW';

  const order = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.orders.findUnique({
      where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
      select: {
        order_status: true,
        order_items: { select: { product_id: true } },
      },
    }),
  );

  if (!order) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

  if (order.order_status !== OrderStatus.ORDER_VALIDATING) {
    throw new HttpError(
      422,
      'INVALID_STATE_TRANSITION',
      `El pedido debe estar en ORDER_VALIDATING, está en ${order.order_status}`,
    );
  }

  // Any inactive product sends the order to manual review
  const productIds = order.order_items
    .map((i) => i.product_id)
    .filter((id): id is bigint => id !== null);

  if (productIds.length > 0) {
    const activeCount = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
      tx.products.count({
        where: { id: { in: productIds }, status: 'ACTIVE' },
      }),
    );
    if (activeCount < productIds.length) return 'MANUAL_REVIEW';
  }

  return 'VALIDATION_APPROVED';
}

export async function processOrderValidation(
  orderId: number,
  clientId: number,
): Promise<ValidationOutcome> {
  const outcome = await determineValidationOutcome(orderId, clientId);
  const targetStatus =
    outcome === 'VALIDATION_APPROVED' ? OrderStatus.VALIDATION_APPROVED : OrderStatus.MANUAL_REVIEW;

  await withTenant(clientId, 'ADMIN_RUTA', async (tx) => {
    const order = await tx.orders.findUnique({
      where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
      select: { order_status: true },
    });
    if (!order) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

    assertTransition(order.order_status as OrderStatus, targetStatus, 'SYSTEM');

    await tx.orders.update({
      where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
      data: { order_status: targetStatus, updated_at: new Date() },
    });
  });

  logger.info({ orderId, clientId, outcome }, 'Order validation completed');
  return outcome;
}

export const validationService = { processOrderValidation, determineValidationOutcome };
