import { z } from 'zod';
import { OrderStatus } from '@orkoruta/shared';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from '../../lib/http_error.js';
import { assertTransition } from './state_machine.js';
import type { AuthenticatedUser } from '../../middleware/auth.js';
import type { TransitionActor } from './state_machine.js';
import { logger } from '../../lib/logger.js';
import { resolveParamInt } from '../../lib/parameter_resolver.js';
import { processWebhookEvent } from '../webhooks_outgoing.service.js';
import { getMaintenanceBoss } from '../../jobs/maintenance_boss.js';

// Pedidos en curso que consumen capacidad del repartidor
const COURIER_BUSY_STATUSES: string[] = [
  OrderStatus.COURIER_ASSIGNED,
  OrderStatus.SHIPPED,
  OrderStatus.IN_TRANSIT,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.ARRIVED_AT_CUSTOMER,
];

/**
 * Estados que se pintan en el mapa de asignación: los que esperan repartidor y
 * los que ya lo tienen. El operador necesita ver ambos para decidir a quién
 * asignar — un pedido nuevo se despacha mejor con quien ya va para esa zona.
 */
const MAP_STATUSES: string[] = [
  OrderStatus.AWAITING_COURIER_ASSIGNMENT,
  ...COURIER_BUSY_STATUSES,
];

/** Cuántos pedidos simultáneos admite un repartidor. Configurable por Cliente. */
const MAX_ORDERS_PARAM = 'limits.max_concurrent_orders_per_courier';
const DEFAULT_MAX_ORDERS = 3;

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

      // El límite se valida aquí y no solo al listar: la UI filtra, pero la API
      // es la que debe garantizar que no se sobrecargue a un repartidor.
      const maxConcurrent = await resolveParamInt(clientId, MAX_ORDERS_PARAM, DEFAULT_MAX_ORDERS);
      const activeOrders = await tx.orders.count({
        where: {
          client_id: BigInt(clientId),
          courier_user_id: BigInt(courierUserId),
          order_status: { in: COURIER_BUSY_STATUSES },
        },
      });

      if (activeOrders >= maxConcurrent) {
        throw new HttpError(
          422,
          'VALIDATION_ERROR',
          `El repartidor ya tiene ${activeOrders} pedidos en curso (máximo ${maxConcurrent})`,
        );
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

      const assignResult = {
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

      // F2.BACK-6 — COURIER_ASSIGNED webhook
      const boss = getMaintenanceBoss();
      if (boss) {
        const payload = {
          event_type: 'COURIER_ASSIGNED',
          client_id: clientId,
          order_id: orderId,
          timestamp: new Date().toISOString(),
          data: {
            order_status: OrderStatus.COURIER_ASSIGNED,
            courier_user_id: courierUserId,
          },
        };
        setImmediate(() => {
          processWebhookEvent('COURIER_ASSIGNED', payload, clientId, boss).catch((err: unknown) => {
            logger.warn({ err, clientId, orderId }, 'courier_assignment: error emitiendo COURIER_ASSIGNED webhook');
          });
        });
      }

      return assignResult;
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
    const maxConcurrent = await resolveParamInt(clientId, MAX_ORDERS_PARAM, DEFAULT_MAX_ORDERS);

    const couriers = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.users.findMany({
        where: {
          client_id: BigInt(clientId),
          user_type: 'COURIER',
          status: 'ACTIVE',
        },
        select: {
          id: true,
          client_id: true,
          full_name: true,
          email: true,
          phone: true,
          status: true,
          _count: {
            select: {
              orders_orders_courier_user_id_client_idTousers: {
                where: { order_status: { in: COURIER_BUSY_STATUSES } },
              },
            },
          },
        },
      }),
    );

    // Un repartidor puede llevar varios pedidos a la vez; solo desaparece de la
    // lista cuando alcanza el máximo configurado por el Cliente.
    return couriers
      .map((c) => {
        const activeOrders = c._count.orders_orders_courier_user_id_client_idTousers;
        return {
          id: Number(c.id),
          client_id: Number(c.client_id),
          full_name: c.full_name,
          email: c.email,
          phone: c.phone,
          status: c.status,
          active_orders: activeOrders,
          max_concurrent_orders: maxConcurrent,
          remaining_capacity: Math.max(0, maxConcurrent - activeOrders),
        };
      })
      .filter((c) => c.remaining_capacity > 0)
      .sort((a, b) => b.remaining_capacity - a.remaining_capacity);
  },

  async getOrdersForMap(clientId: number) {
    const orders = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.orders.findMany({
        where: {
          client_id: BigInt(clientId),
          order_status: { in: MAP_STATUSES },
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
          courier_user_id: true,
          users_orders_courier_user_id_client_idTousers: {
            select: { id: true, full_name: true, phone: true },
          },
          total: true,
          currency: true,
          created_at: true,
        },
      }),
    );

    return orders.map((o) => {
      const courier = o.users_orders_courier_user_id_client_idTousers;
      return {
        id: Number(o.id),
        client_id: Number(o.client_id),
        order_status: o.order_status,
        delivery_address_line: o.delivery_address_line,
        delivery_address_city: o.delivery_address_city,
        latitude: o.delivery_address_latitude ? Number(o.delivery_address_latitude) : null,
        longitude: o.delivery_address_longitude ? Number(o.delivery_address_longitude) : null,
        buyer_id: Number(o.buyer_id),
        courier_user_id: o.courier_user_id ? Number(o.courier_user_id) : null,
        courier_name: courier?.full_name ?? null,
        courier_phone: courier?.phone ?? null,
        total: Number(o.total),
        currency: o.currency,
        created_at: o.created_at.toISOString(),
      };
    });
  },
};
