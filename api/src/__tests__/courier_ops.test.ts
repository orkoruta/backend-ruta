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
import { createCourierOrdersRouter } from '../routes/courier_orders.js';

// ── Mock service ──────────────────────────────────────────────────────────────

const mockService = {
  listAssignedOrders: vi.fn(),
  getOrderById: vi.fn(),
  startShipping: vi.fn(),
  markOutForDelivery: vi.fn(),
  arrive: vi.fn(),
  attemptFailed: vi.fn(),
  markDelivered: vi.fn(),
};

// ── App under test ────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/courier', createCourierOrdersRouter(mockService));
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

const COURIER_TOKEN = 'courier-token';
const ADMIN_TOKEN = 'admin-token';

function stubCourier() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '99',
    client_id: 7,
    user_type: 'COURIER',
    session_id: 1,
  });
}

function stubAdminClient() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '42',
    client_id: 7,
    user_type: 'ADMIN_CLIENT',
    session_id: 2,
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_ORDER = {
  id: 5001,
  client_id: 7,
  buyer_id: 10,
  courier_user_id: 99,
  order_status: 'COURIER_ASSIGNED',
  payment_status: 'PENDING_COLLECTION',
  refund_status: 'REFUND_NOT_REQUIRED',
  return_status: null,
  dispute_status: null,
  delivery_type: 'SHIP',
  delivery_carrier_type: null,
  payment_method: 'CASH_ON_DELIVERY',
  payment_method_submethod: null,
  buyer_type: 'INDIVIDUAL',
  closure_reason: null,
  delivery_address: { line: 'Cra 7 # 100', city: 'Bogotá', state: 'Bogotá D.C.', country: 'CO', postal_code: null, latitude: null, longitude: null, instructions: null },
  pickup_point_id: null,
  subtotal: 50000,
  tax: 0,
  shipping_fee: 0,
  discount: 0,
  total: 50000,
  currency: 'COP',
  version: 1,
  items: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  submitted_at: null,
  delivered_at: null,
  closed_at: null,
};

// ── POST /courier/orders/:id/start-shipping ───────────────────────────────────

describe('POST /courier/orders/:id/start-shipping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — courier can start shipping', async () => {
    stubCourier();
    mockService.startShipping.mockResolvedValue({ ...BASE_ORDER, order_status: 'SHIPPED' });

    const res = await request(app)
      .post('/courier/orders/5001/start-shipping')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'start-ship-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('SHIPPED');
    expect(mockService.startShipping).toHaveBeenCalledWith(7, 5001, 99);
  });

  it('422 — service throws INVALID_STATE_TRANSITION (wrong state)', async () => {
    stubCourier();
    mockService.startShipping.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'Transición no permitida', {
        from: 'IN_TRANSIT',
        to: 'SHIPPED',
      }),
    );

    const res = await request(app)
      .post('/courier/orders/5001/start-shipping')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'start-ship-2');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('401 — unauthenticated request', async () => {
    const res = await request(app)
      .post('/courier/orders/5001/start-shipping')
      .set('X-Idempotency-Key', 'start-ship-3');

    expect(res.status).toBe(401);
  });

  it('403 — ADMIN_CLIENT cannot use courier endpoint', async () => {
    stubAdminClient();

    const res = await request(app)
      .post('/courier/orders/5001/start-shipping')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'start-ship-4');

    expect(res.status).toBe(403);
  });

  it('400 — missing X-Idempotency-Key', async () => {
    stubCourier();

    const res = await request(app)
      .post('/courier/orders/5001/start-shipping')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ── POST /courier/orders/:id/arrive ──────────────────────────────────────────

describe('POST /courier/orders/:id/arrive', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — courier arrives at customer', async () => {
    stubCourier();
    mockService.arrive.mockResolvedValue({ ...BASE_ORDER, order_status: 'ARRIVED_AT_CUSTOMER' });

    const res = await request(app)
      .post('/courier/orders/5001/arrive')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'arrive-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('ARRIVED_AT_CUSTOMER');
    expect(mockService.arrive).toHaveBeenCalledWith(7, 5001, 99);
  });

  it('403 — service throws FORBIDDEN (order not assigned to this courier)', async () => {
    stubCourier();
    mockService.arrive.mockRejectedValue(
      new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti'),
    );

    const res = await request(app)
      .post('/courier/orders/5001/arrive')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'arrive-2');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

// ── POST /courier/orders/:id/attempt-failed ───────────────────────────────────

describe('POST /courier/orders/:id/attempt-failed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — courier records failed attempt with reason', async () => {
    stubCourier();
    mockService.attemptFailed.mockResolvedValue({ ...BASE_ORDER, order_status: 'DELIVERY_ATTEMPTED' });

    const res = await request(app)
      .post('/courier/orders/5001/attempt-failed')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'attempt-1')
      .send({ reason: 'Nadie en casa', notes: 'Se dejó nota en la puerta' });

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('DELIVERY_ATTEMPTED');
    expect(mockService.attemptFailed).toHaveBeenCalledWith(7, 5001, 99, 'Nadie en casa', 'Se dejó nota en la puerta');
  });

  it('400 — body vacío (Zod validation fails on missing reason)', async () => {
    stubCourier();

    const res = await request(app)
      .post('/courier/orders/5001/attempt-failed')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'attempt-2')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ── POST /courier/orders/:id/mark-delivered ───────────────────────────────────

describe('POST /courier/orders/:id/mark-delivered', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — courier marks order as delivered', async () => {
    stubCourier();
    mockService.markDelivered.mockResolvedValue({ ...BASE_ORDER, order_status: 'DELIVERED', delivered_at: new Date().toISOString() });

    const res = await request(app)
      .post('/courier/orders/5001/mark-delivered')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'delivered-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('DELIVERED');
    expect(mockService.markDelivered).toHaveBeenCalledWith(7, 5001, 99);
  });

  it('422 — service throws INVALID_STATE_TRANSITION (wrong state)', async () => {
    stubCourier();
    mockService.markDelivered.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'Transición no permitida', {
        from: 'OUT_FOR_DELIVERY',
        to: 'DELIVERED',
      }),
    );

    const res = await request(app)
      .post('/courier/orders/5001/mark-delivered')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'delivered-2');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

// ── GET /courier/orders/assigned ─────────────────────────────────────────────

describe('GET /courier/orders/assigned', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — returns active orders and completed_today count', async () => {
    stubCourier();
    mockService.listAssignedOrders.mockResolvedValue({
      active: [{ ...BASE_ORDER, order_status: 'COURIER_ASSIGNED' }],
      completed_today: 3,
    });

    const res = await request(app)
      .get('/courier/orders/assigned')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'list-1');

    expect(res.status).toBe(200);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.completed_today).toBe(3);
    expect(mockService.listAssignedOrders).toHaveBeenCalledWith(7, 99);
  });

  it('401 — unauthenticated request', async () => {
    const res = await request(app)
      .get('/courier/orders/assigned')
      .set('X-Idempotency-Key', 'list-2');

    expect(res.status).toBe(401);
  });
});
