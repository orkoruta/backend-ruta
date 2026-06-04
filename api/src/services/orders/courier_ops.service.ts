import type { TenantTransactionClient } from '@orkoruta/db';
import { OrderStatus, PaymentStatus } from '@orkoruta/shared';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from '../../lib/http_error.js';
import { assertTransition } from './state_machine.js';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { processWebhookEvent } from '../webhooks_outgoing.service.js';
import { getMaintenanceBoss } from '../../jobs/maintenance_boss.js';

// ── Webhook helper ────────────────────────────────────────────────────────────

function emitWebhook(
  clientId: number,
  orderId: number,
  eventType: string,
  data: Record<string, unknown>,
): void {
  const boss = getMaintenanceBoss();
  if (!boss) return; // sin boss en entorno test/sin inicializar

  const payload = {
    event_type: eventType,
    client_id: clientId,
    order_id: orderId,
    timestamp: new Date().toISOString(),
    data,
  };

  setImmediate(() => {
    processWebhookEvent(eventType, payload, clientId, boss).catch((err: unknown) => {
      logger.warn({ err, clientId, orderId, eventType }, 'courier_ops: error emitiendo webhook');
    });
  });
}

// ── Schemas ───────────────────────────────────────────────────────────────────

export const attemptFailedSchema = z.object({
  reason: z.string().min(1, 'La razón del intento fallido es requerida'),
  notes: z.string().max(500).optional(),
});

export type AttemptFailedInput = z.infer<typeof attemptFailedSchema>;

// ── Helpers ───────────────────────────────────────────────────────────────────

const orderInclude = {
  order_items: {
    select: {
      id: true,
      product_id: true,
      product_name: true,
      sku: true,
      quantity: true,
      unit_price: true,
      subtotal: true,
    },
  },
} as const;

function serializeOrder(o: {
  id: bigint;
  client_id: bigint;
  buyer_id: bigint;
  courier_user_id: bigint | null;
  order_status: string;
  payment_status: string;
  refund_status: string;
  return_status: string | null;
  dispute_status: string | null;
  delivery_type: string;
  delivery_carrier_type: string | null;
  payment_method: string;
  payment_method_submethod: string | null;
  buyer_type: string;
  closure_reason: string | null;
  delivery_address_line: string | null;
  delivery_address_city: string | null;
  delivery_address_state: string | null;
  delivery_address_country: string | null;
  delivery_address_postal_code: string | null;
  delivery_address_latitude: unknown;
  delivery_address_longitude: unknown;
  delivery_instructions: string | null;
  pickup_point_id: bigint | null;
  subtotal: unknown;
  tax: unknown;
  shipping_fee: unknown;
  discount: unknown;
  total: unknown;
  currency: string;
  version: bigint;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  delivered_at: Date | null;
  closed_at: Date | null;
  order_items: {
    id: bigint;
    product_id: bigint | null;
    product_name: string;
    sku: string | null;
    quantity: number;
    unit_price: unknown;
    subtotal: unknown;
  }[];
}) {
  return {
    id: Number(o.id),
    client_id: Number(o.client_id),
    buyer_id: Number(o.buyer_id),
    courier_user_id: o.courier_user_id ? Number(o.courier_user_id) : null,
    order_status: o.order_status,
    payment_status: o.payment_status,
    refund_status: o.refund_status,
    return_status: o.return_status,
    dispute_status: o.dispute_status,
    delivery_type: o.delivery_type,
    delivery_carrier_type: o.delivery_carrier_type,
    payment_method: o.payment_method,
    payment_method_submethod: o.payment_method_submethod,
    buyer_type: o.buyer_type,
    closure_reason: o.closure_reason,
    delivery_address:
      o.delivery_address_line
        ? {
            line: o.delivery_address_line,
            city: o.delivery_address_city,
            state: o.delivery_address_state,
            country: o.delivery_address_country,
            postal_code: o.delivery_address_postal_code,
            latitude: o.delivery_address_latitude ? Number(o.delivery_address_latitude) : null,
            longitude: o.delivery_address_longitude ? Number(o.delivery_address_longitude) : null,
            instructions: o.delivery_instructions,
          }
        : null,
    pickup_point_id: o.pickup_point_id ? Number(o.pickup_point_id) : null,
    subtotal: Number(o.subtotal),
    tax: Number(o.tax),
    shipping_fee: Number(o.shipping_fee),
    discount: Number(o.discount),
    total: Number(o.total),
    currency: o.currency,
    version: Number(o.version),
    items: o.order_items.map((item) => ({
      id: Number(item.id),
      product_id: item.product_id ? Number(item.product_id) : null,
      product_name: item.product_name,
      sku: item.sku,
      quantity: item.quantity,
      unit_price: Number(item.unit_price),
      subtotal: Number(item.subtotal),
    })),
    created_at: o.created_at.toISOString(),
    updated_at: o.updated_at.toISOString(),
    submitted_at: o.submitted_at?.toISOString() ?? null,
    delivered_at: o.delivered_at?.toISOString() ?? null,
    closed_at: o.closed_at?.toISOString() ?? null,
  };
}

const ACTIVE_STATUSES: string[] = [
  OrderStatus.COURIER_ASSIGNED,
  OrderStatus.SHIPPED,
  OrderStatus.IN_TRANSIT,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.ARRIVED_AT_CUSTOMER,
  OrderStatus.PAYMENT_COLLECTION_PENDING,
  OrderStatus.CASH_COLLECTION_PENDING,
  OrderStatus.PAYMENT_COLLECTED_ELECTRONIC,
  OrderStatus.PAYMENT_COLLECTED_CASH,
];

// ── Optimistic lock helper ────────────────────────────────────────────────────
// Uses updateMany with version filter: count=0 means concurrent update → 409.

async function optimisticUpdate(
  tx: TenantTransactionClient,
  clientId: number,
  orderId: number,
  currentVersion: bigint,
  newStatus: string,
  extraData: { delivered_at?: Date } = {},
): Promise<void> {
  const result = await tx.orders.updateMany({
    where: {
      id: BigInt(orderId),
      client_id: BigInt(clientId),
      version: currentVersion,
    },
    data: {
      order_status: newStatus,
      ...extraData,
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
}

// ── Service ───────────────────────────────────────────────────────────────────

export const courierOpsService = {
  /**
   * GET /courier/orders/assigned
   * Pedidos activos (COURIER_ASSIGNED, SHIPPED, IN_TRANSIT, ...) +
   * count de completados hoy (DELIVERED con delivered_at = today).
   */
  async listAssignedOrders(clientId: number, courierUserId: number) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [active, completedToday] = await withTenantReadOnly(clientId, 'COURIER', (tx) =>
      Promise.all([
        tx.orders.findMany({
          where: {
            courier_user_id: BigInt(courierUserId),
            order_status: { in: ACTIVE_STATUSES },
          },
          include: orderInclude,
          orderBy: { created_at: 'desc' },
        }),
        tx.orders.count({
          where: {
            courier_user_id: BigInt(courierUserId),
            order_status: OrderStatus.DELIVERED,
            delivered_at: { gte: today },
          },
        }),
      ]),
    );

    return {
      active: active.map(serializeOrder),
      completed_today: completedToday,
    };
  },

  /**
   * GET /courier/orders/:id
   * Detalle del pedido; verifica courier_user_id = courierUserId, 403 si no.
   */
  async getOrderById(clientId: number, orderId: number, courierUserId: number) {
    const order = await withTenantReadOnly(clientId, 'COURIER', (tx) =>
      tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      }),
    );

    if (!order) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
    }

    if (order.courier_user_id === null || Number(order.courier_user_id) !== courierUserId) {
      throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
    }

    return serializeOrder(order);
  },

  /**
   * POST /courier/orders/:id/start-shipping
   * COURIER_ASSIGNED → SHIPPED vía assertTransition actor='COURIER'. Optimistic lock.
   */
  async startShipping(clientId: number, orderId: number, courierUserId: number) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierUserId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      assertTransition(order.order_status as OrderStatus, OrderStatus.SHIPPED, 'COURIER');

      await optimisticUpdate(tx, clientId, orderId, order.version, OrderStatus.SHIPPED);

      const updated = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      const result = serializeOrder(updated!);

      // F2.BACK-6 — ORDER_SHIPPED webhook
      emitWebhook(clientId, orderId, 'ORDER_SHIPPED', {
        order_status: OrderStatus.SHIPPED,
        delivery_type: updated!.delivery_type,
        courier_user_id: courierUserId,
      });

      return result;
    });
  },

  /**
   * POST /courier/orders/:id/mark-out-for-delivery
   * SHIPPED → IN_TRANSIT → OUT_FOR_DELIVERY. Dos transiciones atómicas en el mismo withTenant.
   */
  async markOutForDelivery(clientId: number, orderId: number, courierUserId: number) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierUserId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      const currentStatus = order.order_status as OrderStatus;

      if (currentStatus === OrderStatus.SHIPPED) {
        // SHIPPED → IN_TRANSIT (COURIER/SYSTEM)
        assertTransition(OrderStatus.SHIPPED, OrderStatus.IN_TRANSIT, 'COURIER');
        await optimisticUpdate(tx, clientId, orderId, order.version, OrderStatus.IN_TRANSIT);

        // Reload to get updated version for second transition
        const reloaded = await tx.orders.findUnique({
          where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
          include: orderInclude,
        });

        if (!reloaded) {
          throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado tras primera transición');
        }

        // IN_TRANSIT → OUT_FOR_DELIVERY (COURIER)
        assertTransition(OrderStatus.IN_TRANSIT, OrderStatus.OUT_FOR_DELIVERY, 'COURIER');
        await optimisticUpdate(tx, clientId, orderId, reloaded.version, OrderStatus.OUT_FOR_DELIVERY);
      } else if (currentStatus === OrderStatus.IN_TRANSIT) {
        // Already IN_TRANSIT, just transition to OUT_FOR_DELIVERY
        assertTransition(OrderStatus.IN_TRANSIT, OrderStatus.OUT_FOR_DELIVERY, 'COURIER');
        await optimisticUpdate(tx, clientId, orderId, order.version, OrderStatus.OUT_FOR_DELIVERY);
      } else {
        // Trigger assertTransition for proper 422 error
        assertTransition(currentStatus, OrderStatus.OUT_FOR_DELIVERY, 'COURIER');
      }

      const updated = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      const result = serializeOrder(updated!);

      // F2.BACK-6 — ORDER_OUT_FOR_DELIVERY webhook
      emitWebhook(clientId, orderId, 'ORDER_OUT_FOR_DELIVERY', {
        order_status: OrderStatus.OUT_FOR_DELIVERY,
        delivery_type: updated!.delivery_type,
        courier_user_id: courierUserId,
      });

      return result;
    });
  },

  /**
   * POST /courier/orders/:id/arrive
   * OUT_FOR_DELIVERY → ARRIVED_AT_CUSTOMER vía assertTransition.
   */
  async arrive(clientId: number, orderId: number, courierUserId: number) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierUserId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      assertTransition(order.order_status as OrderStatus, OrderStatus.ARRIVED_AT_CUSTOMER, 'COURIER');

      await optimisticUpdate(tx, clientId, orderId, order.version, OrderStatus.ARRIVED_AT_CUSTOMER);

      const updated = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      return serializeOrder(updated!);
    });
  },

  /**
   * POST /courier/orders/:id/attempt-failed
   * OUT_FOR_DELIVERY → DELIVERY_ATTEMPTED vía assertTransition.
   */
  async attemptFailed(
    clientId: number,
    orderId: number,
    courierUserId: number,
    reason: string,
    notes?: string,
  ) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierUserId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      assertTransition(order.order_status as OrderStatus, OrderStatus.DELIVERY_ATTEMPTED, 'COURIER');

      await optimisticUpdate(tx, clientId, orderId, order.version, OrderStatus.DELIVERY_ATTEMPTED);

      void reason;
      void notes;
      // reason/notes se persisten en audit_events (Sprint 6)

      const updated = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      const result = serializeOrder(updated!);

      // F2.BACK-6 — ORDER_DELIVERY_FAILED webhook
      emitWebhook(clientId, orderId, 'ORDER_DELIVERY_FAILED', {
        order_status: OrderStatus.DELIVERY_ATTEMPTED,
        delivery_type: updated!.delivery_type,
        courier_user_id: courierUserId,
        reason,
      });

      return result;
    });
  },

  /**
   * POST /courier/orders/:id/mark-delivered
   * ARRIVED_AT_CUSTOMER → DELIVERED.
   * Solo si payment_status = PAID o PAYMENT_COLLECTED. assertTransition con contexto paymentStatus.
   */
  async markDelivered(clientId: number, orderId: number, courierUserId: number) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierUserId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      assertTransition(order.order_status as OrderStatus, OrderStatus.DELIVERED, 'COURIER', {
        paymentStatus: order.payment_status,
      });

      await optimisticUpdate(tx, clientId, orderId, order.version, OrderStatus.DELIVERED, {
        delivered_at: new Date(),
      });

      const updated = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      const result = serializeOrder(updated!);

      // F2.BACK-6 — ORDER_DELIVERED webhook
      emitWebhook(clientId, orderId, 'ORDER_DELIVERED', {
        order_status: OrderStatus.DELIVERED,
        delivery_type: updated!.delivery_type,
        courier_user_id: courierUserId,
        delivered_at: updated!.delivered_at?.toISOString() ?? new Date().toISOString(),
      });

      return result;
    });
  },
};

export { PaymentStatus };
