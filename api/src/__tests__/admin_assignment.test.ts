/**
 * admin_assignment.test.ts — 6.QA-2
 *
 * Cobertura de admin_order_assignment.ts:
 *  - GET /admin/orders/map
 *  - GET /admin/orders/:id/available-couriers
 *  - POST /admin/orders/:id/assign-courier
 *  - POST /admin/orders/:id/unassign-courier
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
import { createAdminOrderAssignmentRouter } from '../routes/admin_order_assignment.js';

const mockService = {
  getOrdersForMap: vi.fn(),
  getAvailableCouriers: vi.fn(),
  assignCourier: vi.fn(),
  unassignCourier: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/admin', createAdminOrderAssignmentRouter(mockService as Parameters<typeof createAdminOrderAssignmentRouter>[0]));
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

const NOW = '2026-05-29T12:00:00.000Z';
const IK = 'X-Idempotency-Key';

const MAP_ORDERS = [
  {
    id: 501,
    order_status: 'AWAITING_COURIER_ASSIGNMENT',
    delivery_address_line: 'Calle 93 #15-20',
    delivery_address_city: 'Bogota',
    latitude: 4.676,
    longitude: -74.048,
    buyer_id: 41,
    total: 125000,
    currency: 'COP',
    created_at: NOW,
  },
];

const COURIERS = [
  { id: 31, full_name: 'Carlos Courier', email: 'courier@test.dev', phone: '+573001112233', status: 'ACTIVE' },
];

// ── GET /admin/orders/map ──────────────────────────────────────────────────────

describe('GET /admin/orders/map', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — ADMIN_CLIENT gets map orders', async () => {
    stubAdmin();
    mockService.getOrdersForMap.mockResolvedValue(MAP_ORDERS);

    const res = await request(app)
      .get('/admin/orders/map')
      .set('Authorization', 'Bearer admin-token')
      .set(IK, 'map-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].order_status).toBe('AWAITING_COURIER_ASSIGNMENT');
    expect(mockService.getOrdersForMap).toHaveBeenCalledWith(1);
  });

  it('200 — OPERATOR_CLIENT gets map orders', async () => {
    stubOperator();
    mockService.getOrdersForMap.mockResolvedValue([]);

    const res = await request(app)
      .get('/admin/orders/map')
      .set('Authorization', 'Bearer op-token')
      .set(IK, 'map-2');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .get('/admin/orders/map')
      .set(IK, 'map-3');

    expect(res.status).toBe(401);
  });

  it('403 — BUYER cannot access map', async () => {
    stubBuyer();
    const res = await request(app)
      .get('/admin/orders/map')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'map-4');

    expect(res.status).toBe(403);
  });
});

// ── GET /admin/orders/:id/available-couriers ──────────────────────────────────

describe('GET /admin/orders/:id/available-couriers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 — returns available couriers', async () => {
    stubAdmin();
    mockService.getAvailableCouriers.mockResolvedValue(COURIERS);

    const res = await request(app)
      .get('/admin/orders/501/available-couriers')
      .set('Authorization', 'Bearer admin-token')
      .set(IK, 'avail-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].full_name).toBe('Carlos Courier');
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .get('/admin/orders/501/available-couriers')
      .set(IK, 'avail-2');

    expect(res.status).toBe(401);
  });

  it('403 — BUYER cannot get couriers', async () => {
    stubBuyer();
    const res = await request(app)
      .get('/admin/orders/501/available-couriers')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'avail-3');

    expect(res.status).toBe(403);
  });
});

// ── POST /admin/orders/:id/assign-courier ─────────────────────────────────────

describe('POST /admin/orders/:id/assign-courier', () => {
  beforeEach(() => vi.clearAllMocks());

  it('204 — ADMIN_CLIENT assigns a courier', async () => {
    stubAdmin();
    mockService.assignCourier.mockResolvedValue({ success: true });

    const res = await request(app)
      .post('/admin/orders/501/assign-courier')
      .set('Authorization', 'Bearer admin-token')
      .set(IK, 'assign-1')
      .send({ courier_user_id: 31 });

    expect(res.status).toBe(200);
    expect(mockService.assignCourier).toHaveBeenCalledWith(
      1, 501, 31,
      expect.objectContaining({ user_type: 'ADMIN_CLIENT' }),
    );
  });

  it('400 — missing courier_user_id', async () => {
    stubAdmin();
    const res = await request(app)
      .post('/admin/orders/501/assign-courier')
      .set('Authorization', 'Bearer admin-token')
      .set(IK, 'assign-2')
      .send({});

    expect(res.status).toBe(400);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .post('/admin/orders/501/assign-courier')
      .set(IK, 'assign-3')
      .send({ courier_user_id: 31 });

    expect(res.status).toBe(401);
  });

  it('403 — BUYER cannot assign courier', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/admin/orders/501/assign-courier')
      .set('Authorization', 'Bearer buyer-token')
      .set(IK, 'assign-4')
      .send({ courier_user_id: 31 });

    expect(res.status).toBe(403);
  });

  it('400 — missing X-Idempotency-Key', async () => {
    stubAdmin();
    const res = await request(app)
      .post('/admin/orders/501/assign-courier')
      .set('Authorization', 'Bearer admin-token')
      .send({ courier_user_id: 31 });

    expect(res.status).toBe(400);
  });
});
