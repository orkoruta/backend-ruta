import { z } from 'zod';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import {
  OrderStatus,
  PaymentStatus,
  createOrderSchema,
  confirmOrderSchema,
  cancelOrderSchema,
} from '@orkoruta/shared';
import { HttpError } from '../../lib/http_error.js';
import { assertTransition } from './state_machine.js';
import type { AuthenticatedUser } from '../../middleware/auth.js';

// requestCancelSchema no está en @orkoruta/shared@1.1.0; se define aquí
export const requestCancelSchema = z.object({
  reason: z.string().min(1, 'La razón de la solicitud de cancelación es requerida'),
});

export const orderListQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type ConfirmOrderInput = z.infer<typeof confirmOrderSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
export type RequestCancelInput = z.infer<typeof requestCancelSchema>;
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

// Estados en los que BUYER puede forzar cancelación (no post-despacho)
const BUYER_CANCEL_ALLOWED: Set<string> = new Set([
  OrderStatus.DRAFT,
  OrderStatus.PENDING_CONFIRM,
  OrderStatus.ORDER_SUBMITTED,
  OrderStatus.ORDER_VALIDATING,
]);

// Estados desde los que BUYER puede solicitar cancelación post-despacho
const BUYER_REQUEST_CANCEL_ALLOWED: Set<string> = new Set([
  OrderStatus.SHIPPED,
  OrderStatus.IN_TRANSIT,
  OrderStatus.OUT_FOR_DELIVERY,
]);

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

export const ordersService = {
  async create(clientId: number, actor: AuthenticatedUser, input: CreateOrderInput) {
    const order = await withTenant(clientId, 'BUYER', async (tx) => {
      // Verificar que todos los productos existen y pertenecen al cliente
      const productIds = input.items.map((i) => BigInt(i.product_id));
      const products = await tx.products.findMany({
        where: {
          id: { in: productIds },
          status: 'ACTIVE',
        },
        select: { id: true, unit_price: true, name: true, sku: true },
      });

      if (products.length !== productIds.length) {
        throw new HttpError(422, 'VALIDATION_ERROR', 'Uno o más productos no existen o están inactivos');
      }

      const productMap = new Map(products.map((p) => [Number(p.id), p]));

      // Calcular subtotal
      let subtotal = 0;
      const items = input.items.map((item) => {
        const product = productMap.get(item.product_id)!;
        const unitPrice = Number(product.unit_price);
        const lineSubtotal = unitPrice * item.quantity;
        subtotal += lineSubtotal;
        return {
          product_name: product.name,
          sku: product.sku ?? null,
          quantity: item.quantity,
          unit_price: unitPrice,
          subtotal: lineSubtotal,
        };
      });

      const created = await tx.orders.create({
        data: {
          client_id: BigInt(clientId),
          buyer_id: BigInt(actor.id),
          order_origin: 'BUYER_UI',
          order_status: OrderStatus.DRAFT,
          payment_status: PaymentStatus.PAYMENT_NOT_STARTED,
          refund_status: 'REFUND_NOT_REQUIRED',
          // delivery_type se asigna en confirm; temporal hasta entonces
          delivery_type: 'SHIP',
          payment_method: 'ONLINE_AT_ORDER',
          buyer_type: 'INDIVIDUAL',
          subtotal,
          total: subtotal,
          currency: 'COP',
          order_items: { create: items },
        },
        include: orderInclude,
      });

      return created;
    });

    return serializeOrder(order);
  },

  async confirm(
    clientId: number,
    orderId: number,
    actor: AuthenticatedUser,
    input: ConfirmOrderInput,
  ) {
    const order = await withTenant(clientId, 'BUYER', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (Number(existing.buyer_id) !== actor.id) {
        throw new HttpError(403, 'FORBIDDEN', 'No tienes permiso sobre este pedido');
      }

      // Transición: DRAFT → PENDING_CONFIRM
      assertTransition(
        existing.order_status as OrderStatus,
        OrderStatus.PENDING_CONFIRM,
        'BUYER',
      );

      // Validar dirección o pickup_point según delivery_type
      if (input.delivery_type === 'SHIP' && !input.delivery_address) {
        throw new HttpError(422, 'VALIDATION_ERROR', 'Se requiere delivery_address para SHIP');
      }
      if (input.delivery_type === 'PICKUP' && !input.pickup_point_id) {
        throw new HttpError(422, 'VALIDATION_ERROR', 'Se requiere pickup_point_id para PICKUP');
      }

      // Determinar payment_status según payment_method
      const paymentStatus =
        input.payment_method === 'ONLINE_AT_ORDER'
          ? PaymentStatus.PENDING_ONLINE_PAYMENT
          : PaymentStatus.PENDING_COLLECTION;

      // Actualizar DRAFT → PENDING_CONFIRM → ORDER_SUBMITTED (atómico)
      const addr = input.delivery_address;

      const updated = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: {
          order_status: OrderStatus.ORDER_SUBMITTED,
          payment_status: paymentStatus,
          delivery_type: input.delivery_type,
          payment_method: input.payment_method,
          payment_method_submethod: input.payment_method_submethod ?? null,
          delivery_address_line: addr?.line ?? null,
          delivery_address_city: addr?.city ?? null,
          delivery_address_state: addr?.state ?? null,
          delivery_address_country: addr?.country ?? null,
          delivery_address_postal_code: addr?.postal_code ?? null,
          delivery_address_latitude: addr?.latitude ?? null,
          delivery_address_longitude: addr?.longitude ?? null,
          delivery_instructions: addr?.instructions ?? null,
          pickup_point_id: input.pickup_point_id ? BigInt(input.pickup_point_id) : null,
          submitted_at: new Date(),
          updated_at: new Date(),
        },
        include: orderInclude,
      });

      return updated;
    });

    return serializeOrder(order);
  },

  async cancel(
    clientId: number,
    orderId: number,
    actor: AuthenticatedUser,
    input: CancelOrderInput,
  ) {
    const order = await withTenant(clientId, 'BUYER', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (Number(existing.buyer_id) !== actor.id) {
        throw new HttpError(403, 'FORBIDDEN', 'No tienes permiso sobre este pedido');
      }

      if (!BUYER_CANCEL_ALLOWED.has(existing.order_status)) {
        throw new HttpError(422, 'INVALID_STATE_TRANSITION', `No puedes cancelar un pedido en estado ${existing.order_status}`);
      }

      assertTransition(
        existing.order_status as OrderStatus,
        OrderStatus.CANCELLED_BY_CUSTOMER,
        'BUYER',
        { paymentStatus: existing.payment_status },
      );

      // CANCELLED_BY_CUSTOMER → CLOSED (dos updates atómicos)
      await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.CANCELLED_BY_CUSTOMER, updated_at: new Date() },
      });

      const updated = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: {
          order_status: OrderStatus.CLOSED,
          closure_reason: 'CANCELLED_BY_CUSTOMER',
          closed_at: new Date(),
          updated_at: new Date(),
        },
        include: orderInclude,
      });

      return updated;
    });

    void input; // reason se puede persistir en audit_events (responsabilidad futura)

    const serialized = serializeOrder(order);

    // F2.BACK-6 — ORDER_CANCELLED webhook (cancelación por comprador)
    const boss = getMaintenanceBoss();
    if (boss) {
      const webhookPayload = {
        event_type: 'ORDER_CANCELLED',
        client_id: clientId,
        order_id: orderId,
        timestamp: new Date().toISOString(),
        data: {
          order_status: OrderStatus.CLOSED,
          closure_reason: 'CANCELLED_BY_CUSTOMER',
          delivery_type: serialized.delivery_type,
        },
      };
      setImmediate(() => {
        processWebhookEvent('ORDER_CANCELLED', webhookPayload, clientId, boss).catch((err: unknown) => {
          logger.warn({ err, clientId, orderId }, 'orders.service: error emitiendo ORDER_CANCELLED webhook');
        });
      });
    }

    return serialized;
  },

  async requestCancel(
    clientId: number,
    orderId: number,
    actor: AuthenticatedUser,
    input: RequestCancelInput,
  ) {
    const order = await withTenant(clientId, 'BUYER', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (Number(existing.buyer_id) !== actor.id) {
        throw new HttpError(403, 'FORBIDDEN', 'No tienes permiso sobre este pedido');
      }

      if (!BUYER_REQUEST_CANCEL_ALLOWED.has(existing.order_status)) {
        throw new HttpError(422, 'INVALID_STATE_TRANSITION', `No puedes solicitar cancelación en estado ${existing.order_status}`);
      }

      assertTransition(
        existing.order_status as OrderStatus,
        OrderStatus.CUSTOMER_CANCEL_REQUEST,
        'BUYER',
      );

      const updated = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.CUSTOMER_CANCEL_REQUEST, updated_at: new Date() },
        include: orderInclude,
      });

      return updated;
    });

    void input;
    return serializeOrder(order);
  },

  async list(clientId: number, actor: AuthenticatedUser, query: OrderListQuery) {
    const skip = (query.page - 1) * query.page_size;

    const where = {
      buyer_id: BigInt(actor.id),
      ...(query.status ? { order_status: query.status } : {}),
    };

    const [items, total] = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
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

  async getById(clientId: number, orderId: number, actor: AuthenticatedUser) {
    const order = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      }),
    );

    if (!order) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
    }

    if (Number(order.buyer_id) !== actor.id) {
      throw new HttpError(403, 'FORBIDDEN', 'No tienes permiso sobre este pedido');
    }

    return serializeOrder(order);
  },

  async confirmReceipt(clientId: number, orderId: number, actor: AuthenticatedUser) {
    const order = await withTenant(clientId, 'BUYER', async (tx) => {
      const existing = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (Number(existing.buyer_id) !== actor.id) {
        throw new HttpError(403, 'FORBIDDEN', 'No tienes permiso sobre este pedido');
      }

      assertTransition(
        existing.order_status as OrderStatus,
        OrderStatus.CONFIRMED_BY_CUSTOMER,
        'BUYER',
      );

      // DELIVERED → CONFIRMED_BY_CUSTOMER → COMPLETED_SUCCESSFULLY → CLOSED (cadena atómica)
      await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.CONFIRMED_BY_CUSTOMER, updated_at: new Date() },
      });

      await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.COMPLETED_SUCCESSFULLY, updated_at: new Date() },
      });

      const updated = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: {
          order_status: OrderStatus.CLOSED,
          closure_reason: 'COMPLETED_SUCCESSFULLY',
          closed_at: new Date(),
          updated_at: new Date(),
        },
        include: orderInclude,
      });

      return updated;
    });

    return serializeOrder(order);
  },
};

export { createOrderSchema, confirmOrderSchema, cancelOrderSchema };

// ── F2.2.BACK-3 — createApiClientOrder ───────────────────────────────────────

import { createApiOrderSchema } from '@orkoruta/shared';
import { logger } from '../../lib/logger.js';
import { processWebhookEvent } from '../webhooks_outgoing.service.js';
import { getMaintenanceBoss } from '../../jobs/maintenance_boss.js';

export type CreateApiOrderInput = z.infer<typeof createApiOrderSchema>;

/**
 * Crea un pedido para un Cliente API (máquina-a-máquina).
 *
 * - Solo para clientes con `client_type = 'API'`. Si es FULL → 422.
 * - El pedido entra directamente en `initial_state` (sin pasar por DRAFT).
 * - Los ítems son datos flat (no referencias al catálogo de RUTA).
 * - buyer_id usa el usuario que creó la API key (createdByUserId) como
 *   referencia en BD. En onboarding de Cliente API se crea un usuario
 *   sistema dedicado para este propósito.
 */
export async function createApiClientOrder(
  clientId: bigint,
  input: CreateApiOrderInput,
  apiKeyId: bigint,
  createdByUserId: bigint,
): Promise<ReturnType<typeof serializeOrder>> {
  // Validar que el cliente es de tipo API
  const client = await withTenantReadOnly(Number(clientId), 'ADMIN_RUTA', (tx) =>
    tx.clients.findUnique({
      where: { id: clientId },
      select: { client_type: true },
    })
  );

  if (!client) {
    throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Cliente no encontrado');
  }

  if (client.client_type !== 'API') {
    throw new HttpError(422, 'LOGISTICS_ONLY_FEATURE_UNAVAILABLE', 'Esta función solo aplica para Clientes API');
  }

  // Validar input (ya parseado, pero re-valida por seguridad)
  const validated = createApiOrderSchema.parse(input);

  // Mapear payment_method del schema API a valores de BD
  const dbPaymentMethod = validated.payment_method === 'PREPAID_EXTERNAL' ? 'EXTERNAL_PREPAID' : 'CASH_ON_DELIVERY';

  // Determinar payment_status según payment_method
  const paymentStatus =
    validated.payment_method === 'PREPAID_EXTERNAL'
      ? PaymentStatus.PAID
      : PaymentStatus.PENDING_COLLECTION; // COD

  // Calcular subtotal desde los ítems (unit_price_cents → COP decimales)
  let subtotal = 0;
  const items = validated.items.map((item) => {
    const unitPrice = item.unit_price_cents / 100;
    const lineSubtotal = unitPrice * item.quantity;
    subtotal += lineSubtotal;
    return {
      product_name: item.name,
      sku: item.external_sku ?? null,
      quantity: item.quantity,
      unit_price: unitPrice,
      subtotal: lineSubtotal,
    };
  });

  const addr = validated.delivery_address;

  const order = await withTenant(Number(clientId), 'ADMIN_CLIENT', async (tx) => {
    // Insertar el pedido directamente en initial_state
    const created = await tx.orders.create({
      data: {
        client_id: clientId,
        buyer_id: createdByUserId, // FK sentinel: usuario admin que creó la API key
        order_origin: 'API_LOGISTICS',
        order_status: validated.initial_state,
        payment_status: paymentStatus,
        refund_status: 'REFUND_NOT_REQUIRED',
        delivery_type: validated.delivery_type,
        payment_method: dbPaymentMethod,
        buyer_type: 'CORPORATE',
        subtotal,
        total: subtotal,
        currency: 'COP',
        submitted_at: new Date(),
        pickup_point_id: validated.pickup_point_id ? BigInt(String(validated.pickup_point_id)) : null,
        // Dirección de entrega si es SHIP
        delivery_address_line: addr?.street ?? null,
        delivery_address_city: addr?.city ?? null,
        delivery_address_state: addr?.state ?? null,
        delivery_address_postal_code: addr?.postal_code ?? null,
        delivery_address_latitude: addr?.coordinates?.lat ?? null,
        delivery_address_longitude: addr?.coordinates?.lng ?? null,
        // external_reference y customer_info van en metadata de order_state_history
        order_items: {
          create: items,
        },
      },
      include: orderInclude,
    });

    // Registrar estado inicial en order_state_history
    await tx.order_state_history.create({
      data: {
        client_id: clientId,
        order_id: created.id,
        state_dimension: 'order_status',
        previous_value: null,
        new_value: validated.initial_state,
        changed_by_actor_type: 'API_CLIENT',
        metadata: {
          api_key_id: String(apiKeyId),
          external_reference: validated.external_reference ?? null,
          customer_info: validated.customer_info ?? null,
          notes: validated.notes ?? null,
        },
      },
    });

    return created;
  });

  // Auditar la creación (fire-and-forget)
  setImmediate(() => {
    withTenant(Number(clientId), 'ADMIN_CLIENT', (tx) =>
      tx.audit_events.create({
        data: {
          client_id: clientId,
          actor_api_key_id: apiKeyId,
          actor_type: 'API_CLIENT',
          action: 'ORDER_CREATED',
          entity_type: 'orders',
          entity_id: order.id,
          result: 'SUCCESS',
          metadata: {
            initial_state: validated.initial_state,
            external_reference: validated.external_reference ?? null,
          },
        },
      })
    ).catch((err: unknown) => {
      logger.warn({ err, clientId }, 'createApiClientOrder: error auditando ORDER_CREATED');
    });
  });

  // F2.BACK-6 — ORDER_CREATED webhook (fire-and-forget)
  const boss = getMaintenanceBoss();
  if (boss) {
    const webhookPayload = {
      event_type: 'ORDER_CREATED',
      client_id: Number(clientId),
      order_id: Number(order.id),
      timestamp: new Date().toISOString(),
      data: {
        order_status: validated.initial_state,
        delivery_type: validated.delivery_type,
        payment_method: validated.payment_method,
        external_reference: validated.external_reference ?? null,
      },
    };
    setImmediate(() => {
      processWebhookEvent('ORDER_CREATED', webhookPayload, Number(clientId), boss).catch((err: unknown) => {
        logger.warn({ err, clientId: String(clientId) }, 'createApiClientOrder: error emitiendo ORDER_CREATED webhook');
      });
    });
  }

  logger.info({ clientId: String(clientId), orderId: String(order.id), initial_state: validated.initial_state }, 'Pedido API creado');

  return serializeOrder(order);
}
