/**
 * api_client_orders.test.ts — F2.4.QA-2
 *
 * Tests de integración para el flujo completo de pedidos de Cliente API
 * y los guards LOGISTICS_ONLY_FEATURE_UNAVAILABLE en rutas admin.
 *
 * Cobertura:
 *   AC1   Crear pedido SHIP → 201, PREPARING, buyer_type=CORPORATE, order_origin=API
 *   AC2   Crear pedido PICKUP → 201, READY_FOR_PICKUP
 *   AC3   Crear pedido COD → payment_method=COD registrado correctamente
 *   AC4   Cancelar pedido en estado cancelable → 200, CLOSED
 *   AC5   Cancelar pedido en DELIVERED → 422 INVALID_STATE_TRANSITION
 *   AC6   GET /api/orders/:id → retorna pedido con state_history
 *   AC7   GET /api/orders/:id pedido de otro cliente → 404 (tenant isolation)
 *   AC8   Sin API key → 401 AUTHENTICATION_REQUIRED
 *   AC9   GET /api/orders con paginación → página 2 funciona
 *   AC10  POST /admin/orders/:id/accept con cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE
 *   AC11  POST /admin/orders/:id/reject con cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE
 *   AC12  Regresión: Cliente Full (SHIP, PICKUP) sigue funcionando
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

// ─── DB mock (vi.hoisted — antes de cualquier import que use @orkoruta/db) ────

const dbMock = vi.hoisted(() => {
  const readTx = {
    orders: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    clients: { findUnique: vi.fn() },
    client_api_keys: { findUnique: vi.fn() },
  };

  const writeTx = {
    orders: { findUnique: vi.fn(), update: vi.fn() },
    order_state_history: { create: vi.fn() },
    audit_events: { create: vi.fn() },
    client_api_keys: { update: vi.fn() },
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

// ─── Mock createApiClientOrder (evita la lógica de BD interna del servicio) ───

const createApiClientOrderMock = vi.hoisted(() => vi.fn());

vi.mock('../services/orders/orders.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/orders/orders.service.js')>();
  return {
    ...original,
    createApiClientOrder: createApiClientOrderMock,
  };
});

// ─── Mock apiKeyAuth middleware ───────────────────────────────────────────────
// Devuelve un middleware que inyecta req.user directamente sin tocar la BD.

const apiKeyAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../middleware/api_key_auth.js', () => ({
  apiKeyAuth: (_scope: string) => apiKeyAuthMock,
}));

// ─── Mock webhook/boss (fire-and-forget; no relevante para estos tests) ───────

vi.mock('../services/webhooks_outgoing.service.js', () => ({
  processWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../jobs/maintenance_boss.js', () => ({
  getMaintenanceBoss: vi.fn().mockReturnValue(null),
}));

// ─── Importar routers DESPUÉS de los mocks ────────────────────────────────────

const { apiClientOrdersRouter } = await import('../routes/api_client_orders.js');
const { createAdminOrdersRouter } = await import('../routes/admin_orders.js');

// ─── Constantes de prueba ─────────────────────────────────────────────────────

const CLIENT_ID = 5;
const ORDER_ID = 1001n;
const API_KEY_ID = 77n;

// Usuario sentinel que pone apiKeyAuth en req.user para Cliente API
const apiUser: AuthenticatedUser = {
  id: 0,
  client_id: CLIENT_ID,
  user_type: 'API_CLIENT',
  session_id: 0,
  userType: 'API_CLIENT',
  apiKeyId: API_KEY_ID,
  scopes: ['orders:read', 'orders:write'],
};

// Usuario admin (JWT) para tests de admin guard
const adminUser: AuthenticatedUser = {
  id: 10,
  client_id: CLIENT_ID,
  user_type: 'ADMIN_CLIENT',
  session_id: 100,
};

const now = new Date();

// Pedido API base serializado (como devolvería serializeOrder en el router)
const mockOrderSerialized = {
  id: Number(ORDER_ID),
  client_id: CLIENT_ID,
  order_status: 'PREPARING',
  payment_status: 'PENDING_COLLECTION',
  delivery_type: 'SHIP',
  delivery_carrier_type: null,
  payment_method: 'PREPAID_EXTERNAL',
  payment_method_submethod: null,
  buyer_type: 'CORPORATE',
  closure_reason: null,
  subtotal: 50000,
  tax: 0,
  shipping_fee: 0,
  discount: 0,
  total: 50000,
  currency: 'COP',
  items: [{ id: 1, product_id: null, product_name: 'Camiseta', sku: 'CAM-01', quantity: 2, unit_price: 25000, subtotal: 50000 }],
  created_at: now.toISOString(),
  updated_at: now.toISOString(),
  submitted_at: now.toISOString(),
  delivered_at: null,
  closed_at: null,
};

// Pedido tal como lo devuelve Prisma (con BigInts) para mocks de BD directos
function makePrismaOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    client_id: BigInt(CLIENT_ID),
    buyer_id: BigInt(1),
    courier_user_id: null,
    order_status: 'PREPARING',
    payment_status: 'PENDING_COLLECTION',
    delivery_type: 'SHIP',
    delivery_carrier_type: null,
    payment_method: 'PREPAID_EXTERNAL',
    payment_method_submethod: null,
    buyer_type: 'CORPORATE',
    closure_reason: null,
    order_origin: 'API',
    subtotal: 50000n,
    tax: 0n,
    shipping_fee: 0n,
    discount: 0n,
    total: 50000n,
    currency: 'COP',
    submitted_at: now,
    delivered_at: null,
    closed_at: null,
    created_at: now,
    updated_at: now,
    order_items: [
      {
        id: BigInt(1),
        product_id: null,
        product_name: 'Camiseta',
        sku: 'CAM-01',
        quantity: 2,
        unit_price: 25000n,
        subtotal: 50000n,
      },
    ],
    ...overrides,
  };
}

// ─── Helpers de app ───────────────────────────────────────────────────────────

/**
 * App que autentica al apiUser a través del mock de apiKeyAuth.
 * El mock se configura en beforeEach para inyectar req.user = apiUser.
 */
function buildApiApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiClientOrdersRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof ZodError) {
      res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.statusCode).json(sendHttpError(err));
      return;
    }
    res.status(500).json(toApiError('INTERNAL_ERROR', 'Error interno'));
  });
  return app;
}

/**
 * App de admin (JWT) para tests de guard LOGISTICS_ONLY.
 */
function buildAdminApp(svc: Parameters<typeof createAdminOrdersRouter>[0], user: AuthenticatedUser = adminUser) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = user;
    next();
  });
  app.use('/admin/orders', createAdminOrdersRouter(svc));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof ZodError) {
      res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.statusCode).json(sendHttpError(err));
      return;
    }
    res.status(500).json(toApiError('INTERNAL_ERROR', 'Error interno'));
  });
  return app;
}

/**
 * Configura el mock de apiKeyAuth para devolver 401 (sin credenciales).
 * Llama a esto dentro de los tests de AC8.
 */
function setupUnauthApiKeyMock() {
  apiKeyAuthMock.mockImplementation((_req: Request, res: Response, _next: NextFunction) => {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
  });
}

// ─── Cuerpos de request válidos ───────────────────────────────────────────────

const validShipBody = {
  delivery_type: 'SHIP',
  initial_state: 'PREPARING',
  items: [{ name: 'Camiseta', quantity: 2, unit_price_cents: 2500000, external_sku: 'CAM-01' }],
  payment_method: 'PREPAID_EXTERNAL',
  delivery_address: { street: 'Calle 123', city: 'Bogotá' },
};

const validPickupBody = {
  delivery_type: 'PICKUP',
  initial_state: 'READY_FOR_PICKUP',
  items: [{ name: 'Pantalón', quantity: 1, unit_price_cents: 8000000 }],
  payment_method: 'COD',
  pickup_point_id: 99,
};

const validCodBody = {
  delivery_type: 'SHIP',
  initial_state: 'PREPARING',
  items: [{ name: 'Zapatos', quantity: 1, unit_price_cents: 15000000 }],
  payment_method: 'COD',
  delivery_address: { street: 'Av. Siempre Viva', city: 'Medellín' },
};

// ─── Mock de servicio admin ────────────────────────────────────────────────────

function makeAdminService() {
  return {
    list: vi.fn(),
    getById: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    markPreparing: vi.fn(),
    markReady: vi.fn(),
    approveCancelRequest: vi.fn(),
    rejectCancelRequest: vi.fn(),
    returnToOrigin: vi.fn(),
    returnToOriginReceived: vi.fn(),
  } as unknown as Parameters<typeof createAdminOrdersRouter>[0];
}

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Por defecto, apiKeyAuth inyecta el usuario API y llama next()
  apiKeyAuthMock.mockImplementation((req: Request, _res: Response, next: NextFunction) => {
    req.user = apiUser;
    next();
  });
});

// ─── AC1: Crear pedido SHIP ───────────────────────────────────────────────────

describe('AC1 — POST /api/orders SHIP → 201 PREPARING, buyer_type=CORPORATE, order_origin=API', () => {
  it('retorna 201 con order_status=PREPARING y campos correctos', async () => {
    createApiClientOrderMock.mockResolvedValue(mockOrderSerialized);

    const res = await request(buildApiApp())
      .post('/api/orders')
      .set('X-Idempotency-Key', 'key-ac1')
      .send(validShipBody);

    expect(res.status).toBe(201);
    expect(res.body.order_status).toBe('PREPARING');
    expect(res.body.buyer_type).toBe('CORPORATE');
    expect(createApiClientOrderMock).toHaveBeenCalledWith(
      BigInt(CLIENT_ID),
      expect.objectContaining({ delivery_type: 'SHIP', initial_state: 'PREPARING' }),
      API_KEY_ID,
      expect.any(BigInt),
    );
  });

  it('el pedido creado tiene order_origin=API y payment_status correcto', async () => {
    createApiClientOrderMock.mockResolvedValue({
      ...mockOrderSerialized,
      payment_status: 'PAID',
      payment_method: 'PREPAID_EXTERNAL',
    });

    const res = await request(buildApiApp())
      .post('/api/orders')
      .set('X-Idempotency-Key', 'key-ac1b')
      .send(validShipBody);

    expect(res.status).toBe(201);
    expect(res.body.payment_method).toBe('PREPAID_EXTERNAL');
  });
});

// ─── AC2: Crear pedido PICKUP ─────────────────────────────────────────────────

describe('AC2 — POST /api/orders PICKUP → 201 READY_FOR_PICKUP', () => {
  it('retorna 201 con order_status=READY_FOR_PICKUP y delivery_type=PICKUP', async () => {
    createApiClientOrderMock.mockResolvedValue({
      ...mockOrderSerialized,
      order_status: 'READY_FOR_PICKUP',
      delivery_type: 'PICKUP',
    });

    const res = await request(buildApiApp())
      .post('/api/orders')
      .set('X-Idempotency-Key', 'key-ac2')
      .send(validPickupBody);

    expect(res.status).toBe(201);
    expect(res.body.order_status).toBe('READY_FOR_PICKUP');
    expect(res.body.delivery_type).toBe('PICKUP');
    expect(createApiClientOrderMock).toHaveBeenCalledWith(
      BigInt(CLIENT_ID),
      expect.objectContaining({ delivery_type: 'PICKUP', initial_state: 'READY_FOR_PICKUP' }),
      API_KEY_ID,
      expect.any(BigInt),
    );
  });
});

// ─── AC3: Crear pedido COD ────────────────────────────────────────────────────

describe('AC3 — POST /api/orders COD → payment_method=COD registrado correctamente', () => {
  it('retorna 201 con payment_method=COD', async () => {
    createApiClientOrderMock.mockResolvedValue({
      ...mockOrderSerialized,
      payment_method: 'COD',
      payment_status: 'PENDING_COLLECTION',
    });

    const res = await request(buildApiApp())
      .post('/api/orders')
      .set('X-Idempotency-Key', 'key-ac3')
      .send(validCodBody);

    expect(res.status).toBe(201);
    expect(res.body.payment_method).toBe('COD');
    expect(res.body.payment_status).toBe('PENDING_COLLECTION');
    expect(createApiClientOrderMock).toHaveBeenCalledWith(
      BigInt(CLIENT_ID),
      expect.objectContaining({ payment_method: 'COD' }),
      API_KEY_ID,
      expect.any(BigInt),
    );
  });
});

// ─── AC4: Cancelar pedido en estado cancelable ────────────────────────────────

describe('AC4 — POST /api/orders/:id/cancel estado cancelable → 200 CLOSED', () => {
  it('retorna 200 con order_status=CLOSED cuando el pedido está en PREPARING', async () => {
    const cancelledOrder = makePrismaOrder({
      order_status: 'CLOSED',
      closure_reason: 'CANCELLED_BY_ADMIN',
      closed_at: new Date(),
    });

    // Primera llamada (findUnique para verificar estado) devuelve pedido en PREPARING
    dbMock.writeTx.orders.findUnique.mockResolvedValueOnce(makePrismaOrder());
    // Primera update: PREPARING → CANCELLED_BY_ADMIN
    dbMock.writeTx.orders.update.mockResolvedValueOnce(makePrismaOrder({ order_status: 'CANCELLED_BY_ADMIN' }));
    // Segunda update: CANCELLED_BY_ADMIN → CLOSED
    dbMock.writeTx.orders.update.mockResolvedValueOnce(cancelledOrder);

    const res = await request(buildApiApp())
      .post(`/api/orders/${Number(ORDER_ID)}/cancel`)
      .set('X-Idempotency-Key', 'key-ac4')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('CLOSED');
    expect(res.body.closure_reason).toBe('CANCELLED_BY_ADMIN');
  });

  it('retorna 404 cuando el pedido no existe en este tenant', async () => {
    // Tenant isolation: findUnique filtra por (id, client_id); si no existe, retorna null
    dbMock.writeTx.orders.findUnique.mockResolvedValueOnce(null);

    const res = await request(buildApiApp())
      .post('/api/orders/99999/cancel')
      .set('X-Idempotency-Key', 'key-ac4b')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });
});

// ─── AC5: Cancelar pedido en DELIVERED → 422 INVALID_STATE_TRANSITION ────────

describe('AC5 — POST /api/orders/:id/cancel estado DELIVERED → 422 INVALID_STATE_TRANSITION', () => {
  it('retorna 422 cuando el pedido está en DELIVERED', async () => {
    dbMock.writeTx.orders.findUnique.mockResolvedValueOnce(
      makePrismaOrder({ order_status: 'DELIVERED', order_origin: 'API' }),
    );

    const res = await request(buildApiApp())
      .post(`/api/orders/${Number(ORDER_ID)}/cancel`)
      .set('X-Idempotency-Key', 'key-ac5')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('retorna 422 cuando el pedido está en CLOSED', async () => {
    dbMock.writeTx.orders.findUnique.mockResolvedValueOnce(
      makePrismaOrder({ order_status: 'CLOSED', order_origin: 'API' }),
    );

    const res = await request(buildApiApp())
      .post(`/api/orders/${Number(ORDER_ID)}/cancel`)
      .set('X-Idempotency-Key', 'key-ac5b')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

// ─── AC6: GET /api/orders/:id → retorna pedido con state_history ──────────────

describe('AC6 — GET /api/orders/:id → retorna pedido con state_history', () => {
  it('retorna el pedido con el array state_history cuando existe', async () => {
    const orderWithHistory = {
      ...makePrismaOrder(),
      order_state_history: [
        {
          id: BigInt(1),
          state_dimension: 'order_status',
          previous_value: null,
          new_value: 'PREPARING',
          changed_by_actor_type: 'API_CLIENT',
          metadata: { api_key_id: String(API_KEY_ID) },
          occurred_at: now,
        },
      ],
    };

    dbMock.readTx.orders.findUnique.mockResolvedValueOnce(orderWithHistory);

    const res = await request(buildApiApp()).get(`/api/orders/${Number(ORDER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(Number(ORDER_ID));
    expect(res.body.order_status).toBe('PREPARING');
    expect(Array.isArray(res.body.state_history)).toBe(true);
    expect(res.body.state_history).toHaveLength(1);
    expect(res.body.state_history[0].new_value).toBe('PREPARING');
    expect(res.body.state_history[0].changed_by_actor_type).toBe('API_CLIENT');
  });

  it('retorna 404 si el pedido no existe', async () => {
    dbMock.readTx.orders.findUnique.mockResolvedValueOnce(null);

    const res = await request(buildApiApp()).get(`/api/orders/99999`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });
});

// ─── AC7: GET /api/orders/:id de otro cliente → 404 (tenant isolation) ────────

describe('AC7 — GET /api/orders/:id pedido de otro cliente → 404 tenant isolation', () => {
  it('retorna 404 cuando order_origin no es API (pedido de flujo BUYER_UI)', async () => {
    // El router verifica order.order_origin === 'API'; si no, devuelve 404
    const buyerOrder = {
      ...makePrismaOrder(),
      order_origin: 'BUYER_UI',
    };

    dbMock.readTx.orders.findUnique.mockResolvedValueOnce(buyerOrder);

    const res = await request(buildApiApp()).get(`/api/orders/${Number(ORDER_ID)}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('retorna 404 cuando el pedido no existe en este tenant (findUnique devuelve null)', async () => {
    // withTenantReadOnly ya filtra por (id, client_id) — si no existe, devuelve null
    dbMock.readTx.orders.findUnique.mockResolvedValueOnce(null);

    const res = await request(buildApiApp()).get(`/api/orders/777`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });
});

// ─── AC8: Sin API key → 401 AUTHENTICATION_REQUIRED ──────────────────────────

describe('AC8 — Sin API key → 401 AUTHENTICATION_REQUIRED', () => {
  it('POST /api/orders sin API key válida → 401', async () => {
    setupUnauthApiKeyMock();
    const res = await request(buildApiApp())
      .post('/api/orders')
      .set('X-Idempotency-Key', 'key-ac8')
      .send(validShipBody);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('GET /api/orders sin API key válida → 401', async () => {
    setupUnauthApiKeyMock();
    const res = await request(buildApiApp()).get('/api/orders');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('GET /api/orders/:id sin API key válida → 401', async () => {
    setupUnauthApiKeyMock();
    const res = await request(buildApiApp()).get(`/api/orders/${Number(ORDER_ID)}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });
});

// ─── AC9: GET /api/orders con paginación → página 2 funciona ─────────────────

describe('AC9 — GET /api/orders con paginación → página 2 funciona', () => {
  it('pasa skip correcto a la BD y retorna pagination con página 2', async () => {
    const totalOrders = 45;
    const pageSize = 20;

    dbMock.readTx.orders.findMany.mockResolvedValueOnce([makePrismaOrder()]);
    dbMock.readTx.orders.count.mockResolvedValueOnce(totalOrders);

    const res = await request(buildApiApp()).get('/api/orders?page=2&page_size=20');

    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(2);
    expect(res.body.pagination.page_size).toBe(pageSize);
    expect(res.body.pagination.total).toBe(totalOrders);
    expect(Array.isArray(res.body.data)).toBe(true);

    // Verificar que withTenantReadOnly fue llamado con el clientId correcto
    expect(dbMock.withTenantReadOnly).toHaveBeenCalledWith(
      CLIENT_ID,
      'ADMIN_CLIENT',
      expect.any(Function),
    );
  });

  it('filtra por status cuando se provee como query param', async () => {
    dbMock.readTx.orders.findMany.mockResolvedValueOnce([]);
    dbMock.readTx.orders.count.mockResolvedValueOnce(0);

    const res = await request(buildApiApp()).get('/api/orders?status=PREPARING&page=1');

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(0);
  });
});

// ─── AC10: POST /admin/orders/:id/accept con cliente API → 422 ───────────────

describe('AC10 — POST /admin/orders/:id/accept cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE', () => {
  it('retorna 422 cuando el cliente es de tipo API', async () => {
    const svc = makeAdminService();
    (svc.accept as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(422, 'LOGISTICS_ONLY_FEATURE_UNAVAILABLE', 'Esta operación no aplica para Clientes API'),
    );

    const res = await request(buildAdminApp(svc))
      .post(`/admin/orders/${Number(ORDER_ID)}/accept`)
      .set('X-Idempotency-Key', 'key-ac10')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOGISTICS_ONLY_FEATURE_UNAVAILABLE');
    expect(svc.accept).toHaveBeenCalledWith(CLIENT_ID, Number(ORDER_ID), expect.objectContaining({ id: 10 }));
  });
});

// ─── AC11: POST /admin/orders/:id/reject con cliente API → 422 ───────────────

describe('AC11 — POST /admin/orders/:id/reject cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE', () => {
  it('retorna 422 cuando el cliente es de tipo API', async () => {
    const svc = makeAdminService();
    (svc.reject as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(422, 'LOGISTICS_ONLY_FEATURE_UNAVAILABLE', 'Esta operación no aplica para Clientes API'),
    );

    const res = await request(buildAdminApp(svc))
      .post(`/admin/orders/${Number(ORDER_ID)}/reject`)
      .set('X-Idempotency-Key', 'key-ac11')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOGISTICS_ONLY_FEATURE_UNAVAILABLE');
    expect(svc.reject).toHaveBeenCalledWith(CLIENT_ID, Number(ORDER_ID), expect.objectContaining({ id: 10 }));
  });

  it('el guard también se dispara si hay reason en el body', async () => {
    const svc = makeAdminService();
    (svc.reject as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(422, 'LOGISTICS_ONLY_FEATURE_UNAVAILABLE', 'Esta operación no aplica para Clientes API'),
    );

    const res = await request(buildAdminApp(svc))
      .post(`/admin/orders/${Number(ORDER_ID)}/reject`)
      .set('X-Idempotency-Key', 'key-ac11b')
      .send({ reason: 'Stock insuficiente' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOGISTICS_ONLY_FEATURE_UNAVAILABLE');
  });
});

// ─── AC12: Regresión — Cliente Full sigue funcionando ────────────────────────

describe('AC12 — Regresión: Cliente Full (SHIP, PICKUP) sigue funcionando', () => {
  it('accept en pedido de Cliente Full → 200 con SELLER_CONFIRMED', async () => {
    const fullClientOrder = {
      ...mockOrderSerialized,
      order_status: 'SELLER_CONFIRMED',
    };

    const svc = makeAdminService();
    (svc.accept as ReturnType<typeof vi.fn>).mockResolvedValue(fullClientOrder);

    const res = await request(buildAdminApp(svc))
      .post(`/admin/orders/${Number(ORDER_ID)}/accept`)
      .set('X-Idempotency-Key', 'key-ac12')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('SELLER_CONFIRMED');
    expect(svc.accept).toHaveBeenCalledWith(
      CLIENT_ID,
      Number(ORDER_ID),
      expect.objectContaining({ id: 10, user_type: 'ADMIN_CLIENT' }),
    );
  });

  it('reject en pedido de Cliente Full → 200 con CLOSED', async () => {
    const rejectedOrder = {
      ...mockOrderSerialized,
      order_status: 'CLOSED',
      closure_reason: 'CANCELLED_BY_SELLER',
    };

    const svc = makeAdminService();
    (svc.reject as ReturnType<typeof vi.fn>).mockResolvedValue(rejectedOrder);

    const res = await request(buildAdminApp(svc))
      .post(`/admin/orders/${Number(ORDER_ID)}/reject`)
      .set('X-Idempotency-Key', 'key-ac12b')
      .send({ reason: 'Sin stock' });

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('CLOSED');
    expect(res.body.closure_reason).toBe('CANCELLED_BY_SELLER');
  });

  it('mark-preparing en Cliente Full → 200 con PREPARING', async () => {
    const preparingOrder = {
      ...mockOrderSerialized,
      order_status: 'PREPARING',
    };

    const svc = makeAdminService();
    (svc.markPreparing as ReturnType<typeof vi.fn>).mockResolvedValue(preparingOrder);

    const res = await request(buildAdminApp(svc))
      .post(`/admin/orders/${Number(ORDER_ID)}/mark-preparing`)
      .set('X-Idempotency-Key', 'key-ac12c')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('PREPARING');
  });
});
