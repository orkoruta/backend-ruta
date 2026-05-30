import { withTenantReadOnly } from '@orkoruta/db';

export interface OrdersByStatus {
  status: string;
  count: number;
}

export interface ClientMetrics {
  orders_today: number;
  orders_by_status: OrdersByStatus[];
  revenue_last_7_days: number;
  active_couriers: number;
  registered_buyers: number;
}

type OrderStatusRow = { order_status: string; count: bigint };
type CountRow = { count: bigint };
type RevenueRow = { revenue: string | null };

export const metricsService = {
  async getClientMetrics(clientId: number): Promise<ClientMetrics> {
    return withTenantReadOnly(clientId, 'ADMIN_CLIENT', async (tx) => {
      // Orders today
      const [todayRow] = await tx.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::bigint AS count
        FROM ruta.orders
        WHERE client_id = ${BigInt(clientId)}
          AND created_at >= DATE_TRUNC('day', NOW())
      `;
      const orders_today = Number(todayRow?.count ?? 0);

      // Orders by status
      const statusRows = await tx.$queryRaw<OrderStatusRow[]>`
        SELECT order_status, COUNT(*)::bigint AS count
        FROM ruta.orders
        WHERE client_id = ${BigInt(clientId)}
        GROUP BY order_status
        ORDER BY order_status
      `;
      const orders_by_status: OrdersByStatus[] = statusRows.map((r) => ({
        status: r.order_status,
        count: Number(r.count),
      }));

      // Revenue last 7 days (terminal/confirmed statuses)
      const [revenueRow] = await tx.$queryRaw<RevenueRow[]>`
        SELECT COALESCE(SUM(total), 0)::text AS revenue
        FROM ruta.orders
        WHERE client_id = ${BigInt(clientId)}
          AND order_status IN ('CLOSED', 'CONFIRMED_BY_SYSTEM', 'CONFIRMED_BY_CUSTOMER')
          AND created_at >= NOW() - INTERVAL '7 days'
      `;
      const revenue_last_7_days = parseFloat(revenueRow?.revenue ?? '0');

      // Active couriers
      const [courierRow] = await tx.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::bigint AS count
        FROM ruta.users
        WHERE client_id = ${BigInt(clientId)}
          AND user_type = 'COURIER'
          AND status = 'ACTIVE'
      `;
      const active_couriers = Number(courierRow?.count ?? 0);

      // Registered active buyers
      const [buyerRow] = await tx.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::bigint AS count
        FROM ruta.users
        WHERE client_id = ${BigInt(clientId)}
          AND user_type = 'BUYER'
          AND status = 'ACTIVE'
      `;
      const registered_buyers = Number(buyerRow?.count ?? 0);

      return {
        orders_today,
        orders_by_status,
        revenue_last_7_days,
        active_couriers,
        registered_buyers,
      };
    });
  },
};
