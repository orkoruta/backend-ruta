import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock('@orkoruta/db', () => ({
  withTenantReadOnly: (_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
    fn({ orders: { findMany: dbMock.findMany } }),
}));

import {
  operationsDashboardService,
  bogotaDay,
  operationsDashboardQuerySchema,
} from '../services/operations_dashboard.service.js';

const NOW = new Date('2026-11-12T15:00:00.000Z'); // 10:00 en Bogotá

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    order_status: 'SELLER_CONFIRMED',
    payment_status: 'PAYMENT_NOT_STARTED',
    payment_method: 'CASH_ON_DELIVERY',
    delivery_type: 'SHIP',
    total: '50000',
    scheduled_delivery_date: new Date('2026-11-12T00:00:00.000Z'),
    created_at: new Date('2026-11-11T20:00:00.000Z'),
    updated_at: new Date('2026-11-11T20:00:00.000Z'),
    delivered_at: null,
    delivery_address_line: 'Calle 1 # 2-3',
    delivery_address_city: 'Bogotá',
    courier_user_id: null,
    users_orders_buyer_id_client_idTousers: { full_name: 'Ana', email: 'ana@x.co', phone: '300' },
    users_orders_courier_user_id_client_idTousers: null,
    order_items: [
      { product_id: 10n, product_name: 'Aguacate Hass', sku: 'AG1', quantity: 3, subtotal: '30000' },
      { product_id: null, product_name: 'Bolsa extra', sku: null, quantity: 1, subtotal: '20000' },
    ],
    ...overrides,
  };
}

describe('bogotaDay', () => {
  it('usa el día de Bogotá, no el UTC', () => {
    expect(bogotaDay(new Date('2026-11-13T03:00:00.000Z'))).toBe('2026-11-12');
    expect(bogotaDay(new Date('2026-11-13T05:00:00.000Z'))).toBe('2026-11-13');
  });
});

describe('operationsDashboardQuerySchema', () => {
  it('include_backlog es false si no viene', () => {
    expect(operationsDashboardQuerySchema.parse({}).include_backlog).toBe(false);
  });
});

describe('operationsDashboardService.getOperations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sin fechas usa el día de hoy en Bogotá', async () => {
    dbMock.findMany.mockResolvedValue([]);
    const res = await operationsDashboardService.getOperations(7, { include_backlog: false }, NOW);
    expect(res.date_from).toBe('2026-11-12');
    expect(res.date_to).toBe('2026-11-12');
  });

  it('422 si el rango está invertido', async () => {
    await expect(
      operationsDashboardService.getOperations(
        7,
        { date_from: '2026-11-12', date_to: '2026-11-01', include_backlog: false },
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('separa lo atrasado de lo del rango y solo lo lista si se pide', async () => {
    const today = order({ id: 1n });
    const late = order({ id: 2n, scheduled_delivery_date: new Date('2026-11-10T00:00:00.000Z'), total: '10000' });
    const undated = order({ id: 3n, scheduled_delivery_date: null, created_at: new Date('2026-11-12T14:00:00.000Z') });
    dbMock.findMany.mockResolvedValueOnce([late, today, undated]).mockResolvedValueOnce([]);

    const res = await operationsDashboardService.getOperations(
      7,
      { date_from: '2026-11-12', date_to: '2026-11-12', include_backlog: false },
      NOW,
    );

    expect(res.pending.count).toBe(2);
    expect(res.pending.orders.map((o) => o.id)).toEqual([1, 3]);
    expect(res.pending.backlog_count).toBe(1);
    expect(res.pending.backlog_amount).toBe(10000);
    expect(res.pending.undated_count).toBe(1);
    expect(res.pending.total_amount).toBe(100000);
    expect(res.pending.units).toBe(8);

    dbMock.findMany.mockResolvedValueOnce([late, today, undated]).mockResolvedValueOnce([]);
    const withBacklog = await operationsDashboardService.getOperations(
      7,
      { date_from: '2026-11-12', date_to: '2026-11-12', include_backlog: true },
      NOW,
    );
    expect(withBacklog.pending.count).toBe(3);
    expect(withBacklog.pending.orders.find((o) => o.id === 2)?.overdue).toBe(true);
  });

  it('entregados: agrupa por día de entrega, repartidor, pago y producto', async () => {
    const courier = { id: 5n, full_name: 'Pedro' };
    const d1 = order({
      id: 10n,
      order_status: 'DELIVERED',
      delivered_at: new Date('2026-11-12T02:00:00.000Z'), // 11 nov en Bogotá
      users_orders_courier_user_id_client_idTousers: courier,
    });
    const d2 = order({
      id: 11n,
      order_status: 'CLOSED',
      payment_method: 'ONLINE',
      delivered_at: new Date('2026-11-12T16:00:00.000Z'),
    });
    dbMock.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([d1, d2]);

    const res = await operationsDashboardService.getOperations(
      7,
      { date_from: '2026-11-11', date_to: '2026-11-12', include_backlog: false },
      NOW,
    );

    expect(res.delivered.count).toBe(2);
    expect(res.delivered.total_amount).toBe(100000);
    expect(res.delivered.by_day).toEqual([
      { date: '2026-11-11', count: 1, total_amount: 50000 },
      { date: '2026-11-12', count: 1, total_amount: 50000 },
    ]);
    expect(res.delivered.by_courier[0]).toMatchObject({ courier_id: 5, courier_name: 'Pedro', count: 1 });
    expect(res.delivered.by_courier.at(-1)).toMatchObject({ courier_id: null });
    expect(res.delivered.by_payment_method).toHaveLength(2);
    expect(res.delivered.products[0]).toMatchObject({ product_name: 'Aguacate Hass', quantity: 6, orders: 2 });
    expect(res.delivered.orders[0].items).toEqual([
      { product_name: 'Aguacate Hass', sku: 'AG1', quantity: 3 },
      { product_name: 'Bolsa extra', sku: null, quantity: 1 },
    ]);
  });

  it('aplica filtros de repartidor y tipo de entrega a las dos consultas', async () => {
    dbMock.findMany.mockResolvedValue([]);
    await operationsDashboardService.getOperations(
      7,
      { date_from: '2026-11-12', courier_id: 5, delivery_type: 'PICKUP', include_backlog: false },
      NOW,
    );
    for (const call of dbMock.findMany.mock.calls) {
      expect(call[0].where).toMatchObject({ client_id: 7n, courier_user_id: 5n, delivery_type: 'PICKUP' });
    }
  });
});
