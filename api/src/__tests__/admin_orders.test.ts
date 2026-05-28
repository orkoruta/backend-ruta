import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ── Auth mock (must be before app import) ─────────────────────────────────────

const mockVerifyAccessToken = vi.fn();

vi.mock('../lib/token.js', () => ({
  verifyAccessToken: (...args: unknown[]) => mockVerifyAccessToken(...args),
}));

vi.mock('../middleware/logger.js', () => ({
  loggerMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import app + service factory ──────────────────────────────────────────────

import express from 'express';
import cookieParser from 'cookie-parser';
import { authenticate } from '../middleware/auth.js';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import { createAdminOrdersRouter } from '../routes/admin_orders.js';

// ── Mock service ──────────────────────────────────────────────────────────────

const mockService = {
  list: vi.fn(),
  getById: vi.fn(),
  accept: vi.fn(),
  reject: vi.fn(),
  markPreparing: vi.fn(),
  markReady: vi.fn(),
};

// ── App under test ────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/admin/orders', createAdminOrdersRouter(mockService));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.statusCode).json(sendHttpError(err));
      return;
    }
    res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno'));
  });
  return app;
}

const app = buildApp();

// ── Token helpers ─────────────────────────────────────────────────────────────

const ADMIN_TOKEN = 'admin-token';
const OPERATOR_TOKEN = 'operator-token';
const BUYER_TOKEN = 'buyer-token';

function stubAdminClient() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '42',
    client_id: 7,
    user_type: 'ADMIN_CLIENT',
    session_id: 1,
  });
}

function stubOperator() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '99',
    client_id: 7,
    user_type: 'OPERATOR_CLIENT',
    session_id: 2,
  });
}

function stubBuyer() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '10',
    client_id: 7,
    user_type: 'BUYER',
    session_id: 3,
  });
}

const BASE_ORDER = {
  id: 5001,
  client_id: 7,
  buyer_id: 10,
  courier_user_id: null,
  order_status: 'SELLER_CONFIRMED',
  payment_status: 'PENDING_COLLECTION',
  delivery_type: 'SHIP',
  delivery_carrier_type: null,
  payment_method: 'ON_DELIVERY',
  payment_method_submethod: null,
  closure_reason: null,
  subtotal: 105000,
  total: 105000,
  currency: 'COP',
  items: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  submitted_at: null,
};

// ── GET /admin/orders ─────────────────────────────────────────────────────────

describe('GET /admin/orders', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — returns order list for ADMIN_CLIENT', async () => {
    stubAdminClient();
    mockService.list.mockResolvedValue({ data: [BASE_ORDER], pagination: { page: 1, page_size: 20, total: 1 } });

    const res = await request(app)
      .get('/admin/orders')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'test-key-get');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('200 — returns order list for OPERATOR_CLIENT', async () => {
    stubOperator();
    mockService.list.mockResolvedValue({ data: [], pagination: { page: 1, page_size: 20, total: 0 } });

    const res = await request(app)
      .get('/admin/orders')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .set('X-Idempotency-Key', 'test-key-op');

    expect(res.status).toBe(200);
  });

  it('401 — without auth token', async () => {
    const res = await request(app)
      .get('/admin/orders')
      .set('X-Idempotency-Key', 'test-key-noauth');

    expect(res.status).toBe(401);
  });

  it('403 — BUYER cannot list admin orders', async () => {
    stubBuyer();
    const res = await request(app)
      .get('/admin/orders')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .set('X-Idempotency-Key', 'test-key-buyer');

    expect(res.status).toBe(403);
  });
});

// ── POST /admin/orders/:id/accept ─────────────────────────────────────────────

describe('POST /admin/orders/:id/accept', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT can accept a validated order', async () => {
    stubAdminClient();
    mockService.accept.mockResolvedValue({ ...BASE_ORDER, order_status: 'SELLER_CONFIRMED' });

    const res = await request(app)
      .post('/admin/orders/5001/accept')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'accept-key-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('SELLER_CONFIRMED');
    expect(mockService.accept).toHaveBeenCalledWith(7, 5001, expect.objectContaining({ user_type: 'ADMIN_CLIENT' }));
  });

  it('400 — missing X-Idempotency-Key', async () => {
    stubAdminClient();

    const res = await request(app)
      .post('/admin/orders/5001/accept')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('401 — unauthenticated request', async () => {
    const res = await request(app)
      .post('/admin/orders/5001/accept')
      .set('X-Idempotency-Key', 'k1');

    expect(res.status).toBe(401);
  });

  it('403 — BUYER cannot accept', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/admin/orders/5001/accept')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .set('X-Idempotency-Key', 'k2');

    expect(res.status).toBe(403);
  });

  it('422 — service throws INVALID_STATE_TRANSITION', async () => {
    stubAdminClient();
    mockService.accept.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'Transición no permitida', { from: 'DRAFT', to: 'SELLER_CONFIRMED' }),
    );

    const res = await request(app)
      .post('/admin/orders/5001/accept')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'k3');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

// ── POST /admin/orders/:id/reject ─────────────────────────────────────────────

describe('POST /admin/orders/:id/reject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT can reject a validated order', async () => {
    stubAdminClient();
    mockService.reject.mockResolvedValue({ ...BASE_ORDER, order_status: 'CLOSED', closure_reason: 'CANCELLED_BY_SELLER' });

    const res = await request(app)
      .post('/admin/orders/5001/reject')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'reject-key-1')
      .send({ reason: 'Producto sin stock' });

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('CLOSED');
  });

  it('403 — OPERATOR_CLIENT cannot reject (seller acceptance restricted)', async () => {
    stubOperator();
    const res = await request(app)
      .post('/admin/orders/5001/reject')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .set('X-Idempotency-Key', 'reject-key-2');

    expect(res.status).toBe(403);
  });
});

// ── POST /admin/orders/:id/mark-preparing ────────────────────────────────────

describe('POST /admin/orders/:id/mark-preparing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT marks order as preparing', async () => {
    stubAdminClient();
    mockService.markPreparing.mockResolvedValue({ ...BASE_ORDER, order_status: 'PREPARING' });

    const res = await request(app)
      .post('/admin/orders/5001/mark-preparing')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'prep-key-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('PREPARING');
  });

  it('200 — OPERATOR_CLIENT can mark preparing', async () => {
    stubOperator();
    mockService.markPreparing.mockResolvedValue({ ...BASE_ORDER, order_status: 'PREPARING' });

    const res = await request(app)
      .post('/admin/orders/5001/mark-preparing')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .set('X-Idempotency-Key', 'prep-key-2');

    expect(res.status).toBe(200);
  });

  it('403 — BUYER cannot mark preparing', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/admin/orders/5001/mark-preparing')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .set('X-Idempotency-Key', 'prep-key-3');

    expect(res.status).toBe(403);
  });
});

// ── POST /admin/orders/:id/mark-ready ────────────────────────────────────────

describe('POST /admin/orders/:id/mark-ready', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — marks SHIP order as READY_TO_SHIP', async () => {
    stubAdminClient();
    mockService.markReady.mockResolvedValue({ ...BASE_ORDER, order_status: 'READY_TO_SHIP' });

    const res = await request(app)
      .post('/admin/orders/5001/mark-ready')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'ready-key-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('READY_TO_SHIP');
    expect(mockService.markReady).toHaveBeenCalledWith(7, 5001, expect.anything(), undefined);
  });

  it('200 — marks SHIP/OWN_FLEET order as AWAITING_COURIER_ASSIGNMENT', async () => {
    stubAdminClient();
    mockService.markReady.mockResolvedValue({ ...BASE_ORDER, order_status: 'AWAITING_COURIER_ASSIGNMENT' });

    const res = await request(app)
      .post('/admin/orders/5001/mark-ready')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'ready-key-2')
      .send({ delivery_carrier_type: 'OWN_FLEET' });

    expect(res.status).toBe(200);
    expect(mockService.markReady).toHaveBeenCalledWith(7, 5001, expect.anything(), 'OWN_FLEET');
  });

  it('400 — invalid delivery_carrier_type value', async () => {
    stubAdminClient();
    const res = await request(app)
      .post('/admin/orders/5001/mark-ready')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'ready-key-3')
      .send({ delivery_carrier_type: 'INVALID_VALUE' });

    expect(res.status).toBe(400);
  });

  it('200 — OPERATOR_CLIENT can mark ready', async () => {
    stubOperator();
    mockService.markReady.mockResolvedValue({ ...BASE_ORDER, order_status: 'READY_TO_SHIP' });

    const res = await request(app)
      .post('/admin/orders/5001/mark-ready')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .set('X-Idempotency-Key', 'ready-key-4');

    expect(res.status).toBe(200);
  });
});
