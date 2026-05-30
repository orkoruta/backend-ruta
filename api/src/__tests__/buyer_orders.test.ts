/**
 * buyer_orders.test.ts — 6.QA-2
 *
 * Cobertura de buyer_orders.ts:
 *  - POST /buyer/orders — crear pedido
 *  - GET /buyer/orders — listar pedidos
 *  - GET /buyer/orders/:id — detalle
 *  - PATCH /buyer/orders/:id/confirm — confirmar
 *  - POST /buyer/orders/:id/cancel — cancelar pre-despacho
 *  - POST /buyer/orders/:id/request-cancel — solicitar cancelación post-despacho
 *  - POST /buyer/orders/:id/confirm-receipt — confirmar recepción
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
import { createBuyerOrdersRouter } from '../routes/buyer_orders.js';

const mockService = {
  create: vi.fn(),
  list: vi.fn(),
  getById: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  requestCancel: vi.fn(),
  confirmReceipt: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/buyer/orders', createBuyerOrdersRouter(mockService as Parameters<typeof createBuyerOrdersRouter>[0]));
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

function stubBuyer() {
  mockVerifyAccessToken.mockResolvedValue({ sub: '41', client_id: 1, user_type: 'BUYER', session_id: 1 });
}

function stubAdmin() {
  mockVerifyAccessToken.mockResolvedValue({ sub: '21', client_id: 1, user_type: 'ADMIN_CLIENT', session_id: 2 });
}

const BASE_ORDER = {
  id: 801,
  client_id: 1,
  buyer_id: 41,
  order_status: 'DRAFT',
  payment_status: 'UNPAID',
  delivery_type: 'SHIP',
  total: 93000,
  currency: 'COP',
  items: [],
  created_at: new Date().toISOString(),
};

const IK = 'X-Idempotency-Key';

// ── POST /buyer/orders ────────────────────────────────────────────────────────

describe('POST /buyer/orders', () => {
  beforeEach(() => vi.clearAllMocks());

  it('201 — BUYER creates a new order', async () => {
    stubBuyer();
    mockService.create.mockResolvedValue({ ...BASE_ORDER, order_status: 'DRAFT' });

    const res = await request(app)
      .post('/buyer/orders')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'create-1')
      .send({
        delivery_type: 'SHIP',
        delivery_address: 'Calle 93 #15-20, Bogota',
        payment_method: 'ONLINE_AT_ORDER',
        items: [{ product_id: 10, quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(801);
    expect(mockService.create).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ user_type: 'BUYER' }),
      expect.any(Object),
    );
  });

  it('401 — unauthenticated cannot create order', async () => {
    const res = await request(app)
      .post('/buyer/orders')
      .set(IK, 'create-2')
      .send({ delivery_type: 'SHIP', payment_method: 'ONLINE_AT_ORDER', items: [] });

    expect(res.status).toBe(401);
  });

  it('403 — ADMIN_CLIENT cannot create buyer order', async () => {
    stubAdmin();
    const res = await request(app)
      .post('/buyer/orders')
      .set('Authorization', 'Bearer admin-token')
      .set(IK, 'create-3')
      .send({ delivery_type: 'SHIP', payment_method: 'ONLINE_AT_ORDER', items: [] });

    expect(res.status).toBe(403);
  });

  it('400 — missing X-Idempotency-Key', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/buyer/orders')
      .set('Authorization', 'Bearer buyer-token')
      .send({});

    expect(res.status).toBe(400);
  });
});

// ── GET /buyer/orders ─────────────────────────────────────────────────────────

describe('GET /buyer/orders', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — BUYER lists their orders', async () => {
    stubBuyer();
    mockService.list.mockResolvedValue({
      data: [BASE_ORDER],
      pagination: { page: 1, page_size: 20, total: 1 },
    });

    const res = await request(app)
      .get('/buyer/orders')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'list-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(mockService.list).toHaveBeenCalledWith(1, expect.objectContaining({ user_type: 'BUYER' }), expect.any(Object));
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .get('/buyer/orders')
      .set(IK, 'list-2');

    expect(res.status).toBe(401);
  });

  it('403 — ADMIN cannot list buyer orders', async () => {
    stubAdmin();
    const res = await request(app)
      .get('/buyer/orders')
      .set('Authorization', 'Bearer admin-token')
      .set(IK, 'list-3');

    expect(res.status).toBe(403);
  });
});

// ── GET /buyer/orders/:id ─────────────────────────────────────────────────────

describe('GET /buyer/orders/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — BUYER gets order detail', async () => {
    stubBuyer();
    mockService.getById.mockResolvedValue(BASE_ORDER);

    const res = await request(app)
      .get('/buyer/orders/801')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'getbyid-1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(801);
    expect(mockService.getById).toHaveBeenCalledWith(1, 801, expect.objectContaining({ user_type: 'BUYER' }));
  });

  it('400 — invalid order id (non-numeric)', async () => {
    stubBuyer();
    const res = await request(app)
      .get('/buyer/orders/abc')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'getbyid-2');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('404 — order not found', async () => {
    stubBuyer();
    mockService.getById.mockRejectedValue(new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado'));

    const res = await request(app)
      .get('/buyer/orders/9999')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'getbyid-3');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });
});

// ── PATCH /buyer/orders/:id/confirm ──────────────────────────────────────────

describe('PATCH /buyer/orders/:id/confirm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — BUYER confirms order', async () => {
    stubBuyer();
    mockService.confirm.mockResolvedValue({ ...BASE_ORDER, order_status: 'ORDER_SUBMITTED' });

    const res = await request(app)
      .patch('/buyer/orders/801/confirm')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'confirm-1')
      .send({
        delivery_type: 'SHIP',
        delivery_address: { line: 'Calle 123 # 45-67', city: 'Bogotá', state: 'Cundinamarca', country: 'CO' },
        payment_method: 'ONLINE_AT_ORDER',
      });

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('ORDER_SUBMITTED');
  });

  it('400 — invalid order id', async () => {
    stubBuyer();
    const res = await request(app)
      .patch('/buyer/orders/invalid/confirm')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'confirm-2')
      .send({});

    expect(res.status).toBe(400);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .patch('/buyer/orders/801/confirm')
      .set(IK, 'confirm-3')
      .send({});

    expect(res.status).toBe(401);
  });

  it('403 — ADMIN cannot confirm buyer order', async () => {
    stubAdmin();
    const res = await request(app)
      .patch('/buyer/orders/801/confirm')
      .set('Authorization', 'Bearer admin-token')
      .set(IK, 'confirm-4')
      .send({});

    expect(res.status).toBe(403);
  });
});

// ── POST /buyer/orders/:id/cancel ─────────────────────────────────────────────

describe('POST /buyer/orders/:id/cancel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — BUYER cancels pre-dispatch order', async () => {
    stubBuyer();
    mockService.cancel.mockResolvedValue({ ...BASE_ORDER, order_status: 'CANCELLED_BY_CUSTOMER' });

    const res = await request(app)
      .post('/buyer/orders/801/cancel')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'cancel-1')
      .send({ reason: 'Cambié de opinión' });

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('CANCELLED_BY_CUSTOMER');
  });

  it('422 — service throws invalid state transition', async () => {
    stubBuyer();
    mockService.cancel.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'No se puede cancelar en este estado'),
    );

    const res = await request(app)
      .post('/buyer/orders/801/cancel')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'cancel-2')
      .send({ reason: 'test' });

    expect(res.status).toBe(422);
  });

  it('400 — invalid order id', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/buyer/orders/nan/cancel')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'cancel-3')
      .send({});

    expect(res.status).toBe(400);
  });
});

// ── POST /buyer/orders/:id/request-cancel ────────────────────────────────────

describe('POST /buyer/orders/:id/request-cancel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — BUYER requests cancel after dispatch', async () => {
    stubBuyer();
    mockService.requestCancel.mockResolvedValue({
      ...BASE_ORDER,
      order_status: 'CUSTOMER_CANCEL_REQUEST',
    });

    const res = await request(app)
      .post('/buyer/orders/801/request-cancel')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'req-cancel-1')
      .send({ reason: 'No necesito el producto' });

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('CUSTOMER_CANCEL_REQUEST');
    expect(mockService.requestCancel).toHaveBeenCalledWith(
      1,
      801,
      expect.objectContaining({ user_type: 'BUYER' }),
      expect.any(Object),
    );
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .post('/buyer/orders/801/request-cancel')
      .set(IK, 'req-cancel-2')
      .send({});

    expect(res.status).toBe(401);
  });

  it('403 — ADMIN cannot request cancel on behalf of buyer', async () => {
    stubAdmin();
    const res = await request(app)
      .post('/buyer/orders/801/request-cancel')
      .set('Authorization', 'Bearer admin-token')
      .set(IK, 'req-cancel-3')
      .send({});

    expect(res.status).toBe(403);
  });

  it('400 — invalid order id in params', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/buyer/orders/bad/request-cancel')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'req-cancel-4')
      .send({});

    expect(res.status).toBe(400);
  });
});

// ── POST /buyer/orders/:id/confirm-receipt ────────────────────────────────────

describe('POST /buyer/orders/:id/confirm-receipt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — BUYER confirms receipt (DELIVERED → CLOSED)', async () => {
    stubBuyer();
    mockService.confirmReceipt.mockResolvedValue({ ...BASE_ORDER, order_status: 'CLOSED' });

    const res = await request(app)
      .post('/buyer/orders/801/confirm-receipt')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'confirm-receipt-1');

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('CLOSED');
    expect(mockService.confirmReceipt).toHaveBeenCalledWith(
      1,
      801,
      expect.objectContaining({ user_type: 'BUYER' }),
    );
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .post('/buyer/orders/801/confirm-receipt')
      .set(IK, 'confirm-receipt-2');

    expect(res.status).toBe(401);
  });

  it('403 — ADMIN cannot confirm receipt', async () => {
    stubAdmin();
    const res = await request(app)
      .post('/buyer/orders/801/confirm-receipt')
      .set('Authorization', 'Bearer admin-token')
      .set(IK, 'confirm-receipt-3');

    expect(res.status).toBe(403);
  });

  it('400 — invalid order id', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/buyer/orders/abc/confirm-receipt')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'confirm-receipt-4');

    expect(res.status).toBe(400);
  });

  it('422 — service throws invalid state', async () => {
    stubBuyer();
    mockService.confirmReceipt.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'Solo pedidos entregados pueden ser confirmados'),
    );

    const res = await request(app)
      .post('/buyer/orders/801/confirm-receipt')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'confirm-receipt-5');

    expect(res.status).toBe(422);
  });
});
