import { withTenantReadOnly } from '@orkoruta/db';

export interface ClientsByType {
  client_type: string;
  count: number;
}

export interface OrdersByStatus {
  status: string;
  count: number;
}

export interface GlobalMetrics {
  active_clients_by_type: ClientsByType[];
  orders_today: number;
  orders_by_status: OrdersByStatus[];
  revenue_last_7_days: number;
}

type ClientTypeRow = { client_type: string; count: bigint };
type CountRow = { count: bigint };
type OrderStatusRow = { order_status: string; count: bigint };
type RevenueRow = { revenue: string | null };

export const globalMetricsService = {
  async getGlobalMetrics(): Promise<GlobalMetrics> {
    return withTenantReadOnly(0, 'ADMIN_RUTA', async (tx) => {
      // Active clients by type (cross-tenant)
      const clientTypeRows = await tx.$queryRaw<ClientTypeRow[]>`
        SELECT client_type, COUNT(*)::bigint AS count
        FROM ruta.clients
        WHERE status = 'ACTIVE'
        GROUP BY client_type
        ORDER BY client_type
      `;
      const active_clients_by_type: ClientsByType[] = clientTypeRows.map((r) => ({
        client_type: r.client_type,
        count: Number(r.count),
      }));

      // Total orders today (cross-tenant)
      const [todayRow] = await tx.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::bigint AS count
        FROM ruta.orders
        WHERE created_at >= DATE_TRUNC('day', NOW())
      `;
      const orders_today = Number(todayRow?.count ?? 0);

      // Orders by status cross-tenant
      const statusRows = await tx.$queryRaw<OrderStatusRow[]>`
        SELECT order_status, COUNT(*)::bigint AS count
        FROM ruta.orders
        GROUP BY order_status
        ORDER BY order_status
      `;
      const orders_by_status: OrdersByStatus[] = statusRows.map((r) => ({
        status: r.order_status,
        count: Number(r.count),
      }));

      // Global revenue last 7 days
      const [revenueRow] = await tx.$queryRaw<RevenueRow[]>`
        SELECT COALESCE(SUM(total), 0)::text AS revenue
        FROM ruta.orders
        WHERE order_status IN ('CLOSED', 'CONFIRMED_BY_SYSTEM', 'CONFIRMED_BY_CUSTOMER')
          AND created_at >= NOW() - INTERVAL '7 days'
      `;
      const revenue_last_7_days = parseFloat(revenueRow?.revenue ?? '0');

      return {
        active_clients_by_type,
        orders_today,
        orders_by_status,
        revenue_last_7_days,
      };
    });
  },
};
