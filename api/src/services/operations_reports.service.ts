/**
 * Reportes operativos del panel del Cliente.
 *
 *  - `dailyDispatch`: qué sale un día — cuántas unidades de cada producto
 *    hay que alistar y qué pedidos son. Es lo que el Cliente hacía a mano
 *    sumando pedido por pedido antes de cargar las cajas.
 *  - `courierCollections`: cuánto cobró cada repartidor en un rango de fechas,
 *    para cuadrar el efectivo con los repartidores al cierre de la semana.
 *
 * Solo lectura. RUTA no custodia dinero (regla 4.1): esto resume cobros que
 * los repartidores registraron como evidencia, nada más.
 */

import { z } from 'zod';
import { withTenantReadOnly } from '@orkoruta/db';
import {
  OrderStatus,
  dateFilterSchema,
  startOfBogotaDay,
  endOfBogotaDayExclusive,
} from '@orkoruta/shared';
import { DATE_ONLY_PATTERN, fromDateOnly } from './orders/delivery_schedule.js';
import { HttpError } from '../lib/http_error.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const dateOnly = z.string().regex(DATE_ONLY_PATTERN, 'La fecha debe tener el formato YYYY-MM-DD');

export const dailyDispatchQuerySchema = z.object({
  date: dateOnly,
});

export const courierCollectionsQuerySchema = z.object({
  date_from: dateFilterSchema,
  date_to: dateFilterSchema,
});

// ── Estados ───────────────────────────────────────────────────────────────────

/**
 * Pedidos que NO salen a despacho: carritos, cancelados, perdidos o devueltos.
 * Un CLOSED cuenta solo si llegó a entregarse (`delivered_at` no nulo).
 */
export const NOT_DISPATCHED: string[] = [
  OrderStatus.DRAFT,
  OrderStatus.PENDING_CONFIRM,
  OrderStatus.EXPIRED,
  OrderStatus.VALIDATION_REJECTED,
  OrderStatus.CANCELLED_BY_CUSTOMER,
  OrderStatus.CANCELLED_BY_SELLER,
  OrderStatus.CANCELLED_BY_SYSTEM,
  OrderStatus.CANCELLED_BY_ADMIN,
  OrderStatus.CANCELLED_NO_PAYMENT,
  OrderStatus.PICKUP_CANCELLED_BY_CUSTOMER,
  OrderStatus.CANCEL_REQUEST_APPROVED,
  OrderStatus.RETURN_TO_ORIGIN,
  OrderStatus.RETURN_TO_ORIGIN_RECEIVED,
  OrderStatus.LOST_IN_TRANSIT,
  OrderStatus.LOST_IN_RETURN,
];

/** Ya entregados (para separar lo pendiente de lo hecho en el resumen). */
export const DELIVERED_LIKE: ReadonlySet<string> = new Set([
  OrderStatus.DELIVERED,
  OrderStatus.PICKED_UP,
  OrderStatus.CONFIRMED_BY_CUSTOMER,
  OrderStatus.CONFIRMED_BY_SYSTEM,
  OrderStatus.COMPLETED_SUCCESSFULLY,
  OrderStatus.CLOSED,
]);

/** Pedidos vivos sin día de entrega: se avisan para que nadie los olvide. */
const ACTIVE_UNDATED_EXCLUDED: string[] = [...NOT_DISPATCHED, ...DELIVERED_LIKE];

function dispatchableWhere(clientId: number) {
  return {
    client_id: BigInt(clientId),
    order_status: { notIn: NOT_DISPATCHED },
    NOT: { order_status: OrderStatus.CLOSED, delivered_at: null },
  };
}

// ── Servicio ──────────────────────────────────────────────────────────────────

export const operationsReportsService = {
  async dailyDispatch(clientId: number, date: string) {
    const day = fromDateOnly(date);
    if (!day || Number.isNaN(day.getTime())) {
      throw new HttpError(422, 'VALIDATION_ERROR', 'La fecha no existe');
    }

    const [orders, undatedPending] = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      Promise.all([
        tx.orders.findMany({
          where: { ...dispatchableWhere(clientId), scheduled_delivery_date: day },
          select: {
            id: true,
            order_status: true,
            buyer_type: true,
            total: true,
            payment_method: true,
            delivery_address_line: true,
            delivery_address_city: true,
            users_orders_buyer_id_client_idTousers: { select: { full_name: true, email: true, phone: true } },
            users_orders_courier_user_id_client_idTousers: { select: { id: true, full_name: true } },
            order_items: {
              select: { product_id: true, product_name: true, sku: true, quantity: true },
            },
          },
          orderBy: { id: 'asc' },
        }),
        tx.orders.count({
          where: {
            client_id: BigInt(clientId),
            order_status: { notIn: ACTIVE_UNDATED_EXCLUDED },
            scheduled_delivery_date: null,
          },
        }),
      ]),
    );

    // Agrupa por producto del catálogo; las líneas libres, por su descripción.
    const products = new Map<
      string,
      { product_id: number | null; product_name: string; sku: string | null; quantity: number; orders: number }
    >();
    let totalUnits = 0;

    for (const order of orders) {
      const seenInOrder = new Set<string>();
      for (const item of order.order_items) {
        const key = item.product_id !== null ? `p:${item.product_id}` : `n:${item.product_name.toLowerCase()}`;
        const row =
          products.get(key) ??
          {
            product_id: item.product_id !== null ? Number(item.product_id) : null,
            product_name: item.product_name,
            sku: item.sku,
            quantity: 0,
            orders: 0,
          };
        row.quantity += item.quantity;
        if (!seenInOrder.has(key)) {
          row.orders += 1;
          seenInOrder.add(key);
        }
        products.set(key, row);
        totalUnits += item.quantity;
      }
    }

    const delivered = orders.filter((o) => DELIVERED_LIKE.has(o.order_status)).length;

    return {
      date,
      orders_count: orders.length,
      delivered_count: delivered,
      pending_count: orders.length - delivered,
      total_units: totalUnits,
      undated_pending_count: undatedPending,
      products: [...products.values()].sort((a, b) => b.quantity - a.quantity),
      orders: orders.map((o) => {
        const buyer = o.users_orders_buyer_id_client_idTousers;
        const courier = o.users_orders_courier_user_id_client_idTousers;
        return {
          id: Number(o.id),
          order_status: o.order_status,
          buyer_type: o.buyer_type,
          buyer_name: buyer.full_name ?? buyer.email,
          buyer_phone: buyer.phone,
          courier_name: courier?.full_name ?? null,
          address: [o.delivery_address_line, o.delivery_address_city].filter(Boolean).join(', ') || null,
          payment_method: o.payment_method,
          total: Number(o.total),
          units: o.order_items.reduce((acc, i) => acc + i.quantity, 0),
          items: o.order_items.map((i) => ({ product_name: i.product_name, quantity: i.quantity })),
        };
      }),
    };
  },

  async courierCollections(clientId: number, dateFrom: string, dateTo: string) {
    const from = startOfBogotaDay(dateFrom);
    const to = endOfBogotaDayExclusive(dateTo);
    if (from >= to) {
      throw new HttpError(422, 'VALIDATION_ERROR', 'La fecha inicial debe ser anterior a la final');
    }

    const payments = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.payments.findMany({
        where: {
          client_id: BigInt(clientId),
          collected_at: { gte: from, lt: to },
          payment_method: { in: ['CASH_ON_DELIVERY', 'ELECTRONIC_ON_DELIVERY'] },
        },
        select: {
          id: true,
          order_id: true,
          amount: true,
          payment_method: true,
          payment_method_submethod: true,
          collected_at: true,
          collected_by_courier_user_id: true,
          collection_evidence: true,
        },
        orderBy: { collected_at: 'asc' },
      }),
    );

    const courierIds = [
      ...new Set(
        payments
          .map((p) => p.collected_by_courier_user_id)
          .filter((id): id is bigint => id !== null)
          .map((id) => id.toString()),
      ),
    ].map((id) => BigInt(id));

    const couriers = courierIds.length
      ? await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
          tx.users.findMany({
            where: { client_id: BigInt(clientId), id: { in: courierIds } },
            select: { id: true, full_name: true, phone: true },
          }),
        )
      : [];
    const courierById = new Map(couriers.map((c) => [c.id.toString(), c]));

    type Group = {
      courier_id: number | null;
      courier_name: string;
      courier_phone: string | null;
      cash_total: number;
      electronic_total: number;
      collections_count: number;
      collections: {
        payment_id: number;
        order_id: number;
        amount: number;
        method: 'CASH' | 'ELECTRONIC';
        collected_at: string;
      }[];
    };

    const groups = new Map<string, Group>();

    for (const p of payments) {
      const courierKey = p.collected_by_courier_user_id?.toString() ?? 'staff';
      const courier = p.collected_by_courier_user_id
        ? courierById.get(p.collected_by_courier_user_id.toString())
        : undefined;

      const group =
        groups.get(courierKey) ??
        {
          courier_id: p.collected_by_courier_user_id ? Number(p.collected_by_courier_user_id) : null,
          courier_name: p.collected_by_courier_user_id
            ? courier?.full_name ?? `Repartidor #${p.collected_by_courier_user_id}`
            : 'Cobrado por el negocio',
          courier_phone: courier?.phone ?? null,
          cash_total: 0,
          electronic_total: 0,
          collections_count: 0,
          collections: [],
        };

      const evidence = (p.collection_evidence ?? {}) as Record<string, unknown>;
      const isCash =
        evidence['method'] === 'CASH' ||
        (evidence['method'] === undefined &&
          p.payment_method === 'CASH_ON_DELIVERY' &&
          !p.payment_method_submethod);
      const amount = Number(p.amount);

      if (isCash) group.cash_total += amount;
      else group.electronic_total += amount;
      group.collections_count += 1;
      group.collections.push({
        payment_id: Number(p.id),
        order_id: Number(p.order_id),
        amount,
        method: isCash ? 'CASH' : 'ELECTRONIC',
        collected_at: p.collected_at!.toISOString(),
      });

      groups.set(courierKey, group);
    }

    const rows = [...groups.values()].sort((a, b) => {
      // El negocio va al final: lo que interesa primero es cada repartidor.
      if (a.courier_id === null) return 1;
      if (b.courier_id === null) return -1;
      return b.cash_total - a.cash_total;
    });

    return {
      date_from: dateFrom,
      date_to: dateTo,
      cash_total: rows.reduce((acc, r) => acc + r.cash_total, 0),
      electronic_total: rows.reduce((acc, r) => acc + r.electronic_total, 0),
      couriers: rows,
    };
  },
};

