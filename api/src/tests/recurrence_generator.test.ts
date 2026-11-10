/**
 * recurrence_generator.test.ts — Tests del job F3.B4.2.BACK-2
 *
 * Cobertura:
 *   RG1  Job genera pedido correcto para plantilla ACTIVE vencida (next_generation_at en el pasado)
 *   RG2  Job ignora plantillas PAUSED (no genera pedido)
 *   RG3  Job ignora plantillas CANCELLED (no genera pedido)
 *   RG4  Job actualiza next_generation_at correctamente tras generar (WEEKLY → +7d)
 *   RG5  Fallo en una plantilla → NO detiene procesamiento de las demás
 *   RG6  Plantilla no vencida (next_generation_at en el futuro) → NO genera
 *   RG7  Periodicidad BIWEEKLY → next_generation_at +14 días
 *   RG8  Periodicidad MONTHLY → next_generation_at +30 días
 *   RG9  Periodicidad CUSTOM_INTERVAL con custom_interval_days=10 → +10 días
 *   RG10 payment_method ONLINE_AT_ORDER → loggea cobro requerido (no falla)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RecurrenceStatus, RecurrencePeriodicity } from '@orkoruta/shared';

// ─── DB mock (vi.hoisted) ─────────────────────────────────────────────────────

const dbMock = vi.hoisted(() => {
  const readTx = {
    clients: { findMany: vi.fn() },
    recurrence_templates: { findMany: vi.fn() },
  };

  const writeTx = {
    recurrence_templates: { updateMany: vi.fn(), update: vi.fn() },
    orders: { create: vi.fn(), findUnique: vi.fn() },
    products: { findMany: vi.fn() },
  };

  return {
    readTx,
    writeTx,
    withTenantReadOnly: vi.fn(
      (_clientId: number, _role: string, callback: (tx: typeof readTx) => unknown) =>
        callback(readTx),
    ),
    withTenant: vi.fn(
      (_clientId: number, _role: string, callback: (tx: typeof writeTx) => unknown) =>
        callback(writeTx),
    ),
  };
});

vi.mock('@orkoruta/db', () => ({
  withTenantReadOnly: dbMock.withTenantReadOnly,
  withTenant: dbMock.withTenant,
}));

// ─── Webhook mock ─────────────────────────────────────────────────────────────

const webhookMock = vi.hoisted(() => ({
  processWebhookEvent: vi.fn(),
}));

vi.mock('../services/webhooks_outgoing.service.js', () => ({
  processWebhookEvent: webhookMock.processWebhookEvent,
}));

// ─── Import del job (después de los mocks) ────────────────────────────────────

import {
  generateRecurringOrdersForClient,
  generateOrderFromTemplate,
} from '../jobs/recurrence_generator.job.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CLIENT_ID = 1;
const BUYER_ID = BigInt(10);

function makeTemplate(overrides: Partial<{
  id: bigint;
  recurrence_periodicity: string | null;
  custom_interval_days: number | null;
  payment_method: string;
}> = {}) {
  return {
    id: BigInt(100),
    client_id: BigInt(CLIENT_ID),
    buyer_id: BUYER_ID,
    recurrence_periodicity: RecurrencePeriodicity.WEEKLY as string,
    custom_interval_days: null,
    template_payload: {
      order_id: 50,
      delivery_address_line: 'Calle 1 # 2-3',
      delivery_address_city: 'Bogotá',
      delivery_address_state: 'Cundinamarca',
      delivery_address_country: 'CO',
      delivery_address_postal_code: null,
      delivery_instructions: null,
    },
    delivery_type: 'SHIP',
    delivery_carrier_type: 'OWN_FLEET',
    payment_method: 'CASH_ON_DELIVERY',
    payment_method_submethod: null,
    ...overrides,
  };
}

const fakeBoss = { send: vi.fn() } as unknown as import('pg-boss').PgBoss;

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: updateMany retorna count = 1 (actualización exitosa)
  dbMock.writeTx.recurrence_templates.updateMany.mockResolvedValue({ count: 1 });
  dbMock.writeTx.orders.create.mockResolvedValue({
    id: BigInt(999),
    client_id: BigInt(CLIENT_ID),
    buyer_id: BUYER_ID,
  });
  webhookMock.processWebhookEvent.mockResolvedValue(undefined);
  // Pedido de origen de la plantilla: de aquí salen ítems y coordenadas.
  dbMock.writeTx.orders.findUnique.mockResolvedValue(makeSourceOrder());
  dbMock.writeTx.products.findMany.mockResolvedValue([
    { id: BigInt(7), unit_price: 50000, name: 'Caja 4 kg' },
  ]);
});

function makeSourceOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: BigInt(50),
    delivery_address_line: 'Calle 1 # 2-3',
    delivery_address_city: 'Bogotá',
    delivery_address_state: 'Cundinamarca',
    delivery_address_country: 'CO',
    delivery_address_postal_code: null,
    delivery_address_latitude: 4.7,
    delivery_address_longitude: -74.05,
    delivery_instructions: 'Apto 502',
    pickup_point_id: null,
    buyer_type: 'INDIVIDUAL',
    currency: 'COP',
    order_items: [
      // Producto del catálogo: toma el precio vigente (50000, no 48000).
      { product_id: BigInt(7), product_name: 'Caja 4kg', sku: 'AVO-4KG', quantity: 2, unit_price: 48000, metadata: null },
      // Línea libre: conserva su precio.
      { product_id: null, product_name: 'Aguacates maduros sueltos', sku: null, quantity: 10, unit_price: 1500, metadata: { custom_line: true } },
    ],
    ...overrides,
  }
}

describe('RG1 — genera pedido correcto para plantilla ACTIVE vencida', () => {
  it('crea el pedido recurrente pre-aprobado en SELLER_CONFIRMED', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000); // hace 1 hora
    const template = makeTemplate();

    // withTenantReadOnly devuelve la plantilla vencida
    dbMock.readTx.recurrence_templates.findMany.mockResolvedValue([template]);
    dbMock.readTx.clients.findMany.mockResolvedValue([{ id: BigInt(CLIENT_ID) }]);

    const now = new Date();
    await generateRecurringOrdersForClient(CLIENT_ID, fakeBoss);

    // Verifica que se intentó actualizar la plantilla
    expect(dbMock.writeTx.recurrence_templates.updateMany).toHaveBeenCalledOnce();

    // Verifica que se creó el pedido
    expect(dbMock.writeTx.orders.create).toHaveBeenCalledOnce();
    const createCall = dbMock.writeTx.orders.create.mock.calls[0][0];
    expect(createCall.data.order_status).toBe('SELLER_CONFIRMED');
    expect(createCall.data.order_origin).toBe('RECURRENCE');
    expect(createCall.data.recurrence_template_id).toBe(template.id);
    // Antes era 'PAYMENT_PENDING', que no existe y la BD rechazaba.
    expect(createCall.data.payment_status).toBe('PENDING_COLLECTION');

    // Copia los productos del pedido de origen, con el precio vigente.
    const items = createCall.data.order_items.create;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ product_id: BigInt(7), unit_price: 50000, quantity: 2, subtotal: 100000 });
    expect(items[1]).toMatchObject({ product_id: null, unit_price: 1500, quantity: 10, subtotal: 15000 });
    expect(createCall.data.total).toBe(115000);

    // Coordenadas del pedido de origen: si no, no sale en el mapa.
    expect(createCall.data.delivery_address_latitude).toBe(4.7);
    expect(createCall.data.delivery_address_longitude).toBe(-74.05);
  });

  it('pago en línea → PENDING_ONLINE_PAYMENT', async () => {
    dbMock.readTx.recurrence_templates.findMany.mockResolvedValue([
      makeTemplate({ payment_method: 'ONLINE_AT_ORDER' }),
    ]);
    await generateRecurringOrdersForClient(CLIENT_ID, fakeBoss);
    const createCall = dbMock.writeTx.orders.create.mock.calls[0][0];
    expect(createCall.data.payment_status).toBe('PENDING_ONLINE_PAYMENT');
  });

  it('sin pedido de origen: pausa la plantilla en vez de reintentar cada hora', async () => {
    dbMock.readTx.recurrence_templates.findMany.mockResolvedValue([makeTemplate()]);
    dbMock.writeTx.orders.findUnique.mockResolvedValue(null);
    await generateRecurringOrdersForClient(CLIENT_ID, fakeBoss);
    expect(dbMock.writeTx.orders.create).not.toHaveBeenCalled();
    expect(dbMock.writeTx.recurrence_templates.update).toHaveBeenCalledOnce();
    expect(dbMock.writeTx.recurrence_templates.update.mock.calls[0][0].data.recurrence_status).toBe(
      RecurrenceStatus.RECURRENCE_PAUSED,
    );
    expect(webhookMock.processWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('RG2 — ignora plantillas PAUSED', () => {
  it('no genera pedido si la plantilla tiene status PAUSED', async () => {
    // Query filtra por RECURRENCE_ACTIVE, por lo que PAUSED no aparece
    // Simulamos que el query no retorna nada (ya filtrado por el WHERE de la BD)
    dbMock.readTx.recurrence_templates.findMany.mockResolvedValue([]);

    await generateRecurringOrdersForClient(CLIENT_ID, fakeBoss);

    expect(dbMock.writeTx.orders.create).not.toHaveBeenCalled();
    expect(dbMock.writeTx.recurrence_templates.updateMany).not.toHaveBeenCalled();
  });
});

describe('RG3 — ignora plantillas CANCELLED', () => {
  it('no genera pedido si la plantilla tiene status CANCELLED', async () => {
    // Igual que PAUSED: el query WHERE filtra solo RECURRENCE_ACTIVE
    dbMock.readTx.recurrence_templates.findMany.mockResolvedValue([]);

    await generateRecurringOrdersForClient(CLIENT_ID, fakeBoss);

    expect(dbMock.writeTx.orders.create).not.toHaveBeenCalled();
  });
});

describe('RG4 — next_generation_at correcto tras generar WEEKLY', () => {
  it('WEEKLY: next_generation_at = now + 7 días', async () => {
    const template = makeTemplate({ recurrence_periodicity: RecurrencePeriodicity.WEEKLY });
    const now = new Date('2026-06-01T10:00:00.000Z');

    await generateOrderFromTemplate(CLIENT_ID, template, now);

    const updateCall = dbMock.writeTx.recurrence_templates.updateMany.mock.calls[0][0];
    const nextDate: Date = updateCall.data.next_generation_at;

    const expectedDate = new Date('2026-06-08T10:00:00.000Z');
    expect(nextDate.getFullYear()).toBe(expectedDate.getFullYear());
    expect(nextDate.getMonth()).toBe(expectedDate.getMonth());
    expect(nextDate.getDate()).toBe(expectedDate.getDate());
  });
});

describe('RG5 — fallo en una plantilla no detiene el procesamiento de las demás', () => {
  it('continúa procesando otras plantillas aunque una falle', async () => {
    const template1 = makeTemplate({ id: BigInt(101) });
    const template2 = makeTemplate({ id: BigInt(102) });

    dbMock.readTx.recurrence_templates.findMany.mockResolvedValue([template1, template2]);

    // Primera plantilla falla
    dbMock.writeTx.recurrence_templates.updateMany
      .mockRejectedValueOnce(new Error('DB connection error'))
      // Segunda plantilla exitosa
      .mockResolvedValueOnce({ count: 1 });

    await generateRecurringOrdersForClient(CLIENT_ID, fakeBoss);

    // La segunda plantilla sí se procesó (create llamado 1 vez)
    expect(dbMock.writeTx.orders.create).toHaveBeenCalledOnce();

    // Se dispatcho el webhook de fallo para la primera plantilla
    expect(webhookMock.processWebhookEvent).toHaveBeenCalledWith(
      'RECURRENCE_GENERATION_FAILED',
      expect.objectContaining({
        template_id: Number(template1.id),
        client_id: CLIENT_ID,
      }),
      CLIENT_ID,
      fakeBoss,
    );
  });
});

describe('RG6 — plantilla no vencida no genera pedido', () => {
  it('next_generation_at en el futuro → no aparece en el query → no genera', async () => {
    // El query filtra next_generation_at <= NOW(), así que plantillas futuras
    // no aparecen. Simulamos que el resultado del query es vacío.
    dbMock.readTx.recurrence_templates.findMany.mockResolvedValue([]);

    await generateRecurringOrdersForClient(CLIENT_ID, fakeBoss);

    expect(dbMock.writeTx.orders.create).not.toHaveBeenCalled();
    expect(dbMock.writeTx.recurrence_templates.updateMany).not.toHaveBeenCalled();
  });
});

describe('RG7 — BIWEEKLY → +14 días', () => {
  it('calculates next_generation_at as now + 14 days', async () => {
    const template = makeTemplate({ recurrence_periodicity: RecurrencePeriodicity.BIWEEKLY });
    const now = new Date('2026-06-01T12:00:00.000Z');

    await generateOrderFromTemplate(CLIENT_ID, template, now);

    const updateCall = dbMock.writeTx.recurrence_templates.updateMany.mock.calls[0][0];
    const nextDate: Date = updateCall.data.next_generation_at;

    // Verificar que la diferencia es exactamente 14 días en milisegundos
    const diffDays = Math.round((nextDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(14);
  });
});

describe('RG8 — MONTHLY → +30 días', () => {
  it('calculates next_generation_at as now + 30 days', async () => {
    const template = makeTemplate({ recurrence_periodicity: RecurrencePeriodicity.MONTHLY });
    const now = new Date('2026-06-01T12:00:00.000Z');

    await generateOrderFromTemplate(CLIENT_ID, template, now);

    const updateCall = dbMock.writeTx.recurrence_templates.updateMany.mock.calls[0][0];
    const nextDate: Date = updateCall.data.next_generation_at;

    const diffDays = Math.round((nextDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(30);
  });
});

describe('RG9 — CUSTOM_INTERVAL con custom_interval_days=10', () => {
  it('calculates next_generation_at as now + custom_interval_days', async () => {
    const template = makeTemplate({
      recurrence_periodicity: RecurrencePeriodicity.CUSTOM_INTERVAL,
      custom_interval_days: 10,
    });
    const now = new Date('2026-06-01T12:00:00.000Z');

    await generateOrderFromTemplate(CLIENT_ID, template, now);

    const updateCall = dbMock.writeTx.recurrence_templates.updateMany.mock.calls[0][0];
    const nextDate: Date = updateCall.data.next_generation_at;

    const diffDays = Math.round((nextDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(10);
  });
});

describe('RG10 — ONLINE_AT_ORDER loggea cobro requerido sin fallar', () => {
  it('crea el pedido correctamente cuando payment_method es ONLINE_AT_ORDER', async () => {
    const template = makeTemplate({ payment_method: 'ONLINE_AT_ORDER' });
    const now = new Date();

    await generateOrderFromTemplate(CLIENT_ID, template, now);

    // No debe lanzar, y el pedido se crea correctamente
    expect(dbMock.writeTx.orders.create).toHaveBeenCalledOnce();
    const createCall = dbMock.writeTx.orders.create.mock.calls[0][0];
    expect(createCall.data.payment_method).toBe('ONLINE_AT_ORDER');
    expect(createCall.data.order_status).toBe('SELLER_CONFIRMED');
  });
});
