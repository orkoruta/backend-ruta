import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Día de entrega programada (`orders.scheduled_delivery_date`).
 *
 * El Cliente lo fija a mano desde el detalle del pedido y lo ven el comprador y
 * el repartidor. Estos tests fijan tres cosas: que el valor se guarda como el
 * día correcto (medianoche UTC, no la del huso local), que la acción queda
 * auditada, y que un pedido ya terminado no admite reprogramación.
 */

interface UpdateArgs {
  data: { scheduled_delivery_date: Date | null };
}

const captured: {
  update?: UpdateArgs;
  audit?: { data: Record<string, unknown> };
} = {};

/** Estado del pedido que devuelve el mock de lectura; lo fija cada test. */
let existingOrderStatus = 'PREPARING';
let existingScheduledDate: Date | null = null;

function buildOrderRow(scheduledDeliveryDate: Date | null) {
  return {
    id: 42n,
    client_id: 7n,
    buyer_id: 1n,
    courier_user_id: null,
    order_status: existingOrderStatus,
    payment_status: 'PENDING_COLLECTION',
    order_origin: 'BUYER_UI',
    buyer_type: 'INDIVIDUAL',
    delivery_type: 'SHIP',
    delivery_carrier_type: 'OWN_FLEET',
    payment_method: 'CASH_ON_DELIVERY',
    payment_method_submethod: null,
    closure_reason: null,
    subtotal: 1000,
    tax: 0,
    shipping_fee: 0,
    discount: 0,
    total: 1000,
    currency: 'COP',
    created_at: new Date('2026-08-01T10:00:00Z'),
    updated_at: new Date('2026-08-01T10:00:00Z'),
    submitted_at: null,
    order_items: [],
    users_orders_buyer_id_client_idTousers: {
      id: 1n,
      full_name: 'Ana Compradora',
      email: 'ana@example.com',
      phone: null,
    },
    users_orders_courier_user_id_client_idTousers: null,
    delivery_address_line: 'Calle 1',
    delivery_address_city: 'Bogotá',
    delivery_address_state: 'Cundinamarca',
    delivery_instructions: null,
    scheduled_delivery_date: scheduledDeliveryDate,
    pickup_points: null,
  };
}

const mockFindUnique = vi.fn(async () => buildOrderRow(existingScheduledDate));
const mockUpdate = vi.fn(async (args: UpdateArgs) => {
  captured.update = args;
  return buildOrderRow(args.data.scheduled_delivery_date);
});
const mockAuditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
  captured.audit = args;
  return {};
});

vi.mock('@orkoruta/db', () => ({
  withTenantReadOnly: (_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
    fn({ clients: { findUnique: async () => ({ client_type: 'FULL' }) } }),
  withTenant: (_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
    fn({
      orders: { findUnique: mockFindUnique, update: mockUpdate },
      audit_events: { create: mockAuditCreate },
    }),
}));

const { adminOrdersService } = await import('../routes/admin_orders.js');

const actor = {
  id: 99,
  client_id: 7,
  user_type: 'ADMIN_CLIENT',
  session_id: 1,
};

describe('adminOrdersService.setDeliveryDate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.update = undefined;
    captured.audit = undefined;
    existingOrderStatus = 'PREPARING';
    existingScheduledDate = null;
  });

  it('guarda el día como medianoche UTC, no la del huso local', async () => {
    await adminOrdersService.setDeliveryDate(7, 42, actor, '2026-08-14');

    const saved = captured.update?.data.scheduled_delivery_date as Date;
    // En Colombia (UTC-5) usar la medianoche local guardaría el 13 de agosto.
    expect(saved.toISOString()).toBe('2026-08-14T00:00:00.000Z');
  });

  it('devuelve el día en formato YYYY-MM-DD, sin desplazarlo', async () => {
    const result = await adminOrdersService.setDeliveryDate(7, 42, actor, '2026-08-14');
    expect(result.scheduled_delivery_date).toBe('2026-08-14');
  });

  it('acepta null para quitar la programación', async () => {
    existingScheduledDate = new Date('2026-08-14T00:00:00.000Z');

    const result = await adminOrdersService.setDeliveryDate(7, 42, actor, null);

    expect(captured.update?.data.scheduled_delivery_date).toBeNull();
    expect(result.scheduled_delivery_date).toBeNull();
  });

  it('audita el cambio con el valor anterior y el nuevo', async () => {
    existingScheduledDate = new Date('2026-08-10T00:00:00.000Z');

    await adminOrdersService.setDeliveryDate(7, 42, actor, '2026-08-14');

    expect(captured.audit?.data.action).toBe('order_delivery_date_set');
    expect(captured.audit?.data.entity_type).toBe('order');
    expect(captured.audit?.data.metadata).toEqual({
      previous: '2026-08-10',
      current: '2026-08-14',
    });
  });

  it('distingue en la auditoría cuando se limpia la fecha', async () => {
    existingScheduledDate = new Date('2026-08-10T00:00:00.000Z');

    await adminOrdersService.setDeliveryDate(7, 42, actor, null);

    expect(captured.audit?.data.action).toBe('order_delivery_date_cleared');
  });

  it.each([
    'DELIVERED',
    'CLOSED',
    'COMPLETED_SUCCESSFULLY',
    'CANCELLED_BY_ADMIN',
    'PICKED_UP',
  ])('rechaza reprogramar un pedido ya terminado (%s)', async (status) => {
    existingOrderStatus = status;

    await expect(adminOrdersService.setDeliveryDate(7, 42, actor, '2026-08-14')).rejects.toMatchObject(
      { statusCode: 422, code: 'INVALID_STATE_TRANSITION' },
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('permite programar mientras el pedido sigue en curso', async () => {
    for (const status of ['SELLER_CONFIRMED', 'PREPARING', 'COURIER_ASSIGNED', 'IN_TRANSIT']) {
      existingOrderStatus = status;
      await expect(
        adminOrdersService.setDeliveryDate(7, 42, actor, '2026-08-14'),
      ).resolves.toBeDefined();
    }
  });
});
