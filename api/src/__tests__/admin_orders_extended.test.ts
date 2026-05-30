/**
 * admin_orders_extended.test.ts — 6.QA-2
 *
 * Extiende la cobertura de admin_orders.ts:
 *  - GET /admin/orders/:id
 *  - POST /admin/orders/:id/approve-cancel-request
 *  - POST /admin/orders/:id/reject-cancel-request
 *  - POST /admin/orders/:id/return-to-origin
 *  - POST /admin/orders/:id/return-to-origin-received
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ── Auth mock ──────────────────────────────────────────────────────────────────

const mockVerifyAccessToken = vi.fn();

vi.mock('../lib/token.js', () => ({
  verifyAccessToken: (...args: unknown[]) => mockVerifyAccessToken(...args),
}));

vi.mock('../middleware/logger.js', () => ({
  loggerMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── App setup ─────────────────────────────────────────────────────────────────

import express from 'express';
import cookieParser from 'cookie-parser';
import { authenticate } from '../middleware/auth.js';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import { createAdminOrdersRouter } from '../routes/admin_orders.js';

const mockService = {
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
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/admin/orders', createAdminOrdersRouter(mockService as Parameters<typeof createAdminOrdersRouter>[0]));
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

// ── Token stubs ───────────────────────────────────────────────────────────────

function stubAdmin() {
  mockVerifyAccessToken.mockResolvedValue({ sub: '21', client_id: 1, user_type: 'ADMIN_CLIENT', session_id: 1 });
}

function stubOperator() {
  mockVerifyAccessToken.mockResolvedValue({ sub: '22', client_id: 1, user_type: 'OPERATOR_CLIENT', session_id: 2 });
}

function stubBuyer() {
  mockVerifyAccessToken.mockResolvedValue({ sub: '41', client_id: 1, user_type: 'BUYER', session_id: 3 });
}

const BASE_ORDER = {
  id: 701,
  client_id: 1,
  buyer_id: 41,
  courier_user_id: null,
  order_status: 'CUSTOMER_CANCEL_REQUEST',
  payment_status: 'PAID',
  delivery_type: 'SHIP',
  delivery_carrier_type: null,
  payment_method: 'ONLINE_AT_ORDER',
  payment_method_submethod: null,
  closure_reason: null,
  subtotal: 85000,
  total: 93000,
  currency: 'COP',
  items: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  submitted_at: new Date().toISOString(),
};

// ── GET /admin/orders/:id ─────────────────────────────────────────────────────

describe('GET /admin/orders/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT gets order by id', async () => {
    stubAdmin();
    mockService.getById.mockResolvedValue(BASE_ORDER);

    const res = await request(app)
      .get('/admin/orders/701')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'getbyid-1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(701);
    expect(mockService.getById).toHaveBeenCalledWith(1, 701);
  });

  it('200 — OPERATOR_CLIENT can get order by id', async () => {
    stubOperator();
    mockService.getById.mockResolvedValue(BASE_ORDER);

    const res = await request(app)
      .get('/admin/orders/701')
      .set('Authorization', 'Bearer op-token')
      .set('X-Idempotency-Key', 'getbyid-2');

    expect(res.status).toBe(200);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .get('/admin/orders/701')
      .set('X-Idempotency-Key', 'getbyid-3');

    expect(res.status).toBe(401);
  });

  it('403 — BUYER cannot get admin order', async () => {
    stubBuyer();
    const res = await request(app)
      .get('/admin/orders/701')
      .set('Authorization', 'Bearer buyer-token')
      .set('X-Idempotency-Key', 'getbyid-4');

    expect(res.status).toBe(403);
  });

  it('404 — service throws not found', async () => {
    stubAdmin();
    mockService.getById.mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado'),
    );

    const res = await request(app)
      .get('/admin/orders/9999')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'getbyid-5');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });
});

// ── POST /admin/orders/:id/approve-cancel-request ────────────────────────────

describe('POST /admin/orders/:id/approve-cancel-request', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT can approve cancellation request', async () => {
    stubAdmin();
    mockService.approveCancelRequest.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'CANCEL_REQUEST_APPROVED',
    });

    const res = await request(app)
      .post('/admin/orders/701/approve-cancel-request')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'approve-cancel-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('CANCEL_REQUEST_APPROVED');
    expect(mockService.approveCancelRequest).toHaveBeenCalledWith(
      1,
      701,
      expect.objectContaining({ user_type: 'ADMIN_CLIENT' }),
    );
  });

  it('200 — OPERATOR_CLIENT can approve cancellation request', async () => {
    stubOperator();
    mockService.approveCancelRequest.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'CANCEL_REQUEST_APPROVED',
    });

    const res = await request(app)
      .post('/admin/orders/701/approve-cancel-request')
      .set('Authorization', 'Bearer op-token')
      .set('X-Idempotency-Key', 'approve-cancel-2');

    expect(res.status).toBe(200);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .post('/admin/orders/701/approve-cancel-request')
      .set('X-Idempotency-Key', 'approve-cancel-3');

    expect(res.status).toBe(401);
  });

  it('403 — BUYER cannot approve', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/admin/orders/701/approve-cancel-request')
      .set('Authorization', 'Bearer buyer-token')
      .set('X-Idempotency-Key', 'approve-cancel-4');

    expect(res.status).toBe(403);
  });

  it('422 — service throws invalid state transition', async () => {
    stubAdmin();
    mockService.approveCancelRequest.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'Transición no permitida'),
    );

    const res = await request(app)
      .post('/admin/orders/701/approve-cancel-request')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'approve-cancel-5');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('400 — missing X-Idempotency-Key', async () => {
    stubAdmin();
    const res = await request(app)
      .post('/admin/orders/701/approve-cancel-request')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(400);
  });
});

// ── POST /admin/orders/:id/reject-cancel-request ─────────────────────────────

describe('POST /admin/orders/:id/reject-cancel-request', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT can reject cancellation request with reason', async () => {
    stubAdmin();
    mockService.rejectCancelRequest.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'CANCEL_REQUEST_REJECTED',
    });

    const res = await request(app)
      .post('/admin/orders/701/reject-cancel-request')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'reject-cancel-1')
      .send({ reason: 'Pedido ya en preparación' });

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('CANCEL_REQUEST_REJECTED');
    expect(mockService.rejectCancelRequest).toHaveBeenCalledWith(1, 701, expect.anything(), 'Pedido ya en preparación');
  });

  it('400 — missing reason in body', async () => {
    stubAdmin();
    const res = await request(app)
      .post('/admin/orders/701/reject-cancel-request')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'reject-cancel-2')
      .send({});

    expect(res.status).toBe(400);
  });

  it('200 — OPERATOR_CLIENT can reject cancellation request', async () => {
    stubOperator();
    mockService.rejectCancelRequest.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'CANCEL_REQUEST_REJECTED',
    });

    const res = await request(app)
      .post('/admin/orders/701/reject-cancel-request')
      .set('Authorization', 'Bearer op-token')
      .set('X-Idempotency-Key', 'reject-cancel-3')
      .send({ reason: 'No aplica' });

    expect(res.status).toBe(200);
  });

  it('403 — BUYER cannot reject cancel request', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/admin/orders/701/reject-cancel-request')
      .set('Authorization', 'Bearer buyer-token')
      .set('X-Idempotency-Key', 'reject-cancel-4')
      .send({ reason: 'No aplica' });

    expect(res.status).toBe(403);
  });
});

// ── POST /admin/orders/:id/return-to-origin ───────────────────────────────────

describe('POST /admin/orders/:id/return-to-origin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT marks order for return to origin', async () => {
    stubAdmin();
    mockService.returnToOrigin.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'RETURN_TO_ORIGIN',
    });

    const res = await request(app)
      .post('/admin/orders/701/return-to-origin')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'return-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('RETURN_TO_ORIGIN');
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .post('/admin/orders/701/return-to-origin')
      .set('X-Idempotency-Key', 'return-2');

    expect(res.status).toBe(401);
  });

  it('403 — BUYER cannot trigger return', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/admin/orders/701/return-to-origin')
      .set('Authorization', 'Bearer buyer-token')
      .set('X-Idempotency-Key', 'return-3');

    expect(res.status).toBe(403);
  });

  it('422 — invalid state for return-to-origin', async () => {
    stubAdmin();
    mockService.returnToOrigin.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'No se puede retornar desde este estado'),
    );

    const res = await request(app)
      .post('/admin/orders/701/return-to-origin')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'return-4');

    expect(res.status).toBe(422);
  });
});

// ── POST /admin/orders/:id/return-to-origin-received ─────────────────────────

describe('POST /admin/orders/:id/return-to-origin-received', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT marks return as received', async () => {
    stubAdmin();
    mockService.returnToOriginReceived.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'RETURN_TO_ORIGIN_RECEIVED',
    });

    const res = await request(app)
      .post('/admin/orders/701/return-to-origin-received')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'return-recv-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('RETURN_TO_ORIGIN_RECEIVED');
  });

  it('200 — OPERATOR_CLIENT can mark return received', async () => {
    stubOperator();
    mockService.returnToOriginReceived.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'RETURN_TO_ORIGIN_RECEIVED',
    });

    const res = await request(app)
      .post('/admin/orders/701/return-to-origin-received')
      .set('Authorization', 'Bearer op-token')
      .set('X-Idempotency-Key', 'return-recv-2');

    expect(res.status).toBe(200);
  });

  it('403 — BUYER cannot mark return received', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/admin/orders/701/return-to-origin-received')
      .set('Authorization', 'Bearer buyer-token')
      .set('X-Idempotency-Key', 'return-recv-3');

    expect(res.status).toBe(403);
  });

  it('400 — missing idempotency key', async () => {
    stubAdmin();
    const res = await request(app)
      .post('/admin/orders/701/return-to-origin-received')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(400);
  });
});
