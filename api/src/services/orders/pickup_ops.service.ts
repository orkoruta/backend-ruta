/**
 * pickup_ops.service.ts — 4.BACK-1
 *
 * Operaciones del flujo PICKUP ejecutadas por OPERATOR_CLIENT / ADMIN_CLIENT
 * en el panel de administración.
 *
 * Tres acciones soportadas:
 *  1. verifyBuyerIdentity — registra validación de identidad en el punto físico
 *  2. recordPickupCollection — registra cobro contra entrega en el punto
 *  3. markPickupDelivered — transiciona READY_FOR_PICKUP → DELIVERED
 */

import { OrderStatus } from '@orkoruta/shared';
import { withTenant } from '@orkoruta/db';
import { HttpError } from '../../lib/http_error.js';
import { assertTransition } from './state_machine.js';
import type { AuthenticatedUser } from '../../middleware/auth.js';
import type { TransitionActor } from './state_machine.js';
import { logger } from '../../lib/logger.js';
import { processWebhookEvent } from '../webhooks_outgoing.service.js';
import { deliveryEmailService } from '../notifications/delivery_email.service.js';
import { getMaintenanceBoss } from '../../jobs/maintenance_boss.js';

// ── Webhook helper ────────────────────────────────────────────────────────────

function emitWebhook(
  clientId: number,
  orderId: number,
  eventType: string,
  data: Record<string, unknown>,
): void {
  const boss = getMaintenanceBoss();
  if (!boss) return;

  const payload = {
    event_type: eventType,
    client_id: clientId,
    order_id: orderId,
    timestamp: new Date().toISOString(),
    data,
  };

  setImmediate(() => {
    processWebhookEvent(eventType, payload, clientId, boss).catch((err: unknown) => {
      logger.warn({ err, clientId, orderId, eventType }, 'pickup_ops: error emitiendo webhook');
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toTransitionActor(userType: string): TransitionActor {
  if (userType === 'OPERATOR_CLIENT') return 'OPERATOR_CLIENT';
  return 'ADMIN_CLIENT';
}

// ── verifyBuyerIdentity ───────────────────────────────────────────────────────

export interface DocumentData {
  document_type: string;
  document_number: string;
}

export async function verifyBuyerIdentity(
  orderId: number,
  clientId: number,
  actingUser: AuthenticatedUser,
  documentData: DocumentData,
): Promise<{ order_id: number; verified: true }> {
  return withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
    const order = await tx.orders.findUnique({
      where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
      select: {
        id: true,
        client_id: true,
        order_status: true,
      },
    });

    if (!order) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
    }

    if (order.order_status !== OrderStatus.READY_FOR_PICKUP) {
      throw new HttpError(
        422,
        'INVALID_STATE_TRANSITION',
        `El pedido no está en estado READY_FOR_PICKUP (estado actual: ${order.order_status})`,
        { current_status: order.order_status, required_status: OrderStatus.READY_FOR_PICKUP },
      );
    }

    await tx.audit_events.create({
      data: {
        client_id: BigInt(clientId),
        actor_user_id: BigInt(actingUser.id),
        actor_type: 'USER',
        actor_role: actingUser.user_type,
        action: 'verify_buyer_identity',
        entity_type: 'order',
        entity_id: BigInt(orderId),
        metadata: {
          document_type: documentData.document_type,
          document_number: documentData.document_number,
          order_status: order.order_status,
        },
        result: 'SUCCESS',
      },
    });

    return { order_id: orderId, verified: true };
  });
}

// ── recordPickupCollection ────────────────────────────────────────────────────

export async function recordPickupCollection(
  orderId: number,
  clientId: number,
  actingUser: AuthenticatedUser,
  amount: number,
): Promise<{ order_id: number; payment_id: number }> {
  return withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
    const order = await tx.orders.findUnique({
      where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
      select: {
        id: true,
        client_id: true,
        order_status: true,
      },
    });

    if (!order) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
    }

    if (order.order_status !== OrderStatus.READY_FOR_PICKUP) {
      throw new HttpError(
        422,
        'INVALID_STATE_TRANSITION',
        `El pedido no está en estado READY_FOR_PICKUP (estado actual: ${order.order_status})`,
        { current_status: order.order_status, required_status: OrderStatus.READY_FOR_PICKUP },
      );
    }

    const payment = await tx.payments.create({
      data: {
        client_id: BigInt(clientId),
        order_id: BigInt(orderId),
        payment_method: 'CASH_ON_DELIVERY',
        amount: amount,
        currency: 'COP',
        status: 'CONFIRMED',
        collected_at: new Date(),
      },
      select: { id: true },
    });

    await tx.audit_events.create({
      data: {
        client_id: BigInt(clientId),
        actor_user_id: BigInt(actingUser.id),
        actor_type: 'USER',
        actor_role: actingUser.user_type,
        action: 'record_pickup_collection',
        entity_type: 'order',
        entity_id: BigInt(orderId),
        metadata: {
          payment_id: Number(payment.id),
          amount,
          currency: 'COP',
          payment_method: 'CASH_ON_DELIVERY',
          order_status: order.order_status,
        },
        result: 'SUCCESS',
      },
    });

    return { order_id: orderId, payment_id: Number(payment.id) };
  });
}

// ── markPickupDelivered ───────────────────────────────────────────────────────

export interface PickupDeliveredResult {
  order_id: number;
  order_status: string;
  delivered_at: string;
}

export async function markPickupDelivered(
  orderId: number,
  clientId: number,
  actingUser: AuthenticatedUser,
): Promise<PickupDeliveredResult> {
  const actor = toTransitionActor(actingUser.user_type);

  return withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
    const order = await tx.orders.findUnique({
      where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
      select: {
        id: true,
        client_id: true,
        order_status: true,
        version: true,
      },
    });

    if (!order) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
    }

    assertTransition(order.order_status as OrderStatus, OrderStatus.DELIVERED, actor);

    const deliveredAt = new Date();

    const result = await tx.orders.updateMany({
      where: {
        id: BigInt(orderId),
        client_id: BigInt(clientId),
        version: order.version,
      },
      data: {
        order_status: OrderStatus.DELIVERED,
        delivered_at: deliveredAt,
        version: { increment: 1 },
        updated_at: new Date(),
      },
    });

    if (result.count === 0) {
      throw new HttpError(
        409,
        'OPTIMISTIC_LOCK_FAILED',
        'El pedido fue modificado por otro proceso. Intenta de nuevo.',
      );
    }

    await tx.audit_events.create({
      data: {
        client_id: BigInt(clientId),
        actor_user_id: BigInt(actingUser.id),
        actor_type: 'USER',
        actor_role: actingUser.user_type,
        action: 'mark_pickup_delivered',
        entity_type: 'order',
        entity_id: BigInt(orderId),
        metadata: {
          order_status_before: order.order_status,
          order_status_after: OrderStatus.DELIVERED,
        },
        result: 'SUCCESS',
      },
    });

    const pickupResult = {
      order_id: orderId,
      order_status: OrderStatus.DELIVERED,
      delivered_at: deliveredAt.toISOString(),
    };

    // F2.BACK-6 — ORDER_PICKED_UP webhook (PICKUP delivery entregado)
    emitWebhook(clientId, orderId, 'ORDER_PICKED_UP', {
      order_status: OrderStatus.DELIVERED,
      delivery_type: 'PICKUP',
      delivered_at: deliveredAt.toISOString(),
    });

    // Aviso por correo al comprador. Va por la cola y sin `await` en la ruta
    // crítica: si el correo falla, el pedido sigue entregado igual.
    const boss = getMaintenanceBoss();
    if (boss) {
      setImmediate(() => {
        deliveryEmailService
          .queueDeliveryEmail(clientId, orderId, boss)
          .catch((err: unknown) =>
            logger.warn({ err, clientId, orderId }, 'delivery_email: no se pudo encolar'),
          );
      });
    }

    return pickupResult;
  });
}
