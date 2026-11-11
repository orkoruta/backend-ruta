import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Editar los productos de un pedido ya creado.
 *
 * Fija: precio acordado para lo que ya estaba, precio vigente para lo nuevo,
 * líneas libres con su precio, total recalculado respetando envío y descuento,
 * y que no se pueda editar después de salir a reparto ni con el pago hecho.
 */

let orderRow: Record<string, unknown>;
const productsFindMany = vi.fn();
const ordersUpdateMany = vi.fn(async () => ({ count: 1 }));
const itemsDeleteMany = vi.fn(async () => ({ count: 1 }));
const itemsCreate = vi.fn(async () => ({}));
const auditCreate = vi.fn(async () => ({}));

vi.mock('@orkoruta/db', () => ({
  withTenant: (_c: number, _r: string, fn: (tx: unknown) => unknown) =>
    fn({
      orders: { findUnique: async () => orderRow, updateMany: ordersUpdateMany },
      products: { findMany: productsFindMany },
      order_items: { deleteMany: itemsDeleteMany, create: itemsCreate },
      audit_events: { create: auditCreate },
    }),
}));

const { orderItemsEditService } = await import('../services/orders/order_items_edit.service.js');

const actor = { id: 9, client_id: 7, user_type: 'ADMIN_CLIENT' } as never;

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 42n,
    order_status: 'PREPARING',
    payment_status: 'PENDING_COLLECTION',
    total: 96000,
    shipping_fee: 0,
    tax: 0,
    discount: 0,
    version: 2n,
    order_items: [
      // Caja 4 kg acordada a 45000 (hoy el catálogo la tiene en 48000).
      { product_id: 1n, product_name: 'Caja 4 kg', quantity: 2, unit_price: 45000 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  productsFindMany.mockResolvedValue([
    { id: 1n, name: 'Caja 4 kg', sku: 'AVO-4KG', unit_price: 48000, status: 'ACTIVE' },
    { id: 2n, name: 'Caja 2 kg', sku: 'AVO-2KG', unit_price: 25000, status: 'ACTIVE' },
  ]);
});

describe('orderItemsEditService.updateItems', () => {
  it('conserva el precio acordado, usa el vigente para lo nuevo y recalcula el total', async () => {
    orderRow = baseOrder();
    const res = await orderItemsEditService.updateItems(7, 42, actor, {
      items: [
        { product_id: 1, quantity: 3 }, // ya estaba: 45000 c/u
        { product_id: 2, quantity: 1 }, // nuevo: 25000
        { description: 'Aguacates maduros sueltos', unit_price: 1500, quantity: 4 },
      ],
    });

    expect(res.totalAfter).toBe(3 * 45000 + 25000 + 4 * 1500);
    const created = itemsCreate.mock.calls.map((c) => (c as unknown as [{ data: Record<string, unknown> }])[0].data);
    expect(created).toHaveLength(3);
    expect(created[0]).toMatchObject({ product_id: 1n, unit_price: 45000, subtotal: 135000 });
    expect(created[1]).toMatchObject({ product_id: 2n, unit_price: 25000 });
    expect(created[2]).toMatchObject({ product_id: null, product_name: 'Aguacates maduros sueltos', unit_price: 1500 });
    expect(itemsDeleteMany).toHaveBeenCalledOnce();

    const update = (ordersUpdateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0];
    expect(update.where.version).toBe(2n);
    expect(update.data.total).toBe(166000);
    expect(auditCreate).toHaveBeenCalledOnce();
  });

  it('respeta envío y descuento en el total', async () => {
    orderRow = baseOrder({ shipping_fee: 9000, discount: 5000 });
    const res = await orderItemsEditService.updateItems(7, 42, actor, {
      items: [{ product_id: 2, quantity: 2 }],
    });
    expect(res.totalAfter).toBe(50000 + 9000 - 5000);
  });

  it('pedido ya en camino → 422 y no toca nada', async () => {
    orderRow = baseOrder({ order_status: 'OUT_FOR_DELIVERY' });
    await expect(
      orderItemsEditService.updateItems(7, 42, actor, { items: [{ product_id: 1, quantity: 1 }] }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(ordersUpdateMany).not.toHaveBeenCalled();
    expect(itemsDeleteMany).not.toHaveBeenCalled();
  });

  it('pedido ya pagado en línea → 422', async () => {
    orderRow = baseOrder({ payment_status: 'PAID' });
    await expect(
      orderItemsEditService.updateItems(7, 42, actor, { items: [{ product_id: 1, quantity: 1 }] }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('producto nuevo inactivo → 422', async () => {
    orderRow = baseOrder();
    productsFindMany.mockResolvedValue([
      { id: 3n, name: 'Caja 12 kg', sku: null, unit_price: 96000, status: 'INACTIVE' },
    ]);
    await expect(
      orderItemsEditService.updateItems(7, 42, actor, { items: [{ product_id: 3, quantity: 1 }] }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('el pedido cambió mientras se editaba → 409', async () => {
    orderRow = baseOrder();
    ordersUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      orderItemsEditService.updateItems(7, 42, actor, { items: [{ product_id: 1, quantity: 1 }] }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(itemsDeleteMany).not.toHaveBeenCalled();
  });
});
