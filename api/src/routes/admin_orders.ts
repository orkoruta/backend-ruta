import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { OrderStatus } from '@orkoruta/shared';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { requireAdminClient } from '../middleware/auth.js';
import { HttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import { assertTransition, canTransition } from '../services/orders/state_machine.js';
import { setRefundPendingIfPaid } from '../services/refunds.service.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import type { TransitionActor } from '../services/orders/state_machine.js';
import { logger } from '../lib/logger.js';
import { processWebhookEvent } from '../services/webhooks_outgoing.service.js';
import { getMaintenanceBoss } from '../jobs/maintenance_boss.js';

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
      logger.warn({ err, clientId, orderId, eventType }, 'admin_orders: error emitiendo webhook');
    });
  });
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const orderIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const adminOrderListQuerySchema = z.object({
  status: z.string().optional(),
  payment_status: z.string().optional(),
  buyer_id: z.coerce.number().int().positive().optional(),
  courier_id: z.coerce.number().int().positive().optional(),
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

const rejectOrderSchema = z.object({
  reason: z.string().optional(),
});

const markReadySchema = z.object({
  delivery_carrier_type: z.enum(['OWN_FLEET', 'EXTERNAL_COURIER']).optional(),
});

const cancelOrderBodySchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

const rejectCancelRequestBodySchema = z.object({
  reason: z.string().min(1, 'La razón del rechazo es requerida'),
});

// ── Actor mapping ─────────────────────────────────────────────────────────────

function toTransitionActor(userType: string): TransitionActor {
  if (userType === 'ADMIN_RUTA') return 'ADMIN_RUTA';
  if (userType === 'OPERATOR_CLIENT') return 'OPERATOR_CLIENT';
  return 'ADMIN_CLIENT';
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function requireAdminOrOperator(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }
  const { user_type } = req.user;
  if (user_type !== 'ADMIN_CLIENT' && user_type !== 'OPERATOR_CLIENT' && user_type !== 'ADMIN_RUTA') {
    res.status(403).json(toApiError('FORBIDDEN', 'Acceso restringido al personal del Cliente'));
    return;
  }
  next();
}

// ── Client-type guard ─────────────────────────────────────────────────────────

async function assertFullClient(clientId: number): Promise<void> {
  const client = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.clients.findUnique({
      where: { id: BigInt(clientId) },
      select: { client_type: true },
    }),
  );
  if (!client || client.client_type === 'API') {
    throw new HttpError(
      422,
      'LOGISTICS_ONLY_FEATURE_UNAVAILABLE',
      'Esta operación no aplica para Clientes API',
    );
  }
}

// ── Order include ─────────────────────────────────────────────────────────────

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
  users_orders_buyer_id_client_idTousers: {
    select: { id: true, full_name: true, email: true, phone: true },
  },
  users_orders_courier_user_id_client_idTousers: {
    select: { id: true, full_name: true, phone: true },
  },
  pickup_points: {
    select: { id: true, name: true },
  },
} as const;

// El historial solo se carga en el detalle: en el listado sería una lectura
// por fila que la tabla no muestra.
const orderDetailInclude = {
  ...orderInclude,
  order_state_history: {
    select: {
      id: true,
      state_dimension: true,
      previous_value: true,
      new_value: true,
      changed_by_actor_type: true,
      reason: true,
      occurred_at: true,
    },
    orderBy: { occurred_at: 'desc' as const },
  },
} as const;

function serializeOrder(o: {
  id: bigint;
  client_id: bigint;
  buyer_id: bigint;
  courier_user_id: bigint | null;
  order_status: string;
  payment_status: string;
  order_origin: string;
  buyer_type: string;
  delivery_type: string;
  delivery_carrier_type: string | null;
  payment_method: string;
  payment_method_submethod: string | null;
  closure_reason: string | null;
  subtotal: unknown;
  tax: unknown;
  shipping_fee: unknown;
  discount: unknown;
  total: unknown;
  currency: string;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  order_items: {
    id: bigint;
    product_id: bigint | null;
    product_name: string;
    sku: string | null;
    quantity: number;
    unit_price: unknown;
    subtotal: unknown;
  }[];
  order_state_history?: {
    id: bigint;
    state_dimension: string;
    previous_value: string | null;
    new_value: string;
    changed_by_actor_type: string | null;
    reason: string | null;
    occurred_at: Date;
  }[];
  users_orders_buyer_id_client_idTousers: {
    id: bigint;
    full_name: string | null;
    email: string;
    phone: string | null;
  };
  users_orders_courier_user_id_client_idTousers: {
    id: bigint;
    full_name: string | null;
    phone: string | null;
  } | null;
  delivery_address_line: string | null;
  delivery_address_city: string | null;
  delivery_address_state: string | null;
  delivery_instructions: string | null;
  pickup_points: { id: bigint; name: string } | null;
}) {
  const buyer = o.users_orders_buyer_id_client_idTousers;
  const courier = o.users_orders_courier_user_id_client_idTousers;
  // La UI muestra la dirección como una línea legible.
  const deliveryAddress = o.delivery_address_line
    ? [o.delivery_address_line, o.delivery_address_city, o.delivery_address_state]
        .filter(Boolean)
        .join(', ')
    : null;

  return {
    id: Number(o.id),
    client_id: Number(o.client_id),
    buyer_id: Number(o.buyer_id),
    courier_user_id: o.courier_user_id ? Number(o.courier_user_id) : null,
    buyer: {
      id: Number(buyer.id),
      name: buyer.full_name ?? buyer.email,
      email: buyer.email,
      phone: buyer.phone,
    },
    courier: courier
      ? {
          id: Number(courier.id),
          name: courier.full_name ?? '',
          phone: courier.phone,
        }
      : null,
    // Planos para el listado, que muestra columnas en vez del objeto anidado.
    buyer_name: buyer.full_name ?? buyer.email,
    courier_name: courier ? courier.full_name : null,
    delivery_address: deliveryAddress,
    delivery_instructions: o.delivery_instructions,
    pickup_point_name: o.pickup_points?.name ?? null,
    order_status: o.order_status,
    payment_status: o.payment_status,
    order_origin: o.order_origin,
    buyer_type: o.buyer_type,
    delivery_type: o.delivery_type,
    delivery_carrier_type: o.delivery_carrier_type,
    payment_method: o.payment_method,
    payment_method_submethod: o.payment_method_submethod,
    closure_reason: o.closure_reason,
    subtotal: Number(o.subtotal),
    tax: Number(o.tax),
    shipping_fee: Number(o.shipping_fee),
    discount: Number(o.discount),
    total: Number(o.total),
    currency: o.currency,
    items: o.order_items.map((i) => ({
      id: Number(i.id),
      product_id: i.product_id ? Number(i.product_id) : null,
      product_name: i.product_name,
      sku: i.sku,
      quantity: i.quantity,
      unit_price: Number(i.unit_price),
      subtotal: Number(i.subtotal),
    })),
    history: (o.order_state_history ?? []).map((h) => ({
      id: Number(h.id),
      state_dimension: h.state_dimension,
      previous_value: h.previous_value,
      new_value: h.new_value,
      actor_type: h.changed_by_actor_type,
      reason: h.reason,
      occurred_at: h.occurred_at.toISOString(),
    })),
    created_at: o.created_at.toISOString(),
    updated_at: o.updated_at.toISOString(),
    submitted_at: o.submitted_at?.toISOString() ?? null,
  };
}

// ── Admin orders service ──────────────────────────────────────────────────────

export const adminOrdersService = {
  async list(clientId: number, query: z.infer<typeof adminOrderListQuerySchema>) {
    const skip = (query.page - 1) * query.page_size;
    const where = {
      client_id: BigInt(clientId),
      ...(query.status ? { order_status: query.status } : {}),
      ...(query.payment_status ? { payment_status: query.payment_status } : {}),
      ...(query.buyer_id ? { buyer_id: BigInt(query.buyer_id) } : {}),
      ...(query.courier_id ? { courier_user_id: BigInt(query.courier_id) } : {}),
      ...(query.date_from || query.date_to
        ? {
            created_at: {
              ...(query.date_from ? { gte: new Date(query.date_from) } : {}),
              ...(query.date_to ? { lte: new Date(query.date_to) } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      Promise.all([
        tx.orders.findMany({
          where,
          include: orderInclude,
          orderBy: { created_at: 'desc' },
          skip,
          take: query.page_size,
        }),
        tx.orders.count({ where }),
      ]),
    );

    return {
      data: items.map(serializeOrder),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },

  async getById(clientId: number, orderId: number) {
    const order = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderDetailInclude,
      }),
    );
    if (!order) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
    return serializeOrder(order);
  },

  /**
   * Confirma un pedido corporativo que el propio Cliente registró (Flujo 6).
   * El comprador corporativo no usa la tienda, así que nadie más podría
   * sacarlo de DRAFT y el pedido moriría por expiración.
   */
  async confirmCorporate(clientId: number, orderId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);
    const transitionActor = toTransitionActor(actor.user_type);

    const order = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });
      if (!existing) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

      if (existing.buyer_type !== 'CORPORATE') {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          'Solo el comprador puede confirmar un pedido no corporativo',
        );
      }

      const ctx = { buyerType: existing.buyer_type };

      // DRAFT → PENDING_CONFIRM → ORDER_SUBMITTED, atómico como en el lado comprador.
      assertTransition(
        existing.order_status as OrderStatus,
        OrderStatus.PENDING_CONFIRM,
        transitionActor,
        ctx,
      );
      assertTransition(
        OrderStatus.PENDING_CONFIRM,
        OrderStatus.ORDER_SUBMITTED,
        transitionActor,
        ctx,
      );

      const paymentStatus =
        existing.payment_method === 'ONLINE_AT_ORDER'
          ? 'PENDING_ONLINE_PAYMENT'
          : 'PENDING_COLLECTION';

      const updated = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: {
          order_status: OrderStatus.ORDER_SUBMITTED,
          payment_status: paymentStatus,
          submitted_at: new Date(),
          updated_at: new Date(),
        },
        include: orderInclude,
      });

      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actor.id),
          actor_type: 'USER',
          actor_role: actor.user_type,
          action: 'CORPORATE_ORDER_CONFIRMED',
          entity_type: 'order',
          entity_id: existing.id,
          result: 'SUCCESS',
          metadata: { payment_method: existing.payment_method, payment_status: paymentStatus },
        },
      });

      logger.info(
        { clientId, orderId, actorId: actor.id, actorType: actor.user_type, paymentStatus },
        'Corporate order confirmed by client',
      );

      return updated;
    });

    return serializeOrder(order);
  },

  async accept(clientId: number, orderId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);
    const transitionActor = toTransitionActor(actor.user_type);

    const order = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });
      if (!existing) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

      const currentStatus = existing.order_status as OrderStatus;

      // MANUAL_REVIEW → VALIDATION_APPROVED first, then SELLER_CONFIRMED
      if (currentStatus === OrderStatus.MANUAL_REVIEW) {
        assertTransition(OrderStatus.MANUAL_REVIEW, OrderStatus.VALIDATION_APPROVED, transitionActor);
        await tx.orders.update({
          where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
          data: { order_status: OrderStatus.VALIDATION_APPROVED, updated_at: new Date() },
        });
      }

      // VALIDATION_APPROVED → SELLER_CONFIRMED
      const statusBeforeConfirm =
        currentStatus === OrderStatus.MANUAL_REVIEW
          ? OrderStatus.VALIDATION_APPROVED
          : currentStatus;

      assertTransition(statusBeforeConfirm, OrderStatus.SELLER_CONFIRMED, transitionActor);

      return tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.SELLER_CONFIRMED, updated_at: new Date() },
        include: orderInclude,
      });
    });

    return serializeOrder(order);
  },

  /**
   * Cancelación por parte del Cliente (CANCELLED_BY_ADMIN → CLOSED).
   *
   * Algunos estados no cancelan directo y el flujo exige pasar antes por una
   * retención: SHIPMENT_HOLD en la rama SHIP y PICKUP_POINT_ISSUE en PICKUP.
   * Ese salto se hace aquí para que el operador no tenga que encadenarlo a mano.
   */
  async cancel(clientId: number, orderId: number, actor: AuthenticatedUser, reason?: string) {
    await assertFullClient(clientId);
    const transitionActor = toTransitionActor(actor.user_type);

    const order = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });
      if (!existing) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

      const currentStatus = existing.order_status as OrderStatus;

      // Estado intermedio necesario, si lo hubiera.
      const hop = [OrderStatus.SHIPMENT_HOLD, OrderStatus.PICKUP_POINT_ISSUE].find(
        (candidate) =>
          !canTransition(currentStatus, OrderStatus.CANCELLED_BY_ADMIN, transitionActor) &&
          canTransition(currentStatus, candidate, transitionActor) &&
          canTransition(candidate, OrderStatus.CANCELLED_BY_ADMIN, transitionActor),
      );

      if (hop) {
        assertTransition(currentStatus, hop, transitionActor);
        await tx.orders.update({
          where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
          data: { order_status: hop, updated_at: new Date() },
        });
      }

      const statusBeforeCancel = hop ?? currentStatus;
      assertTransition(statusBeforeCancel, OrderStatus.CANCELLED_BY_ADMIN, transitionActor);
      await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.CANCELLED_BY_ADMIN, updated_at: new Date() },
      });

      assertTransition(OrderStatus.CANCELLED_BY_ADMIN, OrderStatus.CLOSED, 'SYSTEM');
      const closedOrder = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: {
          order_status: OrderStatus.CLOSED,
          closure_reason: OrderStatus.CANCELLED_BY_ADMIN,
          closed_at: new Date(),
          updated_at: new Date(),
        },
        include: orderInclude,
      });

      // La razón no tiene columna propia; queda en la auditoría, que es append-only.
      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actor.id),
          actor_type: 'USER',
          actor_role: actor.user_type,
          action: 'ORDER_CANCELLED_BY_ADMIN',
          entity_type: 'order',
          entity_id: BigInt(orderId),
          result: 'SUCCESS',
          metadata: { reason: reason ?? null, from_status: currentStatus, via: hop ?? null },
        },
      });

      await setRefundPendingIfPaid(tx, BigInt(orderId), BigInt(clientId), closedOrder.payment_status);

      logger.info(
        { clientId, orderId, actorId: actor.id, from: currentStatus, via: hop ?? null },
        'Order cancelled by client staff',
      );

      return closedOrder;
    });

    return serializeOrder(order);
  },

  async reject(clientId: number, orderId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);
    const transitionActor = toTransitionActor(actor.user_type);

    const order = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });
      if (!existing) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

      const currentStatus = existing.order_status as OrderStatus;
      let cancelStatus: OrderStatus;

      if (currentStatus === OrderStatus.MANUAL_REVIEW) {
        // MANUAL_REVIEW → VALIDATION_REJECTED → CANCELLED_BY_SYSTEM → CLOSED
        assertTransition(OrderStatus.MANUAL_REVIEW, OrderStatus.VALIDATION_REJECTED, transitionActor);
        await tx.orders.update({
          where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
          data: { order_status: OrderStatus.VALIDATION_REJECTED, updated_at: new Date() },
        });

        assertTransition(OrderStatus.VALIDATION_REJECTED, OrderStatus.CANCELLED_BY_SYSTEM, 'SYSTEM');
        await tx.orders.update({
          where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
          data: { order_status: OrderStatus.CANCELLED_BY_SYSTEM, updated_at: new Date() },
        });
        cancelStatus = OrderStatus.CANCELLED_BY_SYSTEM;
      } else {
        // VALIDATION_APPROVED → CANCELLED_BY_SELLER → CLOSED
        assertTransition(currentStatus, OrderStatus.CANCELLED_BY_SELLER, transitionActor);
        await tx.orders.update({
          where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
          data: { order_status: OrderStatus.CANCELLED_BY_SELLER, updated_at: new Date() },
        });
        cancelStatus = OrderStatus.CANCELLED_BY_SELLER;
      }

      assertTransition(cancelStatus, OrderStatus.CLOSED, 'SYSTEM');
      const closedOrder = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: {
          order_status: OrderStatus.CLOSED,
          closure_reason: cancelStatus,
          closed_at: new Date(),
          updated_at: new Date(),
        },
        include: orderInclude,
      });

      // Si el pedido estaba pagado, marcar refund_status = REFUND_PENDING
      await setRefundPendingIfPaid(tx, BigInt(orderId), BigInt(clientId), closedOrder.payment_status);

      return closedOrder;
    });

    return serializeOrder(order);
  },

  async markPreparing(clientId: number, orderId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);
    const transitionActor = toTransitionActor(actor.user_type);

    const order = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });
      if (!existing) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

      assertTransition(
        existing.order_status as OrderStatus,
        OrderStatus.PREPARING,
        transitionActor,
      );

      return tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.PREPARING, updated_at: new Date() },
        include: orderInclude,
      });
    });

    return serializeOrder(order);
  },

  async markReady(
    clientId: number,
    orderId: number,
    actor: AuthenticatedUser,
    deliveryCarrierType?: string,
  ) {
    await assertFullClient(clientId);
    const transitionActor = toTransitionActor(actor.user_type);

    const order = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });
      if (!existing) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

      const ctx = {
        deliveryType: existing.delivery_type,
        deliveryCarrierType: deliveryCarrierType ?? existing.delivery_carrier_type ?? undefined,
      };

      // Determine target status based on delivery context
      let targetStatus: OrderStatus;
      if (existing.delivery_type === 'PICKUP') {
        targetStatus = OrderStatus.READY_FOR_PICKUP;
      } else if (ctx.deliveryCarrierType === 'OWN_FLEET') {
        targetStatus = OrderStatus.AWAITING_COURIER_ASSIGNMENT;
      } else {
        targetStatus = OrderStatus.READY_TO_SHIP;
      }

      assertTransition(existing.order_status as OrderStatus, targetStatus, transitionActor, ctx);

      const updateData: Record<string, unknown> = {
        order_status: targetStatus,
        updated_at: new Date(),
      };
      if (deliveryCarrierType) {
        updateData['delivery_carrier_type'] = deliveryCarrierType;
      }

      return tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: updateData,
        include: orderInclude,
      });
    });

    // F2.BACK-6 — ORDER_READY_FOR_PICKUP webhook (solo para pedidos PICKUP)
    if (order.delivery_type === 'PICKUP') {
      emitWebhook(clientId, orderId, 'ORDER_READY_FOR_PICKUP', {
        order_status: OrderStatus.READY_FOR_PICKUP,
        delivery_type: order.delivery_type,
      });
    }

    return serializeOrder(order);
  },

  async approveCancelRequest(clientId: number, orderId: number, actor: AuthenticatedUser) {
    const transitionActor = toTransitionActor(actor.user_type);
    const order = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });
      if (!existing) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      assertTransition(
        existing.order_status as OrderStatus,
        OrderStatus.CANCEL_REQUEST_APPROVED,
        transitionActor,
      );
      return tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.CANCEL_REQUEST_APPROVED, updated_at: new Date() },
        include: orderInclude,
      });
    });
    return serializeOrder(order);
  },

  async rejectCancelRequest(
    clientId: number,
    orderId: number,
    actor: AuthenticatedUser,
    reason: string,
  ) {
    const transitionActor = toTransitionActor(actor.user_type);
    const order = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });
      if (!existing) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      assertTransition(
        existing.order_status as OrderStatus,
        OrderStatus.CANCEL_REQUEST_REJECTED,
        transitionActor,
      );
      return tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.CANCEL_REQUEST_REJECTED, updated_at: new Date() },
        include: orderInclude,
      });
    });
    void reason; // reason se persiste en audit_events (responsabilidad futura)
    return serializeOrder(order);
  },

  async returnToOrigin(clientId: number, orderId: number, actor: AuthenticatedUser) {
    const transitionActor = toTransitionActor(actor.user_type);
    const order = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });
      if (!existing) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      assertTransition(
        existing.order_status as OrderStatus,
        OrderStatus.RETURN_TO_ORIGIN,
        transitionActor,
      );
      return tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.RETURN_TO_ORIGIN, updated_at: new Date() },
        include: orderInclude,
      });
    });
    return serializeOrder(order);
  },

  async returnToOriginReceived(clientId: number, orderId: number, actor: AuthenticatedUser) {
    const transitionActor = toTransitionActor(actor.user_type);
    const order = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });
      if (!existing) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      assertTransition(
        existing.order_status as OrderStatus,
        OrderStatus.RETURN_TO_ORIGIN_RECEIVED,
        transitionActor,
      );
      return tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.RETURN_TO_ORIGIN_RECEIVED, updated_at: new Date() },
        include: orderInclude,
      });
    });
    return serializeOrder(order);
  },
};

// ── Router factory ────────────────────────────────────────────────────────────

type AdminOrdersService = typeof adminOrdersService;

export function createAdminOrdersRouter(service: AdminOrdersService = adminOrdersService): Router {
  const router = Router();

  // Idempotency is applied per-route (not globally) to avoid double-application
  // when secondary routers are mounted at the same /admin/orders prefix.

  // GET /admin/orders — requires at least admin or operator role
  router.get('/', requireAdminOrOperator, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = adminOrderListQuerySchema.parse(req.query);
      res.json(await service.list(req.user!.client_id, query));
    } catch (error) {
      next(error);
    }
  });

  // GET /admin/orders/:id
  router.get('/:id', requireAdminOrOperator, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      res.json(await service.getById(req.user!.client_id, id));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/orders/:id/accept — ADMIN_CLIENT + ADMIN_RUTA (seller acceptance)
  // POST /admin/orders/:id/confirm — envía un pedido corporativo en DRAFT (Flujo 6)
  router.post('/:id/confirm', requireIdempotencyKey, requireAdminOrOperator, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      res.json(await service.confirmCorporate(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/orders/:id/cancel — cancelación por el Cliente
  router.post('/:id/cancel', requireIdempotencyKey, requireAdminOrOperator, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const { reason } = cancelOrderBodySchema.parse(req.body ?? {});
      res.json(await service.cancel(req.user!.client_id, id, req.user!, reason));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/accept', requireIdempotencyKey, requireAdminClient, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      res.json(await service.accept(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/orders/:id/reject — ADMIN_CLIENT + ADMIN_RUTA (seller rejection)
  router.post('/:id/reject', requireIdempotencyKey, requireAdminClient, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      rejectOrderSchema.parse(req.body); // validate body shape even if optional
      res.json(await service.reject(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/orders/:id/mark-preparing — ADMIN_CLIENT + OPERATOR_CLIENT + ADMIN_RUTA
  router.post('/:id/mark-preparing', requireIdempotencyKey, requireAdminOrOperator, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      res.json(await service.markPreparing(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/orders/:id/mark-ready — ADMIN_CLIENT + OPERATOR_CLIENT + ADMIN_RUTA
  router.post('/:id/mark-ready', requireIdempotencyKey, requireAdminOrOperator, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const { delivery_carrier_type } = markReadySchema.parse(req.body ?? {});
      res.json(await service.markReady(req.user!.client_id, id, req.user!, delivery_carrier_type));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/orders/:id/approve-cancel-request
  router.post('/:id/approve-cancel-request', requireIdempotencyKey, requireAdminOrOperator, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      res.json(await service.approveCancelRequest(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/orders/:id/reject-cancel-request
  router.post('/:id/reject-cancel-request', requireIdempotencyKey, requireAdminOrOperator, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const { reason } = rejectCancelRequestBodySchema.parse(req.body);
      res.json(await service.rejectCancelRequest(req.user!.client_id, id, req.user!, reason));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/orders/:id/return-to-origin
  router.post('/:id/return-to-origin', requireIdempotencyKey, requireAdminOrOperator, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      res.json(await service.returnToOrigin(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/orders/:id/return-to-origin-received
  router.post('/:id/return-to-origin-received', requireIdempotencyKey, requireAdminOrOperator, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      res.json(await service.returnToOriginReceived(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminOrdersRouter = createAdminOrdersRouter();
