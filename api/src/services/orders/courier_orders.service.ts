import { OrderStatus, PaymentStatus } from '@orkoruta/shared';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from '../../lib/http_error.js';
import { assertTransition } from './state_machine.js';
import { z } from 'zod';

// ── Schemas ───────────────────────────────────────────────────────────────────

export const courierOrdersQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

export const failedAttemptSchema = z.object({
  reason: z.string().min(1, 'La razón del intento fallido es requerida'),
  notes: z.string().max(500).optional(),
});

export type CourierOrdersQuery = z.infer<typeof courierOrdersQuerySchema>;
export type FailedAttemptInput = z.infer<typeof failedAttemptSchema>;

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

// Active statuses for a courier's current work
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

// ── COD payment methods ───────────────────────────────────────────────────────

const COD_PAYMENT_METHODS = new Set(['CASH_ON_DELIVERY', 'ELECTRONIC_ON_DELIVERY']);

// ── Service ───────────────────────────────────────────────────────────────────

export const courierOrdersService = {
  /**
   * GET /courier/orders/assigned — lista paginada de pedidos del courier
   */
  async getCourierOrders(clientId: number, courierId: number, query: CourierOrdersQuery) {
    const skip = (query.page - 1) * query.page_size;

    const where = {
      courier_user_id: BigInt(courierId),
      ...(query.status ? { order_status: query.status } : {}),
    };

    const [items, total] = await withTenantReadOnly(clientId, 'COURIER', (tx) =>
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

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const completedToday = await withTenantReadOnly(clientId, 'COURIER', (tx) =>
      tx.orders.count({
        where: {
          courier_user_id: BigInt(courierId),
          order_status: OrderStatus.DELIVERED,
          delivered_at: { gte: today },
        },
      }),
    );

    const active = items
      .filter((o) => ACTIVE_STATUSES.includes(o.order_status))
      .map(serializeOrder);

    return {
      active,
      completed_today: completedToday,
      data: items.map(serializeOrder),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },

  /**
   * GET /courier/orders/:id — detalle de un pedido del courier
   */
  async getCourierOrderById(clientId: number, courierId: number, orderId: number) {
    const order = await withTenantReadOnly(clientId, 'COURIER', (tx) =>
      tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      }),
    );

    if (!order) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
    }

    if (order.courier_user_id === null || Number(order.courier_user_id) !== courierId) {
      throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
    }

    return serializeOrder(order);
  },

  /**
   * POST /courier/orders/:id/start-shipping — COURIER_ASSIGNED → SHIPPED → IN_TRANSIT
   */
  async startShipping(clientId: number, courierId: number, orderId: number) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      assertTransition(order.order_status as OrderStatus, OrderStatus.SHIPPED, 'COURIER');

      // COURIER_ASSIGNED → SHIPPED → IN_TRANSIT (cadena per flujo 2)
      await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.SHIPPED, updated_at: new Date() },
      });

      const updated = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.IN_TRANSIT, updated_at: new Date() },
        include: orderInclude,
      });

      return serializeOrder(updated);
    });
  },

  /**
   * POST /courier/orders/:id/mark-out-for-delivery — IN_TRANSIT → OUT_FOR_DELIVERY
   */
  async markOutForDelivery(clientId: number, courierId: number, orderId: number) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      assertTransition(order.order_status as OrderStatus, OrderStatus.OUT_FOR_DELIVERY, 'COURIER');

      const updated = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.OUT_FOR_DELIVERY, updated_at: new Date() },
        include: orderInclude,
      });

      return serializeOrder(updated);
    });
  },

  /**
   * POST /courier/orders/:id/arrive — OUT_FOR_DELIVERY → ARRIVED_AT_CUSTOMER
   */
  async arrive(clientId: number, courierId: number, orderId: number) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      assertTransition(order.order_status as OrderStatus, OrderStatus.ARRIVED_AT_CUSTOMER, 'COURIER');

      const updated = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.ARRIVED_AT_CUSTOMER, updated_at: new Date() },
        include: orderInclude,
      });

      return serializeOrder(updated);
    });
  },

  /**
   * POST /courier/orders/:id/mark-delivered — → DELIVERED
   * Si payment_method es ON_DELIVERY, exige cobro previo (PAYMENT_COLLECTED)
   */
  async markDelivered(clientId: number, courierId: number, orderId: number) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      assertTransition(order.order_status as OrderStatus, OrderStatus.DELIVERED, 'COURIER', {
        paymentStatus: order.payment_status,
      });

      const updated = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: {
          order_status: OrderStatus.DELIVERED,
          delivered_at: new Date(),
          updated_at: new Date(),
        },
        include: orderInclude,
      });

      return serializeOrder(updated);
    });
  },

  /**
   * POST /courier/orders/:id/attempt-failed — OUT_FOR_DELIVERY → DELIVERY_ATTEMPTED
   */
  async recordFailedAttempt(
    clientId: number,
    courierId: number,
    orderId: number,
    input: FailedAttemptInput,
  ) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      assertTransition(order.order_status as OrderStatus, OrderStatus.DELIVERY_ATTEMPTED, 'COURIER');

      const updated = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.DELIVERY_ATTEMPTED, updated_at: new Date() },
        include: orderInclude,
      });

      void input; // reason/notes se puede persistir en audit_events (Sprint 6)
      return serializeOrder(updated);
    });
  },

  /**
   * POST /courier/orders/:id/return-to-origin — solicitar retorno al origen
   * Transición válida desde DELIVERY_ATTEMPTED, PAYMENT_COLLECTION_PENDING, CASH_PAYMENT_REJECTED
   */
  async returnToOrigin(clientId: number, courierId: number, orderId: number) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        include: orderInclude,
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      assertTransition(order.order_status as OrderStatus, OrderStatus.RETURN_TO_ORIGIN, 'COURIER');

      const updated = await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { order_status: OrderStatus.RETURN_TO_ORIGIN, updated_at: new Date() },
        include: orderInclude,
      });

      return serializeOrder(updated);
    });
  },
};

export { COD_PAYMENT_METHODS };
