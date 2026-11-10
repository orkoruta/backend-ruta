/**
 * Entrega registrada por el staff del Cliente.
 *
 * Hay negocios en los que el dueño o un operador entrega algunos pedidos él
 * mismo. Hasta ahora solo el repartidor asignado podía marcar un pedido como
 * entregado, así que esos pedidos se quedaban «en camino» para siempre o el
 * Cliente tenía que inventarse una cuenta de repartidor.
 *
 * Qué hace, en una sola transacción:
 *   1. Si el pedido es contra entrega y el cobro aún no está registrado, lo
 *      registra (fila en `payments`, `payment_status = PAYMENT_COLLECTED`). El
 *      cobro queda **sin repartidor** (`collected_by_courier_user_id = NULL`):
 *      el dinero lo tiene el Cliente, no un repartidor, y así no aparece en lo
 *      que se le cuadra a nadie al final de la semana.
 *   2. Pasa el pedido a DELIVERED por el state machine
 *      (`ADMIN_DIRECT_DELIVERY_FROM`), que exige el cobro registrado.
 *   3. Audita la acción.
 *
 * RUTA no custodia dinero (regla 4.1): esto solo registra que el Cliente cobró.
 */

import { z } from 'zod';
import { withTenant } from '@orkoruta/db';
import { OrderStatus, PaymentStatus } from '@orkoruta/shared';
import { HttpError } from '../../lib/http_error.js';
import { logger } from '../../lib/logger.js';
import { getMaintenanceBoss } from '../../jobs/maintenance_boss.js';
import { processWebhookEvent } from '../webhooks_outgoing.service.js';
import { deliveryEmailService } from '../notifications/delivery_email.service.js';
import { ADMIN_DIRECT_DELIVERY_FROM, assertTransition, type TransitionActor } from './state_machine.js';
import type { AuthenticatedUser } from '../../middleware/auth.js';

export const staffMarkDeliveredSchema = z.object({
  /** Lo cobrado. Si no se manda, se toma el total del pedido. */
  collected_amount: z.number().min(0).optional(),
  /** Cómo pagó el comprador al recibir. Solo importa en contra entrega. */
  collection_method: z.enum(['CASH', 'ELECTRONIC']).default('CASH'),
  notes: z.string().trim().max(500).optional(),
});

export type StaffMarkDeliveredInput = z.infer<typeof staffMarkDeliveredSchema>;

function toTransitionActor(userType: string): TransitionActor {
  if (userType === 'ADMIN_RUTA') return 'ADMIN_RUTA';
  if (userType === 'OPERATOR_CLIENT') return 'OPERATOR_CLIENT';
  return 'ADMIN_CLIENT';
}

function emitDelivered(clientId: number, orderId: number, deliveredAt: Date): void {
  const boss = getMaintenanceBoss();
  if (!boss) return;

  const payload = {
    event_type: 'ORDER_DELIVERED',
    client_id: clientId,
    order_id: orderId,
    timestamp: new Date().toISOString(),
    data: {
      order_status: OrderStatus.DELIVERED,
      delivery_type: 'SHIP',
      courier_user_id: null,
      delivered_by: 'CLIENT_STAFF',
      delivered_at: deliveredAt.toISOString(),
    },
  };

  setImmediate(() => {
    processWebhookEvent('ORDER_DELIVERED', payload, clientId, boss).catch((err: unknown) => {
      logger.warn({ err, clientId, orderId }, 'staff_delivery: error emitiendo webhook');
    });
    deliveryEmailService
      .queueDeliveryEmail(clientId, orderId, boss)
      .catch((err: unknown) =>
        logger.warn({ err, clientId, orderId }, 'delivery_email: no se pudo encolar'),
      );
  });
}

export const staffDeliveryService = {
  async markDelivered(
    clientId: number,
    orderId: number,
    actor: AuthenticatedUser,
    input: StaffMarkDeliveredInput,
  ) {
    const transitionActor = toTransitionActor(actor.user_type);
    const key = { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } };

    const result = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const order = await tx.orders.findUnique({
        where: key,
        select: {
          id: true,
          order_status: true,
          payment_status: true,
          payment_method: true,
          delivery_type: true,
          total: true,
          currency: true,
          version: true,
        },
      });
      if (!order) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

      const currentStatus = order.order_status as OrderStatus;

      if (order.delivery_type !== 'SHIP') {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          'Los pedidos de recogida se entregan desde el flujo del punto físico',
        );
      }
      if (!ADMIN_DIRECT_DELIVERY_FROM.includes(currentStatus)) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          'Este pedido no se puede marcar como entregado en su estado actual',
          { order_status: currentStatus },
        );
      }
      if (order.payment_status === PaymentStatus.PENDING_ONLINE_PAYMENT) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          'El pago en línea de este pedido aún no está confirmado',
          { payment_status: order.payment_status },
        );
      }

      const now = new Date();
      let paymentStatus = order.payment_status;
      let collectedAmount: number | null = null;

      // Contra entrega sin cobro registrado: se registra ahora.
      if (paymentStatus === PaymentStatus.PENDING_COLLECTION) {
        collectedAmount = input.collected_amount ?? Number(order.total);
        await tx.payments.create({
          data: {
            client_id: BigInt(clientId),
            order_id: BigInt(orderId),
            payment_method: order.payment_method,
            amount: collectedAmount,
            currency: order.currency,
            status: 'CONFIRMED',
            collected_by_courier_user_id: null,
            collected_at: now,
            collection_evidence: {
              collected_by: 'CLIENT_STAFF',
              staff_user_id: actor.id,
              method: input.collection_method,
              ...(input.notes ? { notes: input.notes } : {}),
            },
          },
        });
        paymentStatus = PaymentStatus.PAYMENT_COLLECTED;
      }

      assertTransition(currentStatus, OrderStatus.DELIVERED, transitionActor, {
        deliveryType: order.delivery_type,
        paymentStatus,
      });

      const updated = await tx.orders.updateMany({
        where: { id: BigInt(orderId), client_id: BigInt(clientId), version: order.version },
        data: {
          order_status: OrderStatus.DELIVERED,
          payment_status: paymentStatus,
          delivered_at: now,
          updated_at: now,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new HttpError(
          409,
          'OPTIMISTIC_LOCK_FAILED',
          'El pedido cambió mientras lo marcabas. Recarga e inténtalo de nuevo.',
        );
      }

      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actor.id),
          actor_type: 'USER',
          actor_role: actor.user_type,
          action: 'ORDER_DELIVERED_BY_STAFF',
          entity_type: 'order',
          entity_id: BigInt(orderId),
          result: 'SUCCESS',
          metadata: {
            from_status: currentStatus,
            collected_amount: collectedAmount,
            collection_method: collectedAmount !== null ? input.collection_method : null,
            notes: input.notes ?? null,
          },
        },
      });

      return { from: currentStatus, collectedAmount, deliveredAt: now };
    });

    logger.info(
      { clientId, orderId, actorId: actor.id, from: result.from, collected: result.collectedAmount },
      'Order marked delivered by client staff',
    );

    emitDelivered(clientId, orderId, result.deliveredAt);

    return {
      order_id: orderId,
      order_status: OrderStatus.DELIVERED,
      collected_amount: result.collectedAmount,
      delivered_at: result.deliveredAt.toISOString(),
    };
  },
};
