import { z } from 'zod';
import { OrderStatus } from '@orkoruta/shared';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from '../../lib/http_error.js';
import { assertTransition } from './state_machine.js';
import type { AuthenticatedUser } from '../../middleware/auth.js';
import type { TransitionActor } from './state_machine.js';

// States that make a courier unavailable for assignment
const COURIER_BUSY_STATUSES: string[] = [
  OrderStatus.COURIER_ASSIGNED,
  OrderStatus.SHIPPED,
  OrderStatus.IN_TRANSIT,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.ARRIVED_AT_CUSTOMER,
];

export const assignCourierSchema = z.object({
  courier_user_id: z.number().int().positive(),
});

export type AssignCourierInput = z.infer<typeof assignCourierSchema>;

function toTransitionActor(userType: string): TransitionActor {
  if (userType === 'ADMIN_RUTA') return 'ADMIN_RUTA';
  if (userType === 'OPERATOR_CLIENT') return 'OPERATOR_CLIENT';
  return 'ADMIN_CLIENT';
}

export const courierAssignmentService = {
  async assignCourier(
    clientId: number,
    orderId: number,
    courierUserId: number,
    actingUser: AuthenticatedUser,
  ) {
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

      assertTransition(order.order_status as OrderStatus, OrderStatus.COURIER_ASSIGNED, actor);

      const courier = await tx.users.findUnique({
        where: { id_client_id: { id: BigInt(courierUserId), client_id: BigInt(clientId) } },
        select: {
          id: true,
          client_id: true,
          user_type: true,
          status: true,
          full_name: true,
          email: true,
          phone: true,
        },
      });

      if (!courier) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Repartidor no encontrado');
      }

      // Defensive cross-tenant check (composite key guarantees this in production)
      if (Number(courier.client_id) !== clientId) {
        throw new HttpError(403, 'FORBIDDEN', 'El repartidor pertenece a otro cliente');
      }

      if (courier.user_type !== 'COURIER') {
        throw new HttpError(422, 'VALIDATION_ERROR', 'El usuario no es un repartidor');
      }

      if (courier.status !== 'ACTIVE') {
        throw new HttpError(422, 'VALIDATION_ERROR', 'El repartidor no está activo');
      }

      const result = await tx.orders.updateMany({
        where: {
          id: BigInt(orderId),
          client_id: BigInt(clientId),
          version: order.version,
        },
        data: {
          order_status: OrderStatus.COURIER_ASSIGNED,
          courier_user_id: BigInt(courierUserId),
          version: { increment: 1 },
          updated_at: new Date(),
        },
      });

      if (result.count === 0) {
        throw new HttpError(
          409,
          'OPTIMISTIC_LOCK_FAILED',
          'El pedido fue modificado por otro proceso simultáneo',
        );
      }

      return {
        id: Number(order.id),
        client_id: Number(order.client_id),
        order_status: OrderStatus.COURIER_ASSIGNED,
        courier_user_id: courierUserId,
        courier: {
          id: Number(courier.id),
          full_name: courier.full_name,
          email: courier.email,
          phone: courier.phone,
        },
      };
    });
  },

  async unassignCourier(
    clientId: number,
    orderId: number,
    actingUser: AuthenticatedUser,
  ) {
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

      assertTransition(
        order.order_status as OrderStatus,
        OrderStatus.AWAITING_COURIER_ASSIGNMENT,
        actor,
      );

      const result = await tx.orders.updateMany({
        where: {
          id: BigInt(orderId),
          client_id: BigInt(clientId),
          version: order.version,
        },
        data: {
          order_status: OrderStatus.AWAITING_COURIER_ASSIGNMENT,
          courier_user_id: null,
          version: { increment: 1 },
          updated_at: new Date(),
        },
      });

      if (result.count === 0) {
        throw new HttpError(
          409,
          'OPTIMISTIC_LOCK_FAILED',
          'El pedido fue modificado por otro proceso simultáneo',
        );
      }

      return {
        id: Number(order.id),
        client_id: Number(order.client_id),
        order_status: OrderStatus.AWAITING_COURIER_ASSIGNMENT,
        courier_user_id: null,
      };
    });
  },

  async getAvailableCouriers(clientId: number) {
    const couriers = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.users.findMany({
        where: {
          user_type: 'COURIER',
          status: 'ACTIVE',
          orders_orders_courier_user_id_client_idTousers: {
            none: {
              order_status: { in: COURIER_BUSY_STATUSES },
            },
          },
        },
        select: {
          id: true,
          client_id: true,
          full_name: true,
          email: true,
          phone: true,
          status: true,
        },
      }),
    );

    return couriers.map((c) => ({
      id: Number(c.id),
      client_id: Number(c.client_id),
      full_name: c.full_name,
      email: c.email,
      phone: c.phone,
      status: c.status,
    }));
  },

  async getOrdersForMap(clientId: number) {
    const orders = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.orders.findMany({
        where: {
          order_status: OrderStatus.AWAITING_COURIER_ASSIGNMENT,
          delivery_address_latitude: { not: null },
          delivery_address_longitude: { not: null },
        },
        select: {
          id: true,
          client_id: true,
          order_status: true,
          delivery_address_line: true,
          delivery_address_city: true,
          delivery_address_latitude: true,
          delivery_address_longitude: true,
          buyer_id: true,
          total: true,
          currency: true,
          created_at: true,
        },
      }),
    );

    return orders.map((o) => ({
      id: Number(o.id),
      client_id: Number(o.client_id),
      order_status: o.order_status,
      delivery_address_line: o.delivery_address_line,
      delivery_address_city: o.delivery_address_city,
      latitude: o.delivery_address_latitude ? Number(o.delivery_address_latitude) : null,
      longitude: o.delivery_address_longitude ? Number(o.delivery_address_longitude) : null,
      buyer_id: Number(o.buyer_id),
      total: Number(o.total),
      currency: o.currency,
      created_at: o.created_at.toISOString(),
    }));
  },
};
