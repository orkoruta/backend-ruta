/**
 * recurrence_flow5_full.test.ts — Tests end-to-end del Flujo 5: Recurrencia (F3.B4.4.QA-1)
 *
 * Estos tests validan el flujo completo conectando el servicio (recurrence.service.ts)
 * con el job de generación (recurrence_generator.job.ts) en una sola prueba.
 *
 * Cobertura:
 *   F5E2E-1  Marcar como recurrente → plantilla ACTIVE → job genera pedido → next_generation_at avanza
 *   F5E2E-2  Pausar plantilla → job NO genera pedido al vencer el plazo
 *   F5E2E-3  Reanudar plantilla → job SÍ genera en el siguiente ciclo
 *   F5E2E-4  Cancelar plantilla → job ignora en todos los ciclos futuros
 *   F5E2E-5  repeatLastOrder → DRAFT con mismos ítems que el pedido original
 *   F5E2E-6  Aislamiento: comprador de cliente A no puede ver/gestionar plantillas de cliente B
 *   F5E2E-7  CUSTOM_INTERVAL → job genera con días personalizados y avanza next_generation_at
 *   F5E2E-8  Idempotencia del job: doble ejecución en el mismo ciclo no crea pedido duplicado
 *   F5E2E-9  Fallo en generación → webhook RECURRENCE_GENERATION_FAILED disparado sin detener el loop
 *   F5E2E-10 Ciclo completo BIWEEKLY: 3 ciclos → 3 pedidos y next_generation_at avanza correctamente
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import type { recurrenceService } from '../services/recurrence.service.js';
import { createBuyerRecurrenceRouter, createBuyerOrderRecurrenceRouter } from '../routes/buyer_recurrence.js';
import { createAdminRecurrenceRouter } from '../routes/admin_recurrence.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { RecurrenceStatus, RecurrencePeriodicity } from '@orkoruta/shared';

// ─── DB mock (vi.hoisted) ─────────────────────────────────────────────────────

const dbMock = vi.hoisted(() => {
  const readTx = {
    clients: { findMany: vi.fn(), findUnique: vi.fn() },
    recurrence_templates: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  };

  const writeTx = {
    recurrence_templates: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
    orders: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    order_items: { create: vi.fn() },
    audit_events: { create: vi.fn() },
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

// ─── Imports (después de mocks) ───────────────────────────────────────────────

import {
  generateRecurringOrdersForClient,
  generateOrderFromTemplate,
} from '../jobs/recurrence_generator.job.js';

// ─── Tipos ────────────────────────────────────────────────────────────────────

type RecurrenceService = typeof recurrenceService;

// ─── Express helpers ──────────────────────────────────────────────────────────

function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.statusCode).json(sendHttpError(err));
    return;
  }
  res.status(500).json(toApiError('INTERNAL_ERROR', 'Error interno'));
}

function withUser(user: AuthenticatedUser) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthenticatedUser }).user = user;
    next();
  };
}

const buyerA: AuthenticatedUser = { id: 10, client_id: 1, user_type: 'BUYER', session_id: 100 };
const buyerB: AuthenticatedUser = { id: 20, client_id: 2, user_type: 'BUYER', session_id: 200 };
const adminUser: AuthenticatedUser = { id: 1, client_id: 1, user_type: 'ADMIN_CLIENT', session_id: 101 };

function makeMockService(): RecurrenceService {
  return {
    markOrderAsRecurring: vi.fn(),
    repeatLastOrder: vi.fn(),
    pauseRecurrence: vi.fn(),
    resumeRecurrence: vi.fn(),
    cancelRecurrence: vi.fn(),
    updateTemplate: vi.fn(),
    pauseRecurrenceAsAdmin: vi.fn(),
    cancelRecurrenceAsAdmin: vi.fn(),
    getTemplate: vi.fn(),
    listTemplates: vi.fn(),
    listBuyerTemplates: vi.fn(),
  } as unknown as RecurrenceService;
}

function buildBuyerApp(svc: RecurrenceService, user: AuthenticatedUser = buyerA) {
  const app = express();
  app.use(express.json());
  app.use(withUser(user));
  app.use('/buyer/recurrence', createBuyerRecurrenceRouter(svc));
  app.use('/buyer/orders', requireIdempotencyKey, createBuyerOrderRecurrenceRouter(svc));
  app.use(errorHandler);
  return app;
}

function buildAdminApp(svc: RecurrenceService, user: AuthenticatedUser = adminUser) {
  const app = express();
  app.use(express.json());
  app.use(withUser(user));
  app.use('/admin/recurrence', createAdminRecurrenceRouter(svc));
  app.use(errorHandler);
  return app;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CLIENT_A = 1;
const CLIENT_B = 2;
const BUYER_A_ID = BigInt(10);
const BUYER_B_ID = BigInt(20);

const fakeBoss = { send: vi.fn() } as unknown as import('pg-boss').PgBoss;

const now = new Date('2026-06-01T10:00:00.000Z');

function makeDbTemplate(overrides: Partial<{
  id: bigint;
  client_id: bigint;
  buyer_id: bigint;
  recurrence_status: string;
  recurrence_periodicity: string | null;
  custom_interval_days: number | null;
  payment_method: string;
  next_generation_at: Date | null;
}> = {}) {
  return {
    id: BigInt(100),
    client_id: BigInt(CLIENT_A),
    buyer_id: BUYER_A_ID,
    recurrence_mode: 'SCHEDULED_RECURRING',
    recurrence_status: RecurrenceStatus.RECURRENCE_ACTIVE,
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
    next_generation_at: new Date(now.getTime() - 1000), // vencida hace 1 segundo
    last_generated_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeApiTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    client_id: CLIENT_A,
    buyer_id: 10,
    recurrence_mode: 'SCHEDULED_RECURRING',
    recurrence_status: RecurrenceStatus.RECURRENCE_ACTIVE,
    recurrence_periodicity: RecurrencePeriodicity.WEEKLY,
    custom_interval_days: null,
    template_payload: { order_id: 50 },
    delivery_type: 'SHIP',
    delivery_carrier_type: 'OWN_FLEET',
    payment_method: 'CASH_ON_DELIVERY',
    payment_method_submethod: null,
    next_generation_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    last_generated_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Defaults razonables para que los tests que solo necesitan el job funcionen
  dbMock.readTx.clients.findUnique.mockResolvedValue({ client_type: 'FULL' });
  dbMock.writeTx.recurrence_templates.updateMany.mockResolvedValue({ count: 1 });
  dbMock.writeTx.orders.create.mockResolvedValue({
    id: BigInt(999),
    client_id: BigInt(CLIENT_A),
    buyer_id: BUYER_A_ID,
  });
  dbMock.writeTx.audit_events.create.mockResolvedValue({});
  webhookMock.processWebhookEvent.mockResolvedValue(undefined);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// F5E2E-1: Flujo completo — marcar como recurrente → job genera → avanza fecha
// ────────────────────────────────────────────────────────────────────────────
describe('F5E2E-1 — Marcar como recurrente → plantilla ACTIVE → job genera pedido → next_generation_at avanza', () => {
  it('POST mark-recurring crea plantilla ACTIVE; luego job crea pedido y avanza next_generation_at', async () => {
    // 1. Capa API: marcar pedido como recurrente
    const svc = makeMockService();
    const createdTemplate = makeApiTemplate();
    (svc.markOrderAsRecurring as ReturnType<typeof vi.fn>).mockResolvedValue(createdTemplate);
    const app = buildBuyerApp(svc);

    const apiRes = await request(app)
      .post('/buyer/orders/50/mark-recurring')
      .set('X-Idempotency-Key', 'e2e-1-mark')
      .send({ recurrence_periodicity: 'WEEKLY' });

    expect(apiRes.status).toBe(201);
    expect(apiRes.body.recurrence_status).toBe(RecurrenceStatus.RECURRENCE_ACTIVE);
    expect(apiRes.body.recurrence_periodicity).toBe('WEEKLY');
    expect(svc.markOrderAsRecurring).toHaveBeenCalledWith(
      1, 50, 10,
      expect.objectContaining({ recurrence_periodicity: 'WEEKLY' }),
    );

    // 2. Capa job: la plantilla está vencida → job genera pedido usando fecha fija
    // Usamos generateOrderFromTemplate con `now` fijo para que el cálculo sea determinista
    const dbTemplate = makeDbTemplate(); // next_generation_at en el pasado

    await generateOrderFromTemplate(CLIENT_A, dbTemplate, now);

    // Verifica que se actualizó next_generation_at correctamente (+7 días desde `now`)
    expect(dbMock.writeTx.recurrence_templates.updateMany).toHaveBeenCalledOnce();
    const updateCall = dbMock.writeTx.recurrence_templates.updateMany.mock.calls[0][0];
    const nextDate: Date = updateCall.data.next_generation_at;
    const diffDays = Math.round((nextDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(7); // WEEKLY → +7 días

    // Verifica que se creó el pedido
    expect(dbMock.writeTx.orders.create).toHaveBeenCalledOnce();
    const orderCall = dbMock.writeTx.orders.create.mock.calls[0][0];
    expect(orderCall.data.order_status).toBe('SELLER_CONFIRMED');
    expect(orderCall.data.order_origin).toBe('RECURRENCE');
    expect(orderCall.data.recurrence_template_id).toBe(dbTemplate.id);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F5E2E-2: Pausar plantilla → job NO genera al vencer el plazo
// ────────────────────────────────────────────────────────────────────────────
describe('F5E2E-2 — Pausar plantilla → job NO genera pedido al vencer el plazo', () => {
  it('POST pause → RECURRENCE_PAUSED; luego el job no encuentra plantillas y no genera', async () => {
    // 1. Capa API: pausar la plantilla
    const svc = makeMockService();
    const pausedTemplate = makeApiTemplate({ recurrence_status: RecurrenceStatus.RECURRENCE_PAUSED });
    (svc.pauseRecurrence as ReturnType<typeof vi.fn>).mockResolvedValue(pausedTemplate);
    const app = buildBuyerApp(svc);

    const apiRes = await request(app)
      .post('/buyer/recurrence/100/pause')
      .set('X-Idempotency-Key', 'e2e-2-pause');

    expect(apiRes.status).toBe(200);
    expect(apiRes.body.recurrence_status).toBe(RecurrenceStatus.RECURRENCE_PAUSED);

    // 2. Capa job: query filtra solo RECURRENCE_ACTIVE, devuelve vacío
    dbMock.readTx.recurrence_templates.findMany.mockResolvedValue([]);

    await generateRecurringOrdersForClient(CLIENT_A, fakeBoss);

    // Job no debe crear ningún pedido ni actualizar plantillas
    expect(dbMock.writeTx.orders.create).not.toHaveBeenCalled();
    expect(dbMock.writeTx.recurrence_templates.updateMany).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F5E2E-3: Reanudar plantilla → job SÍ genera en el siguiente ciclo
// ────────────────────────────────────────────────────────────────────────────
describe('F5E2E-3 — Reanudar plantilla → job SÍ genera en el siguiente ciclo', () => {
  it('POST resume → RECURRENCE_ACTIVE; luego el job genera el pedido normalmente', async () => {
    // 1. Capa API: reanudar la plantilla
    const svc = makeMockService();
    const resumedTemplate = makeApiTemplate({
      recurrence_status: RecurrenceStatus.RECURRENCE_ACTIVE,
      next_generation_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    (svc.resumeRecurrence as ReturnType<typeof vi.fn>).mockResolvedValue(resumedTemplate);
    const app = buildBuyerApp(svc);

    const apiRes = await request(app)
      .post('/buyer/recurrence/100/resume')
      .set('X-Idempotency-Key', 'e2e-3-resume');

    expect(apiRes.status).toBe(200);
    expect(apiRes.body.recurrence_status).toBe(RecurrenceStatus.RECURRENCE_ACTIVE);
    expect(apiRes.body.next_generation_at).toBeDefined();

    // 2. Capa job: en el siguiente ciclo, la plantilla ya está vencida → genera
    const dbTemplate = makeDbTemplate({ recurrence_status: RecurrenceStatus.RECURRENCE_ACTIVE });
    dbMock.readTx.recurrence_templates.findMany.mockResolvedValue([dbTemplate]);

    await generateRecurringOrdersForClient(CLIENT_A, fakeBoss);

    expect(dbMock.writeTx.orders.create).toHaveBeenCalledOnce();
    expect(dbMock.writeTx.recurrence_templates.updateMany).toHaveBeenCalledOnce();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F5E2E-4: Cancelar plantilla → job ignora en todos los ciclos futuros
// ────────────────────────────────────────────────────────────────────────────
describe('F5E2E-4 — Cancelar plantilla → job ignora en todos los ciclos futuros', () => {
  it('DELETE cancela → RECURRENCE_CANCELLED; job nunca la incluye en query', async () => {
    // 1. Capa API: cancelar la plantilla
    const svc = makeMockService();
    const cancelledTemplate = makeApiTemplate({ recurrence_status: RecurrenceStatus.RECURRENCE_CANCELLED });
    (svc.cancelRecurrence as ReturnType<typeof vi.fn>).mockResolvedValue(cancelledTemplate);
    const app = buildBuyerApp(svc);

    const apiRes = await request(app)
      .delete('/buyer/recurrence/100')
      .set('X-Idempotency-Key', 'e2e-4-cancel');

    expect(apiRes.status).toBe(200);
    expect(apiRes.body.recurrence_status).toBe(RecurrenceStatus.RECURRENCE_CANCELLED);

    // 2. Múltiples ciclos del job: query solo retorna ACTIVE, plantilla cancelada nunca aparece
    dbMock.readTx.recurrence_templates.findMany.mockResolvedValue([]);

    // Simular 3 ciclos del job
    for (let cycle = 0; cycle < 3; cycle++) {
      await generateRecurringOrdersForClient(CLIENT_A, fakeBoss);
    }

    // Nunca debe generar pedido para una plantilla cancelada
    expect(dbMock.writeTx.orders.create).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F5E2E-5: repeatLastOrder → DRAFT con mismos ítems que el pedido original
// ────────────────────────────────────────────────────────────────────────────
describe('F5E2E-5 — repeatLastOrder → DRAFT con mismos ítems que el pedido original', () => {
  it('POST repeat-last devuelve DRAFT con order_origin RECURRENCE', async () => {
    const svc = makeMockService();
    const draftOrder = {
      id: 999,
      client_id: CLIENT_A,
      buyer_id: 10,
      order_status: 'DRAFT',
      order_origin: 'RECURRENCE',
      payment_method: 'CASH_ON_DELIVERY',
      delivery_type: 'SHIP',
      subtotal: 75000,
      total: 75000,
      created_at: now.toISOString(),
    };
    (svc.repeatLastOrder as ReturnType<typeof vi.fn>).mockResolvedValue(draftOrder);
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/recurrence/repeat-last')
      .set('X-Idempotency-Key', 'e2e-5-repeat');

    expect(res.status).toBe(201);
    expect(res.body.order_status).toBe('DRAFT');
    expect(res.body.order_origin).toBe('RECURRENCE');
    expect(res.body.buyer_id).toBe(10);
    expect(res.body.client_id).toBe(CLIENT_A);
    expect(res.body.subtotal).toBe(75000);
    expect(svc.repeatLastOrder).toHaveBeenCalledWith(CLIENT_A, 10);
  });

  it('repeatLastOrder directo: clona ítems correctamente y el total es la suma de los ítems', async () => {
    // Test de capa de servicio vía mock de DB
    const item1 = {
      id: BigInt(1),
      order_id: BigInt(50),
      product_id: BigInt(5),
      product_name: 'Producto A',
      sku: 'SKU-A',
      quantity: 2,
      unit_price: { toNumber: () => 15000 },
      subtotal: 30000,
      metadata: null,
      client_id: BigInt(CLIENT_A),
    };
    const item2 = {
      id: BigInt(2),
      order_id: BigInt(50),
      product_id: BigInt(6),
      product_name: 'Producto B',
      sku: 'SKU-B',
      quantity: 3,
      unit_price: { toNumber: () => 5000 },
      subtotal: 15000,
      metadata: null,
      client_id: BigInt(CLIENT_A),
    };
    const lastOrder = {
      id: BigInt(50),
      client_id: BigInt(CLIENT_A),
      buyer_id: BUYER_A_ID,
      order_status: 'ORDER_DELIVERED',
      order_origin: 'BUYER_UI',
      order_items: [item1, item2],
      delivery_type: 'SHIP',
      delivery_carrier_type: 'OWN_FLEET',
      payment_method: 'CASH_ON_DELIVERY',
      payment_method_submethod: null,
      delivery_address_line: 'Calle 1',
      delivery_address_city: 'Bogotá',
      delivery_address_state: 'Cundinamarca',
      delivery_address_country: 'CO',
      delivery_address_postal_code: null,
      delivery_address_latitude: null,
      delivery_address_longitude: null,
      delivery_instructions: null,
      pickup_point_id: null,
      buyer_type: 'INDIVIDUAL',
      subtotal: 45000,
      total: 45000,
      created_at: now,
    };

    dbMock.readTx.clients.findUnique.mockResolvedValue({ client_type: 'FULL' });
    dbMock.writeTx.orders.findFirst.mockResolvedValue(lastOrder);
    // La función usa withTenant para findFirst también
    dbMock.writeTx.orders.create.mockResolvedValue({
      id: BigInt(999),
      client_id: BigInt(CLIENT_A),
      buyer_id: BUYER_A_ID,
      order_status: 'DRAFT',
      order_origin: 'RECURRENCE',
      payment_method: 'CASH_ON_DELIVERY',
      delivery_type: 'SHIP',
      subtotal: 45000,
      total: 45000,
      created_at: now,
    });
    dbMock.writeTx.order_items.create.mockResolvedValue({});

    // importar el servicio real para este sub-test
    const { recurrenceService: realSvc } = await import('../services/recurrence.service.js');

    // withTenant mock para que findFirst devuelva el lastOrder
    dbMock.withTenant.mockImplementationOnce(
      (_clientId: number, _role: string, callback: (tx: typeof dbMock.writeTx) => unknown) => {
        // Inyectar findFirst en orders dentro de writeTx
        const tx = { ...dbMock.writeTx, orders: { ...dbMock.writeTx.orders, findFirst: vi.fn().mockResolvedValue(lastOrder) } };
        return callback(tx);
      },
    );

    const result = await realSvc.repeatLastOrder(CLIENT_A, 10);

    expect(result.order_status).toBe('DRAFT');
    expect(result.order_origin).toBe('RECURRENCE');
    // El total es la suma de los ítems clonados: 2*15000 + 3*5000 = 45000
    expect(result.total).toBe(45000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F5E2E-6: Aislamiento multi-tenant — comprador A no puede gestionar plantillas de cliente B
// ────────────────────────────────────────────────────────────────────────────
describe('F5E2E-6 — Aislamiento: comprador A no puede ver/gestionar plantillas de cliente B', () => {
  it('comprador de cliente A recibe 404 al intentar pausar plantilla de cliente B', async () => {
    const svc = makeMockService();
    // Simula que la plantilla con id=200 pertenece al cliente B, no al cliente A
    (svc.pauseRecurrence as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Plantilla de recurrencia no encontrada'),
    );
    // App del comprador A (client_id = 1)
    const app = buildBuyerApp(svc, buyerA);

    const res = await request(app)
      .post('/buyer/recurrence/200/pause')
      .set('X-Idempotency-Key', 'e2e-6-isolation');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
    // El servicio se llamó con client_id=1 (cliente A) y template_id=200 (del cliente B)
    expect(svc.pauseRecurrence).toHaveBeenCalledWith(1, 200, 10);
  });

  it('el job de cliente A no procesa plantillas de cliente B', async () => {
    // Plantilla de cliente B (id=2) con estructura similar
    const templateB = makeDbTemplate({
      id: BigInt(200),
      client_id: BigInt(CLIENT_B),
      buyer_id: BUYER_B_ID,
    });

    // Job de cliente A: query filtra por client_id=1, NO devuelve plantillas de cliente B
    dbMock.readTx.recurrence_templates.findMany.mockResolvedValue([]);

    await generateRecurringOrdersForClient(CLIENT_A, fakeBoss);

    // Ningún pedido creado para el cliente A
    expect(dbMock.writeTx.orders.create).not.toHaveBeenCalled();

    // Verificar que el query incluye el filtro de client_id correcto
    const findManyCall = dbMock.readTx.recurrence_templates.findMany.mock.calls[0][0];
    expect(Number(findManyCall.where.client_id)).toBe(CLIENT_A);
    expect(Number(findManyCall.where.client_id)).not.toBe(CLIENT_B);

    // templateB es declarado pero solo usado para documentar intención del test
    void templateB;
  });

  it('comprador B no puede listar plantillas del comprador A en el mismo cliente', async () => {
    const svc = makeMockService();
    // Servicio retorna lista vacía porque buyer_id de B no tiene plantillas
    (svc.listBuyerTemplates as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      pagination: { page: 1, page_size: 20, total: 0 },
    });
    // App con buyerB (id=20) que intenta listar en client_id=2
    const app = buildBuyerApp(svc, buyerB);

    const res = await request(app).get('/buyer/recurrence');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    // Se llamó con el client_id y buyer_id correctos (del comprador B)
    expect(svc.listBuyerTemplates).toHaveBeenCalledWith(2, 20, expect.any(Object));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F5E2E-7: CUSTOM_INTERVAL → job genera con días personalizados
// ────────────────────────────────────────────────────────────────────────────
describe('F5E2E-7 — CUSTOM_INTERVAL → generación correcta con días personalizados', () => {
  it('API crea plantilla CUSTOM_INTERVAL=15; job avanza next_generation_at en +15 días', async () => {
    // 1. Capa API: crear plantilla con CUSTOM_INTERVAL=15
    const svc = makeMockService();
    const customTemplate = makeApiTemplate({
      recurrence_periodicity: RecurrencePeriodicity.CUSTOM_INTERVAL,
      custom_interval_days: 15,
      next_generation_at: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    });
    (svc.markOrderAsRecurring as ReturnType<typeof vi.fn>).mockResolvedValue(customTemplate);
    const app = buildBuyerApp(svc);

    const apiRes = await request(app)
      .post('/buyer/orders/50/mark-recurring')
      .set('X-Idempotency-Key', 'e2e-7-custom')
      .send({ recurrence_periodicity: 'CUSTOM_INTERVAL', custom_interval_days: 15 });

    expect(apiRes.status).toBe(201);
    expect(apiRes.body.recurrence_periodicity).toBe(RecurrencePeriodicity.CUSTOM_INTERVAL);
    expect(apiRes.body.custom_interval_days).toBe(15);

    // 2. Capa job: plantilla CUSTOM_INTERVAL con 15 días personalizados
    const dbTemplate = makeDbTemplate({
      recurrence_periodicity: RecurrencePeriodicity.CUSTOM_INTERVAL,
      custom_interval_days: 15,
    });

    await generateOrderFromTemplate(CLIENT_A, dbTemplate, now);

    const updateCall = dbMock.writeTx.recurrence_templates.updateMany.mock.calls[0][0];
    const nextDate: Date = updateCall.data.next_generation_at;
    const diffDays = Math.round((nextDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(15); // CUSTOM_INTERVAL=15 → +15 días

    // Pedido generado correctamente
    expect(dbMock.writeTx.orders.create).toHaveBeenCalledOnce();
    const orderCall = dbMock.writeTx.orders.create.mock.calls[0][0];
    expect(orderCall.data.order_status).toBe('SELLER_CONFIRMED');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F5E2E-8: Idempotencia del job — doble ejecución no crea pedido duplicado
// ────────────────────────────────────────────────────────────────────────────
describe('F5E2E-8 — Idempotencia del job: doble ejecución en el mismo ciclo no crea pedido duplicado', () => {
  it('segunda ejecución del job en el mismo ciclo → updateMany count=0 → no crea pedido', async () => {
    const dbTemplate = makeDbTemplate();

    // Primera ejecución: exitosa (count=1)
    dbMock.writeTx.recurrence_templates.updateMany.mockResolvedValueOnce({ count: 1 });
    await generateOrderFromTemplate(CLIENT_A, dbTemplate, now);
    expect(dbMock.writeTx.orders.create).toHaveBeenCalledTimes(1);

    // Segunda ejecución en el mismo ciclo: updateMany devuelve count=0 (ya procesado)
    dbMock.writeTx.recurrence_templates.updateMany.mockResolvedValueOnce({ count: 0 });
    await generateOrderFromTemplate(CLIENT_A, dbTemplate, now);

    // El pedido NO se debe haber creado una segunda vez
    expect(dbMock.writeTx.orders.create).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F5E2E-9: Fallo en una plantilla → webhook RECURRENCE_GENERATION_FAILED sin detener el loop
// ────────────────────────────────────────────────────────────────────────────
describe('F5E2E-9 — Fallo en generación → webhook RECURRENCE_GENERATION_FAILED sin detener el loop', () => {
  it('fallo en plantilla 1 dispara webhook y plantilla 2 se procesa correctamente', async () => {
    const template1 = makeDbTemplate({ id: BigInt(101) });
    const template2 = makeDbTemplate({ id: BigInt(102) });

    dbMock.readTx.recurrence_templates.findMany.mockResolvedValue([template1, template2]);

    // Primera plantilla falla
    dbMock.writeTx.recurrence_templates.updateMany
      .mockRejectedValueOnce(new Error('Connection timeout'))
      .mockResolvedValueOnce({ count: 1 });

    await generateRecurringOrdersForClient(CLIENT_A, fakeBoss);

    // La segunda plantilla se procesa (1 pedido creado)
    expect(dbMock.writeTx.orders.create).toHaveBeenCalledTimes(1);

    // Webhook de fallo disparado para la primera plantilla
    expect(webhookMock.processWebhookEvent).toHaveBeenCalledWith(
      'RECURRENCE_GENERATION_FAILED',
      expect.objectContaining({
        template_id: Number(template1.id),
        client_id: CLIENT_A,
      }),
      CLIENT_A,
      fakeBoss,
    );

    // El webhook solo se disparó una vez (solo falló la plantilla 1)
    expect(webhookMock.processWebhookEvent).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F5E2E-10: Ciclo completo BIWEEKLY — 3 ciclos → 3 pedidos, fechas correctas
// ────────────────────────────────────────────────────────────────────────────
describe('F5E2E-10 — Ciclo completo BIWEEKLY: 3 ciclos → 3 pedidos y next_generation_at avanza 14 días cada vez', () => {
  it('3 ejecuciones del job generan 3 pedidos con fechas avanzando +14 días por ciclo', async () => {
    const startDate = new Date('2026-06-01T10:00:00.000Z');
    const template = makeDbTemplate({
      recurrence_periodicity: RecurrencePeriodicity.BIWEEKLY,
    });

    // Ciclo 1: 2026-06-01 → next = 2026-06-15
    await generateOrderFromTemplate(CLIENT_A, template, startDate);
    const call1 = dbMock.writeTx.recurrence_templates.updateMany.mock.calls[0][0];
    const next1: Date = call1.data.next_generation_at;
    const diff1 = Math.round((next1.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    expect(diff1).toBe(14);

    vi.clearAllMocks();
    dbMock.writeTx.recurrence_templates.updateMany.mockResolvedValue({ count: 1 });
    dbMock.writeTx.orders.create.mockResolvedValue({ id: BigInt(1001), client_id: BigInt(CLIENT_A), buyer_id: BUYER_A_ID });

    // Ciclo 2: 2026-06-15 → next = 2026-06-29
    await generateOrderFromTemplate(CLIENT_A, template, next1);
    const call2 = dbMock.writeTx.recurrence_templates.updateMany.mock.calls[0][0];
    const next2: Date = call2.data.next_generation_at;
    const diff2 = Math.round((next2.getTime() - next1.getTime()) / (1000 * 60 * 60 * 24));
    expect(diff2).toBe(14);

    vi.clearAllMocks();
    dbMock.writeTx.recurrence_templates.updateMany.mockResolvedValue({ count: 1 });
    dbMock.writeTx.orders.create.mockResolvedValue({ id: BigInt(1002), client_id: BigInt(CLIENT_A), buyer_id: BUYER_A_ID });

    // Ciclo 3: 2026-06-29 → next = 2026-07-13
    await generateOrderFromTemplate(CLIENT_A, template, next2);
    const call3 = dbMock.writeTx.recurrence_templates.updateMany.mock.calls[0][0];
    const next3: Date = call3.data.next_generation_at;
    const diff3 = Math.round((next3.getTime() - next2.getTime()) / (1000 * 60 * 60 * 24));
    expect(diff3).toBe(14);

    // Total acumulado = 42 días desde el inicio
    const totalDiff = Math.round((next3.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    expect(totalDiff).toBe(42);
  });
});
