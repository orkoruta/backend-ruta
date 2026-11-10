import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Entrega registrada por el staff del Cliente («lo entregamos nosotros»).
 *
 * Fija: que en contra entrega se registra el cobro a nombre del negocio (sin
 * repartidor) antes de entregar; que un pedido ya pagado no crea otro cobro;
 * que un pago online pendiente o un PICKUP se rechazan; y que la acción queda
 * auditada.
 */

let orderRow: Record<string, unknown>;
const paymentsCreate = vi.fn(async () => ({ id: 1n }));
const ordersUpdateMany = vi.fn(async () => ({ count: 1 }));
const auditCreate = vi.fn(async () => ({}));

vi.mock('@orkoruta/db', () => ({
  withTenant: (_c: number, _r: string, fn: (tx: unknown) => unknown) =>
    fn({
      orders: { findUnique: async () => orderRow, updateMany: ordersUpdateMany },
      payments: { create: paymentsCreate },
      audit_events: { create: auditCreate },
    }),
}));

vi.mock('../jobs/maintenance_boss.js', () => ({ getMaintenanceBoss: () => null }));

const { staffDeliveryService } = await import('../services/orders/staff_delivery.service.js');

const actor = { id: 9, client_id: 7, user_type: 'ADMIN_CLIENT' } as never;

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 42n,
    order_status: 'OUT_FOR_DELIVERY',
    payment_status: 'PENDING_COLLECTION',
    payment_method: 'CASH_ON_DELIVERY',
    delivery_type: 'SHIP',
    total: 48000,
    currency: 'COP',
    version: 3n,
    ...overrides,
  };
}

beforeEach(() => {
  paymentsCreate.mockClear();
  ordersUpdateMany.mockClear();
  auditCreate.mockClear();
});

describe('staffDeliveryService.markDelivered', () => {
  it('contra entrega: registra el cobro del negocio y entrega', async () => {
    orderRow = baseOrder();
    const res = await staffDeliveryService.markDelivered(7, 42, actor, {
      collection_method: 'CASH',
      collected_amount: 48000,
    });

    expect(res.order_status).toBe('DELIVERED');
    expect(paymentsCreate).toHaveBeenCalledTimes(1);
    const payment = (paymentsCreate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(payment['collected_by_courier_user_id']).toBeNull();
    expect(payment['amount']).toBe(48000);

    const update = (ordersUpdateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown>; where: Record<string, unknown> }])[0];
    expect(update.data['order_status']).toBe('DELIVERED');
    expect(update.data['payment_status']).toBe('PAYMENT_COLLECTED');
    expect(update.where['version']).toBe(3n);
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('sin importe, cobra el total del pedido', async () => {
    orderRow = baseOrder({ total: 92000 });
    const res = await staffDeliveryService.markDelivered(7, 42, actor, { collection_method: 'CASH' });
    expect(res.collected_amount).toBe(92000);
  });

  it('pedido ya pagado: no crea otro cobro', async () => {
    orderRow = baseOrder({ payment_status: 'PAID', payment_method: 'ONLINE_AT_ORDER', order_status: 'COURIER_ASSIGNED' });
    await staffDeliveryService.markDelivered(7, 42, actor, { collection_method: 'CASH' });
    expect(paymentsCreate).not.toHaveBeenCalled();
    expect(ordersUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('pago online pendiente → 422', async () => {
    orderRow = baseOrder({ payment_status: 'PENDING_ONLINE_PAYMENT', payment_method: 'ONLINE_AT_ORDER' });
    await expect(
      staffDeliveryService.markDelivered(7, 42, actor, { collection_method: 'CASH' }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(ordersUpdateMany).not.toHaveBeenCalled();
  });

  it('PICKUP → 422 (tiene su propio flujo)', async () => {
    orderRow = baseOrder({ delivery_type: 'PICKUP', order_status: 'AT_PICKUP_POINT' });
    await expect(
      staffDeliveryService.markDelivered(7, 42, actor, { collection_method: 'CASH' }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('desde PREPARING → 422 (aún no ha salido)', async () => {
    orderRow = baseOrder({ order_status: 'PREPARING' });
    await expect(
      staffDeliveryService.markDelivered(7, 42, actor, { collection_method: 'CASH' }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(paymentsCreate).not.toHaveBeenCalled();
  });

  it('el pedido cambió entre lectura y escritura → 409', async () => {
    orderRow = baseOrder();
    ordersUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      staffDeliveryService.markDelivered(7, 42, actor, { collection_method: 'CASH' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
