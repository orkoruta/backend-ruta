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
import { createCourierCollectionRouter } from '../routes/courier_collection.js';

// ── Mock service ──────────────────────────────────────────────────────────────

const mockService = {
  initiateCollection: vi.fn(),
  recordCollection: vi.fn(),
  recordFailedCollection: vi.fn(),
};

// ── App under test ────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/courier', createCourierCollectionRouter(mockService));
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

function stubAdmin() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '42',
    client_id: 7,
    user_type: 'ADMIN_CLIENT',
    session_id: 2,
  });
}

// ── Base fixtures ─────────────────────────────────────────────────────────────

const BASE_COLLECTION_RESULT = {
  payment_id: 1001,
  order_id: 5001,
  payment_status: 'PAYMENT_COLLECTED',
  order_status: 'PAYMENT_COLLECTED_CASH',
  amount: 105000,
  currency: 'COP',
  evidence_url: null,
  collected_at: new Date().toISOString(),
};

const VALID_COLLECTION_BODY = {
  amount: 105000,
  currency: 'COP',
  method: 'CASH',
};

// ── POST /courier/orders/:id/record-collection ────────────────────────────────

describe('POST /courier/orders/:id/record-collection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — COURIER registra cobro exitoso', async () => {
    stubCourier();
    mockService.recordCollection.mockResolvedValue(BASE_COLLECTION_RESULT);

    const res = await request(app)
      .post('/courier/orders/5001/record-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'rec-coll-key-1')
      .send(VALID_COLLECTION_BODY);

    expect(res.status).toBe(200);
    expect(res.body.payment_status).toBe('PAYMENT_COLLECTED');
    expect(res.body.payment_id).toBe(1001);
    expect(mockService.recordCollection).toHaveBeenCalledWith(
      7,
      99,
      5001,
      expect.objectContaining({ amount: 105000, method: 'CASH' }),
    );
  });

  it('200 — acepta evidence_url como string opcional', async () => {
    stubCourier();
    mockService.recordCollection.mockResolvedValue({
      ...BASE_COLLECTION_RESULT,
      evidence_url: 'https://cdn.example.com/evidencia.jpg',
    });

    const res = await request(app)
      .post('/courier/orders/5001/record-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'rec-coll-key-ev')
      .send({
        ...VALID_COLLECTION_BODY,
        evidence_url: 'https://cdn.example.com/evidencia.jpg',
      });

    expect(res.status).toBe(200);
    expect(mockService.recordCollection).toHaveBeenCalledWith(
      7,
      99,
      5001,
      expect.objectContaining({ evidence_url: 'https://cdn.example.com/evidencia.jpg' }),
    );
  });

  it('401 — sin autenticación', async () => {
    const res = await request(app)
      .post('/courier/orders/5001/record-collection')
      .set('X-Idempotency-Key', 'rec-coll-key-noauth')
      .send(VALID_COLLECTION_BODY);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('403 — ADMIN_CLIENT no puede registrar cobro', async () => {
    stubAdmin();
    const res = await request(app)
      .post('/courier/orders/5001/record-collection')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'rec-coll-key-admin')
      .send(VALID_COLLECTION_BODY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('400 — falta X-Idempotency-Key', async () => {
    stubCourier();
    const res = await request(app)
      .post('/courier/orders/5001/record-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .send(VALID_COLLECTION_BODY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 — body inválido: falta amount', async () => {
    stubCourier();
    const res = await request(app)
      .post('/courier/orders/5001/record-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'rec-coll-key-badamt')
      .send({ currency: 'COP', method: 'CASH' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 — body inválido: method fuera del enum', async () => {
    stubCourier();
    const res = await request(app)
      .post('/courier/orders/5001/record-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'rec-coll-key-badmethod')
      .send({ amount: 100000, currency: 'COP', method: 'CRYPTO' });

    expect(res.status).toBe(400);
  });

  it('422 — service lanza INVALID_STATE_TRANSITION', async () => {
    stubCourier();
    mockService.recordCollection.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'No se puede registrar cobro en estado DRAFT', {
        current: 'DRAFT',
      }),
    );

    const res = await request(app)
      .post('/courier/orders/5001/record-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'rec-coll-key-422')
      .send(VALID_COLLECTION_BODY);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('403 — service lanza FORBIDDEN (pedido de otro courier)', async () => {
    stubCourier();
    mockService.recordCollection.mockRejectedValue(
      new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti'),
    );

    const res = await request(app)
      .post('/courier/orders/5001/record-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'rec-coll-key-forbidden')
      .send(VALID_COLLECTION_BODY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

// ── POST /courier/orders/:id/initiate-collection ──────────────────────────────

describe('POST /courier/orders/:id/initiate-collection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — COURIER inicia cobro electrónico', async () => {
    stubCourier();
    mockService.initiateCollection.mockResolvedValue({
      order_id: 5001,
      order_status: 'PAYMENT_COLLECTION_PENDING',
      payment_method: 'ELECTRONIC_ON_DELIVERY',
    });

    const res = await request(app)
      .post('/courier/orders/5001/initiate-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'init-coll-key-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('PAYMENT_COLLECTION_PENDING');
    expect(mockService.initiateCollection).toHaveBeenCalledWith(7, 99, 5001);
  });

  it('200 — COURIER inicia cobro en efectivo', async () => {
    stubCourier();
    mockService.initiateCollection.mockResolvedValue({
      order_id: 5001,
      order_status: 'CASH_COLLECTION_PENDING',
      payment_method: 'CASH_ON_DELIVERY',
    });

    const res = await request(app)
      .post('/courier/orders/5001/initiate-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'init-coll-key-cash');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('CASH_COLLECTION_PENDING');
  });

  it('401 — sin autenticación', async () => {
    const res = await request(app)
      .post('/courier/orders/5001/initiate-collection')
      .set('X-Idempotency-Key', 'init-coll-key-noauth');

    expect(res.status).toBe(401);
  });

  it('403 — ADMIN_CLIENT no puede iniciar cobro', async () => {
    stubAdmin();
    const res = await request(app)
      .post('/courier/orders/5001/initiate-collection')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'init-coll-key-admin');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('400 — falta X-Idempotency-Key', async () => {
    stubCourier();
    const res = await request(app)
      .post('/courier/orders/5001/initiate-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('422 — service lanza INVALID_STATE_TRANSITION (estado incorrecto)', async () => {
    stubCourier();
    mockService.initiateCollection.mockRejectedValue(
      new HttpError(
        422,
        'INVALID_STATE_TRANSITION',
        'No se puede iniciar cobro desde el estado IN_TRANSIT',
        { current: 'IN_TRANSIT' },
      ),
    );

    const res = await request(app)
      .post('/courier/orders/5001/initiate-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'init-coll-key-422');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('404 — pedido no encontrado', async () => {
    stubCourier();
    mockService.initiateCollection.mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado'),
    );

    const res = await request(app)
      .post('/courier/orders/9999/initiate-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'init-coll-key-404');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });
});

// ── POST /courier/orders/:id/record-failed-collection ────────────────────────

describe('POST /courier/orders/:id/record-failed-collection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — COURIER registra fallo de cobro electrónico', async () => {
    stubCourier();
    mockService.recordFailedCollection.mockResolvedValue({
      order_id: 5001,
      payment_status: 'PAYMENT_NOT_COLLECTED',
      order_status: 'RETURN_TO_ORIGIN',
    });

    const res = await request(app)
      .post('/courier/orders/5001/record-failed-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'fail-coll-key-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('RETURN_TO_ORIGIN');
    expect(res.body.payment_status).toBe('PAYMENT_NOT_COLLECTED');
    expect(mockService.recordFailedCollection).toHaveBeenCalledWith(7, 99, 5001);
  });

  it('200 — COURIER registra fallo de cobro en efectivo', async () => {
    stubCourier();
    mockService.recordFailedCollection.mockResolvedValue({
      order_id: 5001,
      payment_status: 'PAYMENT_NOT_COLLECTED',
      order_status: 'RETURN_TO_ORIGIN',
    });

    const res = await request(app)
      .post('/courier/orders/5001/record-failed-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'fail-coll-key-cash');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('RETURN_TO_ORIGIN');
  });

  it('401 — sin autenticación', async () => {
    const res = await request(app)
      .post('/courier/orders/5001/record-failed-collection')
      .set('X-Idempotency-Key', 'fail-coll-key-noauth');

    expect(res.status).toBe(401);
  });

  it('403 — ADMIN_CLIENT no puede registrar fallo', async () => {
    stubAdmin();
    const res = await request(app)
      .post('/courier/orders/5001/record-failed-collection')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'fail-coll-key-admin');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('400 — falta X-Idempotency-Key', async () => {
    stubCourier();
    const res = await request(app)
      .post('/courier/orders/5001/record-failed-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('422 — service lanza INVALID_STATE_TRANSITION (estado incorrecto)', async () => {
    stubCourier();
    mockService.recordFailedCollection.mockRejectedValue(
      new HttpError(
        422,
        'INVALID_STATE_TRANSITION',
        'No se puede registrar cobro fallido desde el estado DELIVERED',
        { current: 'DELIVERED' },
      ),
    );

    const res = await request(app)
      .post('/courier/orders/5001/record-failed-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'fail-coll-key-422');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('409 — optimistic lock falló', async () => {
    stubCourier();
    mockService.recordFailedCollection.mockRejectedValue(
      new HttpError(409, 'OPTIMISTIC_LOCK_FAILED', 'El pedido fue modificado concurrentemente.'),
    );

    const res = await request(app)
      .post('/courier/orders/5001/record-failed-collection')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'fail-coll-key-409');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
  });
});
