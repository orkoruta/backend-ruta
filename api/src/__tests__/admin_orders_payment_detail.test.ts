import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * El detalle del pedido debe emitir `payment`.
 *
 * No lo hacía, y en el panel del Cliente la tarjeta «Pago» está envuelta en
 * `{order.payment && …}`: **nunca se pintaba**. El estado del pago, el método,
 * el monto y la fecha de confirmación eran invisibles desde que se escribió la
 * pantalla.
 *
 * El listado sigue sin cargarlo a propósito: no lo muestra y sería una lectura
 * extra por fila.
 */

const capturedArgs: { findUnique?: unknown; findMany?: unknown } = {};

const basePayment = {
  id: 55n,
  status: 'COLLECTED',
  payment_method: 'CASH_ON_DELIVERY',
  amount: 50000,
  technical_confirmation_at: null as Date | null,
  collected_at: new Date('2026-08-11T18:00:00.000Z'),
};

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    client_id: 4n,
    buyer_id: 2n,
    courier_user_id: null,
    order_status: 'AT_PICKUP_POINT',
    payment_status: 'PENDING',
    order_origin: 'BUYER_UI',
    buyer_type: 'INDIVIDUAL',
    delivery_type: 'PICKUP',
    delivery_carrier_type: null,
    payment_method: 'CASH_ON_DELIVERY',
    payment_method_submethod: null,
    closure_reason: null,
    subtotal: 50000,
    tax: 0,
    shipping_fee: 0,
    discount: 0,
    total: 50000,
    currency: 'COP',
    created_at: new Date('2026-08-11T12:00:00.000Z'),
    updated_at: new Date('2026-08-11T12:00:00.000Z'),
    submitted_at: null,
    delivery_instructions: null,
    scheduled_delivery_date: null,
    order_items: [],
    users_orders_buyer_id_client_idTousers: {
      id: 2n,
      full_name: 'Ana',
      email: 'ana@test.com',
      phone: null,
      external_buyer_id: null,
    },
    users_orders_courier_user_id_client_idTousers: null,
    pickup_points: null,
    order_state_history: [],
    ...overrides,
  };
}

const mockFindUnique = vi.fn(async (args: unknown) => {
  capturedArgs.findUnique = args;
  return orderRow({ payments: [basePayment] });
});
const mockFindMany = vi.fn(async (args: unknown) => {
  capturedArgs.findMany = args;
  return [];
});

vi.mock('@orkoruta/db', () => ({
  withTenantReadOnly: (_c: number, _r: string, fn: (tx: unknown) => unknown) =>
    fn({ orders: { findUnique: mockFindUnique, findMany: mockFindMany, count: async () => 0 } }),
  withTenant: (_c: number, _r: string, fn: (tx: unknown) => unknown) =>
    fn({ orders: { findUnique: mockFindUnique, findMany: mockFindMany, count: async () => 0 } }),
}));

const { adminOrdersService } = await import('../routes/admin_orders.js');

beforeEach(() => {
  vi.clearAllMocks();
  capturedArgs.findUnique = undefined;
  capturedArgs.findMany = undefined;
});

describe('el detalle emite `payment`', () => {
  it('serializa el pago con los campos que pinta la tarjeta', async () => {
    const order = await adminOrdersService.getById(4, 1);

    expect(order.payment).toEqual({
      id: 55,
      status: 'COLLECTED',
      method: 'CASH_ON_DELIVERY',
      amount: 50000,
      confirmed_at: '2026-08-11T18:00:00.000Z',
    });
  });

  it('en contra entrega `confirmed_at` es el momento del cobro', async () => {
    // No hay confirmación de pasarela; lo que el operador quiere ver es cuándo
    // se recogió el dinero.
    const order = await adminOrdersService.getById(4, 1);
    expect(order.payment?.confirmed_at).toBe('2026-08-11T18:00:00.000Z');
  });

  it('la confirmación técnica tiene prioridad cuando existe', async () => {
    mockFindUnique.mockResolvedValueOnce(
      orderRow({
        payments: [
          {
            ...basePayment,
            technical_confirmation_at: new Date('2026-08-11T12:30:00.000Z'),
          },
        ],
      }),
    );

    const order = await adminOrdersService.getById(4, 1);
    expect(order.payment?.confirmed_at).toBe('2026-08-11T12:30:00.000Z');
  });

  it('sin cobro registrado, `payment` es null y no revienta', async () => {
    // En PICKUP la fila de `payments` se crea **al cobrar**: antes no existe.
    mockFindUnique.mockResolvedValueOnce(orderRow({ payments: [] }));

    const order = await adminOrdersService.getById(4, 1);
    expect(order.payment).toBeNull();
    // Y aun así el método pactado sigue disponible: es de lo que depende que el
    // operador vea el paso de cobro.
    expect(order.payment_method).toBe('CASH_ON_DELIVERY');
  });

  it('**no** carga la evidencia de cobro: es base64 y pesa', async () => {
    await adminOrdersService.getById(4, 1);

    const args = capturedArgs.findUnique as { include: { payments: { select: object } } };
    expect(args.include.payments.select).not.toHaveProperty('collection_evidence');
  });

  it('pide solo el pago más reciente', async () => {
    await adminOrdersService.getById(4, 1);

    const args = capturedArgs.findUnique as {
      include: { payments: { take: number; orderBy: unknown } };
    };
    expect(args.include.payments.take).toBe(1);
    expect(args.include.payments.orderBy).toEqual({ created_at: 'desc' });
  });
});

describe('el listado no carga pagos', () => {
  it('no incluye `payments` en el include del listado', async () => {
    await adminOrdersService.list(4, { page: 1, page_size: 20 } as Parameters<
      typeof adminOrdersService.list
    >[1]);

    const args = capturedArgs.findMany as { include: Record<string, unknown> };
    expect(args.include).not.toHaveProperty('payments');
  });
});
