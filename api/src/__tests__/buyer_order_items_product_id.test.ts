import { describe, it, expect, vi } from 'vitest';

/**
 * Un pedido de la tienda / landing debe guardar el `product_id` de cada línea.
 * Sin él la línea queda como «libre»: el despacho no la agrupaba con su
 * producto y «Editar productos» no la mostraba como producto del catálogo.
 */

const tx = vi.hoisted(() => ({
  products: { findMany: vi.fn() },
  orders: { create: vi.fn() },
}));

vi.mock('@orkoruta/db', () => ({
  withTenant: (_c: number, _r: string, fn: (t: unknown) => unknown) => fn(tx),
  withTenantReadOnly: (_c: number, _r: string, fn: (t: unknown) => unknown) => fn(tx),
}));

import { ordersService } from '../services/orders/orders.service.js';

describe('ordersService.create — líneas con producto del catálogo', () => {
  it('guarda product_id en cada línea', async () => {
    tx.products.findMany.mockResolvedValue([
      { id: 40n, unit_price: '25000', name: 'Caja 2 kg Aguacate Hass', sku: 'AVO-2KG' },
    ]);
    tx.orders.create.mockRejectedValue(new Error('stop')); // solo interesa lo que se envía

    await expect(
      ordersService.create(7, { id: 41, user_type: 'BUYER', client_id: 7 } as never, {
        items: [{ product_id: 40, quantity: 2 }],
      } as never),
    ).rejects.toThrow('stop');

    const data = tx.orders.create.mock.calls[0][0].data;
    expect(data.order_items.create).toEqual([
      expect.objectContaining({ product_id: 40n, product_name: 'Caja 2 kg Aguacate Hass', quantity: 2 }),
    ]);
  });
});
