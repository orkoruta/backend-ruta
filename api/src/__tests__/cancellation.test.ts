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
  approveCancelRequest: vi.fn(),
  rejectCancelRequest: vi.fn(),
  returnToOrigin: vi.fn(),
  returnToOriginReceived: vi.fn(),
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
  order_status: 'CUSTOMER_CANCEL_REQUEST',
  payment_status: 'PAID',
  delivery_type: 'SHIP',
  delivery_carrier_type: null,
  payment_method: 'ONLINE_AT_ORDER',
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

// ── POST /admin/orders/:id/approve-cancel-request ────────────────────────────

describe('POST /admin/orders/:id/approve-cancel-request', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT can approve cancel request', async () => {
    stubAdminClient();
    mockService.approveCancelRequest.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'CANCEL_REQUEST_APPROVED',
    });

    const res = await request(app)
      .post('/admin/orders/5001/approve-cancel-request')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'approve-cancel-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('CANCEL_REQUEST_APPROVED');
    expect(mockService.approveCancelRequest).toHaveBeenCalledWith(
      7,
      5001,
      expect.objectContaining({ user_type: 'ADMIN_CLIENT' }),
    );
  });

  it('200 — OPERATOR_CLIENT can approve cancel request', async () => {
    stubOperator();
    mockService.approveCancelRequest.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'CANCEL_REQUEST_APPROVED',
    });

    const res = await request(app)
      .post('/admin/orders/5001/approve-cancel-request')
      .set('Authorization', 'Bearer operator-token')
      .set('X-Idempotency-Key', 'approve-cancel-2');

    expect(res.status).toBe(200);
    expect(mockService.approveCancelRequest).toHaveBeenCalledWith(
      7,
      5001,
      expect.objectContaining({ user_type: 'OPERATOR_CLIENT' }),
    );
  });

  it('422 — service throws INVALID_STATE_TRANSITION (wrong state)', async () => {
    stubAdminClient();
    mockService.approveCancelRequest.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'Transición no permitida', {
        from: 'DELIVERED',
        to: 'CANCEL_REQUEST_APPROVED',
      }),
    );

    const res = await request(app)
      .post('/admin/orders/5001/approve-cancel-request')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'approve-cancel-3');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('403 — BUYER cannot approve cancel request', async () => {
    stubBuyer();

    const res = await request(app)
      .post('/admin/orders/5001/approve-cancel-request')
      .set('Authorization', 'Bearer buyer-token')
      .set('X-Idempotency-Key', 'approve-cancel-4');

    expect(res.status).toBe(403);
    expect(mockService.approveCancelRequest).not.toHaveBeenCalled();
  });

  it('400 — missing X-Idempotency-Key', async () => {
    stubAdminClient();

    const res = await request(app)
      .post('/admin/orders/5001/approve-cancel-request')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('401 — unauthenticated request', async () => {
    const res = await request(app)
      .post('/admin/orders/5001/approve-cancel-request')
      .set('X-Idempotency-Key', 'approve-cancel-5');

    expect(res.status).toBe(401);
  });
});

// ── POST /admin/orders/:id/reject-cancel-request ─────────────────────────────

describe('POST /admin/orders/:id/reject-cancel-request', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT can reject with reason', async () => {
    stubAdminClient();
    mockService.rejectCancelRequest.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'CANCEL_REQUEST_REJECTED',
    });

    const res = await request(app)
      .post('/admin/orders/5001/reject-cancel-request')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'reject-cancel-1')
      .send({ reason: 'El pedido ya está en reparto final' });

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('CANCEL_REQUEST_REJECTED');
    expect(mockService.rejectCancelRequest).toHaveBeenCalledWith(
      7,
      5001,
      expect.objectContaining({ user_type: 'ADMIN_CLIENT' }),
      'El pedido ya está en reparto final',
    );
  });

  it('200 — OPERATOR_CLIENT can reject with reason', async () => {
    stubOperator();
    mockService.rejectCancelRequest.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'CANCEL_REQUEST_REJECTED',
    });

    const res = await request(app)
      .post('/admin/orders/5001/reject-cancel-request')
      .set('Authorization', 'Bearer operator-token')
      .set('X-Idempotency-Key', 'reject-cancel-2')
      .send({ reason: 'No aplica devolución en este momento' });

    expect(res.status).toBe(200);
  });

  it('400 — missing reason in body', async () => {
    stubAdminClient();

    const res = await request(app)
      .post('/admin/orders/5001/reject-cancel-request')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'reject-cancel-3')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(mockService.rejectCancelRequest).not.toHaveBeenCalled();
  });

  it('400 — empty reason string', async () => {
    stubAdminClient();

    const res = await request(app)
      .post('/admin/orders/5001/reject-cancel-request')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'reject-cancel-4')
      .send({ reason: '' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('403 — BUYER cannot reject cancel request', async () => {
    stubBuyer();

    const res = await request(app)
      .post('/admin/orders/5001/reject-cancel-request')
      .set('Authorization', 'Bearer buyer-token')
      .set('X-Idempotency-Key', 'reject-cancel-5')
      .send({ reason: 'Intento de acceso no autorizado' });

    expect(res.status).toBe(403);
    expect(mockService.rejectCancelRequest).not.toHaveBeenCalled();
  });
});

// ── POST /admin/orders/:id/return-to-origin ───────────────────────────────────

describe('POST /admin/orders/:id/return-to-origin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT can trigger return from CANCEL_REQUEST_APPROVED', async () => {
    stubAdminClient();
    mockService.returnToOrigin.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'RETURN_TO_ORIGIN',
    });

    const res = await request(app)
      .post('/admin/orders/5001/return-to-origin')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'rto-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('RETURN_TO_ORIGIN');
    expect(mockService.returnToOrigin).toHaveBeenCalledWith(
      7,
      5001,
      expect.objectContaining({ user_type: 'ADMIN_CLIENT' }),
    );
  });

  it('200 — OPERATOR_CLIENT can trigger return from DELIVERY_ATTEMPTED', async () => {
    stubOperator();
    mockService.returnToOrigin.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'RETURN_TO_ORIGIN',
    });

    const res = await request(app)
      .post('/admin/orders/5001/return-to-origin')
      .set('Authorization', 'Bearer operator-token')
      .set('X-Idempotency-Key', 'rto-2');

    expect(res.status).toBe(200);
    expect(mockService.returnToOrigin).toHaveBeenCalledWith(
      7,
      5001,
      expect.objectContaining({ user_type: 'OPERATOR_CLIENT' }),
    );
  });

  it('422 — service throws INVALID_STATE_TRANSITION (wrong state)', async () => {
    stubAdminClient();
    mockService.returnToOrigin.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'Transición no permitida', {
        from: 'SHIPPED',
        to: 'RETURN_TO_ORIGIN',
      }),
    );

    const res = await request(app)
      .post('/admin/orders/5001/return-to-origin')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'rto-3');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('403 — BUYER cannot trigger return to origin', async () => {
    stubBuyer();

    const res = await request(app)
      .post('/admin/orders/5001/return-to-origin')
      .set('Authorization', 'Bearer buyer-token')
      .set('X-Idempotency-Key', 'rto-4');

    expect(res.status).toBe(403);
    expect(mockService.returnToOrigin).not.toHaveBeenCalled();
  });

  it('400 — missing X-Idempotency-Key', async () => {
    stubAdminClient();

    const res = await request(app)
      .post('/admin/orders/5001/return-to-origin')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(400);
  });
});

// ── POST /admin/orders/:id/return-to-origin-received ─────────────────────────

describe('POST /admin/orders/:id/return-to-origin-received', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT can mark return as received', async () => {
    stubAdminClient();
    mockService.returnToOriginReceived.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'RETURN_TO_ORIGIN_RECEIVED',
    });

    const res = await request(app)
      .post('/admin/orders/5001/return-to-origin-received')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'rtor-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('RETURN_TO_ORIGIN_RECEIVED');
    expect(mockService.returnToOriginReceived).toHaveBeenCalledWith(
      7,
      5001,
      expect.objectContaining({ user_type: 'ADMIN_CLIENT' }),
    );
  });

  it('200 — OPERATOR_CLIENT can mark return as received', async () => {
    stubOperator();
    mockService.returnToOriginReceived.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'RETURN_TO_ORIGIN_RECEIVED',
    });

    const res = await request(app)
      .post('/admin/orders/5001/return-to-origin-received')
      .set('Authorization', 'Bearer operator-token')
      .set('X-Idempotency-Key', 'rtor-2');

    expect(res.status).toBe(200);
  });

  it('422 — service throws INVALID_STATE_TRANSITION', async () => {
    stubAdminClient();
    mockService.returnToOriginReceived.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'Transición no permitida', {
        from: 'DELIVERY_ATTEMPTED',
        to: 'RETURN_TO_ORIGIN_RECEIVED',
      }),
    );

    const res = await request(app)
      .post('/admin/orders/5001/return-to-origin-received')
      .set('Authorization', 'Bearer admin-token')
      .set('X-Idempotency-Key', 'rtor-3');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('403 — BUYER cannot mark return as received', async () => {
    stubBuyer();

    const res = await request(app)
      .post('/admin/orders/5001/return-to-origin-received')
      .set('Authorization', 'Bearer buyer-token')
      .set('X-Idempotency-Key', 'rtor-4');

    expect(res.status).toBe(403);
    expect(mockService.returnToOriginReceived).not.toHaveBeenCalled();
  });
});
