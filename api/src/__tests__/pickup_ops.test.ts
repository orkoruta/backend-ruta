/**
 * pickup_ops.test.ts — 4.BACK-1
 *
 * Tests para el flujo PICKUP admin:
 *  - 401 sin token
 *  - 403 BUYER / COURIER en cada endpoint
 *  - Happy path de cada endpoint (mock del servicio)
 *  - 422 cuando pedido no está en estado correcto
 */

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

// ── Import app + router factory ───────────────────────────────────────────────

import express from 'express';
import cookieParser from 'cookie-parser';
import { authenticate } from '../middleware/auth.js';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import { createAdminPickupOpsRouter } from '../routes/admin_pickup_ops.js';

// ── Mock service ──────────────────────────────────────────────────────────────

const mockService = {
  verifyBuyerIdentity: vi.fn(),
  recordPickupCollection: vi.fn(),
  markPickupDelivered: vi.fn(),
};

// ── App under test ────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/admin', createAdminPickupOpsRouter(mockService));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) {
      res
        .status(400)
        .json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
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
const COURIER_TOKEN = 'courier-token';

function stubAdminClient() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '42',
    client_id: 7,
    user_type: 'ADMIN_CLIENT',
    session_id: 1,
  });
}

function stubOperatorClient() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '55',
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

function stubCourier() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '99',
    client_id: 7,
    user_type: 'COURIER',
    session_id: 4,
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const IDEMPOTENCY_KEY = 'test-idem-key-1234';

// ══════════════════════════════════════════════════════════════════════════════
//  POST /admin/orders/:id/verify-pickup-identity
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /admin/orders/:id/verify-pickup-identity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — sin token', async () => {
    const res = await request(app)
      .post('/admin/orders/5001/verify-pickup-identity')
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ document_type: 'CC', document_number: '1234567890' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('403 — BUYER no puede usar el endpoint', async () => {
    stubBuyer();

    const res = await request(app)
      .post('/admin/orders/5001/verify-pickup-identity')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ document_type: 'CC', document_number: '1234567890' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('403 — COURIER no puede usar el endpoint', async () => {
    stubCourier();

    const res = await request(app)
      .post('/admin/orders/5001/verify-pickup-identity')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ document_type: 'CC', document_number: '1234567890' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('400 — falta X-Idempotency-Key', async () => {
    stubAdminClient();

    const res = await request(app)
      .post('/admin/orders/5001/verify-pickup-identity')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ document_type: 'CC', document_number: '1234567890' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 — body inválido (falta document_type)', async () => {
    stubAdminClient();

    const res = await request(app)
      .post('/admin/orders/5001/verify-pickup-identity')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ document_number: '1234567890' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('200 — happy path ADMIN_CLIENT', async () => {
    stubAdminClient();
    mockService.verifyBuyerIdentity.mockResolvedValue({ order_id: 5001, verified: true });

    const res = await request(app)
      .post('/admin/orders/5001/verify-pickup-identity')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ document_type: 'CC', document_number: '1234567890' });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(mockService.verifyBuyerIdentity).toHaveBeenCalledWith(
      5001,
      7,
      expect.objectContaining({ user_type: 'ADMIN_CLIENT' }),
      { document_type: 'CC', document_number: '1234567890' },
    );
  });

  it('200 — happy path OPERATOR_CLIENT', async () => {
    stubOperatorClient();
    mockService.verifyBuyerIdentity.mockResolvedValue({ order_id: 5001, verified: true });

    const res = await request(app)
      .post('/admin/orders/5001/verify-pickup-identity')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ document_type: 'CC', document_number: '9876543210' });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(mockService.verifyBuyerIdentity).toHaveBeenCalledWith(
      5001,
      7,
      expect.objectContaining({ user_type: 'OPERATOR_CLIENT' }),
      { document_type: 'CC', document_number: '9876543210' },
    );
  });

  it('422 — pedido no está en estado correcto', async () => {
    stubAdminClient();
    mockService.verifyBuyerIdentity.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'El pedido no está en estado READY_FOR_PICKUP', {
        current_status: 'DELIVERED',
        required_status: 'READY_FOR_PICKUP',
      }),
    );

    const res = await request(app)
      .post('/admin/orders/5001/verify-pickup-identity')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ document_type: 'CC', document_number: '1234567890' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /admin/orders/:id/pickup-collection
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /admin/orders/:id/pickup-collection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — sin token', async () => {
    const res = await request(app)
      .post('/admin/orders/5001/pickup-collection')
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ amount: 50000 });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('403 — BUYER no puede usar el endpoint', async () => {
    stubBuyer();

    const res = await request(app)
      .post('/admin/orders/5001/pickup-collection')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ amount: 50000 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('403 — COURIER no puede usar el endpoint', async () => {
    stubCourier();

    const res = await request(app)
      .post('/admin/orders/5001/pickup-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ amount: 50000 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('400 — body inválido (monto negativo)', async () => {
    stubAdminClient();

    const res = await request(app)
      .post('/admin/orders/5001/pickup-collection')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ amount: -1000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 — body inválido (monto no entero)', async () => {
    stubAdminClient();

    const res = await request(app)
      .post('/admin/orders/5001/pickup-collection')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ amount: 50000.50 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('200 — happy path ADMIN_CLIENT', async () => {
    stubAdminClient();
    mockService.recordPickupCollection.mockResolvedValue({ order_id: 5001, payment_id: 301 });

    const res = await request(app)
      .post('/admin/orders/5001/pickup-collection')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ amount: 75000 });

    expect(res.status).toBe(200);
    expect(res.body.payment_id).toBe(301);
    expect(mockService.recordPickupCollection).toHaveBeenCalledWith(
      5001,
      7,
      expect.objectContaining({ user_type: 'ADMIN_CLIENT' }),
      75000,
    );
  });

  it('200 — happy path OPERATOR_CLIENT', async () => {
    stubOperatorClient();
    mockService.recordPickupCollection.mockResolvedValue({ order_id: 5001, payment_id: 302 });

    const res = await request(app)
      .post('/admin/orders/5001/pickup-collection')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ amount: 100000 });

    expect(res.status).toBe(200);
    expect(res.body.payment_id).toBe(302);
  });

  it('422 — pedido no está en estado correcto', async () => {
    stubAdminClient();
    mockService.recordPickupCollection.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'El pedido no está en estado READY_FOR_PICKUP', {
        current_status: 'CLOSED',
        required_status: 'READY_FOR_PICKUP',
      }),
    );

    const res = await request(app)
      .post('/admin/orders/5001/pickup-collection')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ amount: 50000 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /admin/orders/:id/mark-pickup-delivered
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /admin/orders/:id/mark-pickup-delivered', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — sin token', async () => {
    const res = await request(app)
      .post('/admin/orders/5001/mark-pickup-delivered')
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('403 — BUYER no puede usar el endpoint', async () => {
    stubBuyer();

    const res = await request(app)
      .post('/admin/orders/5001/mark-pickup-delivered')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('403 — COURIER no puede usar el endpoint', async () => {
    stubCourier();

    const res = await request(app)
      .post('/admin/orders/5001/mark-pickup-delivered')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('400 — falta X-Idempotency-Key', async () => {
    stubAdminClient();

    const res = await request(app)
      .post('/admin/orders/5001/mark-pickup-delivered')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('200 — happy path ADMIN_CLIENT', async () => {
    stubAdminClient();
    const deliveredAt = new Date().toISOString();
    mockService.markPickupDelivered.mockResolvedValue({
      order_id: 5001,
      order_status: 'DELIVERED',
      delivered_at: deliveredAt,
    });

    const res = await request(app)
      .post('/admin/orders/5001/mark-pickup-delivered')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY);

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('DELIVERED');
    expect(mockService.markPickupDelivered).toHaveBeenCalledWith(
      5001,
      7,
      expect.objectContaining({ user_type: 'ADMIN_CLIENT' }),
    );
  });

  it('200 — happy path OPERATOR_CLIENT', async () => {
    stubOperatorClient();
    const deliveredAt = new Date().toISOString();
    mockService.markPickupDelivered.mockResolvedValue({
      order_id: 5001,
      order_status: 'DELIVERED',
      delivered_at: deliveredAt,
    });

    const res = await request(app)
      .post('/admin/orders/5001/mark-pickup-delivered')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY);

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('DELIVERED');
    expect(mockService.markPickupDelivered).toHaveBeenCalledWith(
      5001,
      7,
      expect.objectContaining({ user_type: 'OPERATOR_CLIENT' }),
    );
  });

  it('422 — pedido no está en estado READY_FOR_PICKUP (INVALID_STATE_TRANSITION)', async () => {
    stubAdminClient();
    mockService.markPickupDelivered.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'Transición no permitida: DRAFT → DELIVERED', {
        from: 'DRAFT',
        to: 'DELIVERED',
        actor: 'ADMIN_CLIENT',
      }),
    );

    const res = await request(app)
      .post('/admin/orders/5001/mark-pickup-delivered')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('409 — optimistic lock failed', async () => {
    stubAdminClient();
    mockService.markPickupDelivered.mockRejectedValue(
      new HttpError(409, 'OPTIMISTIC_LOCK_FAILED', 'El pedido fue modificado por otro proceso.'),
    );

    const res = await request(app)
      .post('/admin/orders/5001/mark-pickup-delivered')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
  });
});
