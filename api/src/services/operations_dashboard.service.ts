/**
 * Dashboard operativo del Cliente: qué falta por entregar y qué se entregó en
 * un rango de fechas.
 *
 * Fechas (todas en días calendario de Bogotá):
 *  - **Por entregar**: el día que cuenta es el de entrega programado
 *    (`scheduled_delivery_date`). Un pedido vivo sin día programado cuenta por
 *    el día en que se creó, para que no desaparezca del tablero.
 *    Lo que quedó de días anteriores al rango y sigue sin entregarse es
 *    «atrasado»: siempre se cuenta, y se lista solo si se pide
 *    (`include_backlog`).
 *  - **Entregados**: el día que cuenta es el de la entrega (`delivered_at`).
 *    Los pedidos antiguos que llegaron a estado entregado sin esa marca usan su
 *    última actualización.
 *
 * Solo lectura. RUTA no custodia dinero (regla 4.1): los montos son el valor de
 * los pedidos, no dinero recibido por RUTA.
 */

import { z } from 'zod';
import { withTenantReadOnly } from '@orkoruta/db';
import { OrderStatus, startOfBogotaDay, endOfBogotaDayExclusive } from '@orkoruta/shared';
import { DATE_ONLY_PATTERN, fromDateOnly, toDateOnly } from './orders/delivery_schedule.js';
import { NOT_DISPATCHED, DELIVERED_LIKE } from './operations_reports.service.js';
import { HttpError } from '../lib/http_error.js';

// ── Schema ────────────────────────────────────────────────────────────────────

const dateOnly = z.string().regex(DATE_ONLY_PATTERN, 'La fecha debe tener el formato YYYY-MM-DD');

export const operationsDashboardQuerySchema = z.object({
  date_from: dateOnly.optional(),
  date_to: dateOnly.optional(),
  courier_id: z.coerce.number().int().positive().optional(),
  delivery_type: z.enum(['SHIP', 'PICKUP']).optional(),
  include_backlog: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

export type OperationsDashboardQuery = z.infer<typeof operationsDashboardQuerySchema>;

/** Tope de pedidos listados por sección; los totales se calculan con todos. */
export const DASHBOARD_ORDER_LIST_LIMIT = 300;

// ── Estados ───────────────────────────────────────────────────────────────────

/** Ni por entregar ni entregados: no salen, ya salieron o se cerraron sin entrega. */
const NOT_PENDING: string[] = [
  ...NOT_DISPATCHED,
  ...DELIVERED_LIKE,
  OrderStatus.PICKUP_EXPIRED,
  OrderStatus.DELIVERY_DISPUTED,
];

/** Estados de entrega para el respaldo de pedidos sin `delivered_at`. */
const DELIVERED_WITHOUT_STAMP: string[] = [...DELIVERED_LIKE].filter((s) => s !== OrderStatus.CLOSED);

// ── Utilidades de fecha ───────────────────────────────────────────────────────

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Día calendario de Bogotá de un instante. */
export function bogotaDay(instant: Date): string {
  return new Date(instant.getTime() - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
}

export function todayInBogota(now: Date = new Date()): string {
  return bogotaDay(now);
}

// ── Tipos de salida ───────────────────────────────────────────────────────────

const orderSelect = {
  id: true,
  order_status: true,
  payment_status: true,
  payment_method: true,
  delivery_type: true,
  total: true,
  scheduled_delivery_date: true,
  created_at: true,
  updated_at: true,
  delivered_at: true,
  delivery_address_line: true,
  delivery_address_city: true,
  courier_user_id: true,
  users_orders_buyer_id_client_idTousers: { select: { full_name: true, email: true, phone: true } },
  users_orders_courier_user_id_client_idTousers: { select: { id: true, full_name: true } },
  order_items: {
    select: { product_id: true, product_name: true, sku: true, quantity: true, subtotal: true },
    orderBy: { id: 'asc' as const },
  },
} as const;

type OrderRow = {
  id: bigint;
  order_status: string;
  payment_status: string;
  payment_method: string;
  delivery_type: string;
  total: unknown;
  scheduled_delivery_date: Date | null;
  created_at: Date;
  updated_at: Date;
  delivered_at: Date | null;
  delivery_address_line: string | null;
  delivery_address_city: string | null;
  courier_user_id: bigint | null;
  users_orders_buyer_id_client_idTousers: { full_name: string | null; email: string; phone: string | null };
  users_orders_courier_user_id_client_idTousers: { id: bigint; full_name: string | null } | null;
  order_items: {
    product_id: bigint | null;
    product_name: string;
    sku: string | null;
    quantity: number;
    subtotal: unknown;
  }[];
};

export interface DashboardOrder {
  id: number;
  order_status: string;
  payment_status: string;
  payment_method: string;
  delivery_type: string;
  buyer_name: string;
  buyer_phone: string | null;
  courier_id: number | null;
  courier_name: string | null;
  address: string | null;
  total: number;
  units: number;
  scheduled_delivery_date: string | null;
  created_at: string;
  delivered_at: string | null;
  /** Día que la ubica en el tablero (entrega programada, creación o entrega). */
  day: string;
  /** Por entregar con día anterior al rango. */
  overdue: boolean;
  items: { product_name: string; sku: string | null; quantity: number }[];
}

interface Bucket {
  count: number;
  total_amount: number;
}

// ── Agregados ─────────────────────────────────────────────────────────────────

function toDashboardOrder(o: OrderRow, day: string, overdue: boolean): DashboardOrder {
  const buyer = o.users_orders_buyer_id_client_idTousers;
  const courier = o.users_orders_courier_user_id_client_idTousers;
  return {
    id: Number(o.id),
    order_status: o.order_status,
    payment_status: o.payment_status,
    payment_method: o.payment_method,
    delivery_type: o.delivery_type,
    buyer_name: buyer.full_name ?? buyer.email,
    buyer_phone: buyer.phone,
    courier_id: courier ? Number(courier.id) : null,
    courier_name: courier?.full_name ?? null,
    address: [o.delivery_address_line, o.delivery_address_city].filter(Boolean).join(', ') || null,
    total: Number(o.total),
    units: o.order_items.reduce((acc, i) => acc + i.quantity, 0),
    scheduled_delivery_date: toDateOnly(o.scheduled_delivery_date),
    created_at: o.created_at.toISOString(),
    delivered_at: o.delivered_at?.toISOString() ?? null,
    day,
    overdue,
    items: o.order_items.map((i) => ({ product_name: i.product_name, sku: i.sku, quantity: i.quantity })),
  };
}

function summarize(orders: OrderRow[], dayOf: (o: OrderRow) => string) {
  const byStatus = new Map<string, Bucket>();
  const byCourier = new Map<string, Bucket & { courier_id: number | null; courier_name: string }>();
  const byDay = new Map<string, Bucket>();
  const byPayment = new Map<string, Bucket>();
  const products = new Map<
    string,
    { product_id: number | null; product_name: string; sku: string | null; quantity: number; orders: number; amount: number }
  >();

  let totalAmount = 0;
  let units = 0;

  const add = <K>(map: Map<K, Bucket>, key: K, amount: number, init?: () => Bucket) => {
    const b = map.get(key) ?? (init ? init() : { count: 0, total_amount: 0 });
    b.count += 1;
    b.total_amount += amount;
    map.set(key, b);
  };

  for (const o of orders) {
    const amount = Number(o.total);
    totalAmount += amount;

    add(byStatus, o.order_status, amount);
    add(byDay, dayOf(o), amount);
    add(byPayment, o.payment_method, amount);

    const courier = o.users_orders_courier_user_id_client_idTousers;
    const courierKey = courier ? courier.id.toString() : 'none';
    add(byCourier as Map<string, Bucket>, courierKey, amount, () => ({
      count: 0,
      total_amount: 0,
      courier_id: courier ? Number(courier.id) : null,
      courier_name: courier ? courier.full_name ?? `Repartidor #${courier.id}` : 'Sin repartidor',
    }));

    const seen = new Set<string>();
    for (const item of o.order_items) {
      const key = item.product_id !== null ? `p:${item.product_id}` : `n:${item.product_name.toLowerCase()}`;
      const row =
        products.get(key) ??
        {
          product_id: item.product_id !== null ? Number(item.product_id) : null,
          product_name: item.product_name,
          sku: item.sku,
          quantity: 0,
          orders: 0,
          amount: 0,
        };
      row.quantity += item.quantity;
      row.amount += Number(item.subtotal);
      if (!seen.has(key)) {
        row.orders += 1;
        seen.add(key);
      }
      products.set(key, row);
      units += item.quantity;
    }
  }

  const sortByCount = <T extends Bucket>(rows: T[]) => rows.sort((a, b) => b.count - a.count);

  return {
    count: orders.length,
    total_amount: totalAmount,
    units,
    by_status: sortByCount([...byStatus].map(([status, b]) => ({ status, ...b }))),
    by_courier: [...byCourier.values()].sort((a, b) => {
      if (a.courier_id === null) return 1;
      if (b.courier_id === null) return -1;
      return b.count - a.count;
    }),
    by_day: [...byDay].map(([date, b]) => ({ date, ...b })).sort((a, b) => a.date.localeCompare(b.date)),
    by_payment_method: sortByCount([...byPayment].map(([payment_method, b]) => ({ payment_method, ...b }))),
    products: [...products.values()].sort((a, b) => b.quantity - a.quantity),
  };
}

// ── Servicio ──────────────────────────────────────────────────────────────────

export const operationsDashboardService = {
  async getOperations(clientId: number, query: OperationsDashboardQuery, now: Date = new Date()) {
    const today = todayInBogota(now);
    const dateFrom = query.date_from ?? query.date_to ?? today;
    const dateTo = query.date_to ?? dateFrom;
    if (dateFrom > dateTo) {
      throw new HttpError(422, 'VALIDATION_ERROR', 'La fecha inicial debe ser anterior o igual a la final');
    }

    const fromDay = fromDateOnly(dateFrom)!;
    const toDay = fromDateOnly(dateTo)!;
    if (Number.isNaN(fromDay.getTime()) || Number.isNaN(toDay.getTime())) {
      throw new HttpError(422, 'VALIDATION_ERROR', 'La fecha no existe');
    }
    const rangeStart = startOfBogotaDay(dateFrom);
    const rangeEnd = endOfBogotaDayExclusive(dateTo);

    const common = {
      client_id: BigInt(clientId),
      ...(query.courier_id ? { courier_user_id: BigInt(query.courier_id) } : {}),
      ...(query.delivery_type ? { delivery_type: query.delivery_type } : {}),
    };

    const [pendingRows, deliveredRows] = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      Promise.all([
        // Todo lo vivo hasta el fin del rango (incluye lo atrasado); se reparte abajo.
        tx.orders.findMany({
          where: {
            ...common,
            delivered_at: null,
            order_status: { notIn: NOT_PENDING },
            OR: [
              { scheduled_delivery_date: { lte: toDay } },
              { scheduled_delivery_date: null, created_at: { lt: rangeEnd } },
            ],
          },
          select: orderSelect,
          orderBy: [{ scheduled_delivery_date: 'asc' }, { id: 'asc' }],
        }),
        tx.orders.findMany({
          where: {
            ...common,
            OR: [
              { delivered_at: { gte: rangeStart, lt: rangeEnd } },
              {
                delivered_at: null,
                order_status: { in: DELIVERED_WITHOUT_STAMP },
                updated_at: { gte: rangeStart, lt: rangeEnd },
              },
            ],
          },
          select: orderSelect,
          orderBy: [{ delivered_at: 'desc' }, { id: 'desc' }],
        }),
      ]),
    );

    // ── Por entregar ──
    const pendingDay = (o: OrderRow) =>
      toDateOnly(o.scheduled_delivery_date) ?? bogotaDay(o.created_at);

    const inRange: OrderRow[] = [];
    const backlog: OrderRow[] = [];
    for (const o of pendingRows as OrderRow[]) {
      (pendingDay(o) < dateFrom ? backlog : inRange).push(o);
    }
    const pendingListed = query.include_backlog ? [...backlog, ...inRange] : inRange;

    const pendingSummary = summarize(pendingListed, pendingDay);
    const backlogAmount = backlog.reduce((acc, o) => acc + Number(o.total), 0);

    // ── Entregados ──
    const deliveredDay = (o: OrderRow) => bogotaDay(o.delivered_at ?? o.updated_at);
    const delivered = deliveredRows as OrderRow[];
    const deliveredSummary = summarize(delivered, deliveredDay);

    return {
      date_from: dateFrom,
      date_to: dateTo,
      today,
      include_backlog: query.include_backlog,
      pending: {
        ...pendingSummary,
        backlog_count: backlog.length,
        backlog_amount: backlogAmount,
        undated_count: pendingListed.filter((o) => o.scheduled_delivery_date === null).length,
        truncated: pendingListed.length > DASHBOARD_ORDER_LIST_LIMIT,
        orders: pendingListed
          .slice(0, DASHBOARD_ORDER_LIST_LIMIT)
          .map((o) => toDashboardOrder(o, pendingDay(o), pendingDay(o) < dateFrom)),
      },
      delivered: {
        ...deliveredSummary,
        truncated: delivered.length > DASHBOARD_ORDER_LIST_LIMIT,
        orders: delivered
          .slice(0, DASHBOARD_ORDER_LIST_LIMIT)
          .map((o) => toDashboardOrder(o, deliveredDay(o), false)),
      },
    };
  },
};
