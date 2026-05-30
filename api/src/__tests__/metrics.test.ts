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

// ── Imports ───────────────────────────────────────────────────────────────────

import express from 'express';
import cookieParser from 'cookie-parser';
import { authenticate } from '../middleware/auth.js';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import { createAdminMetricsRouter } from '../routes/admin_metrics.js';
import { createRutaAdminMetricsRouter } from '../routes/ruta_admin_metrics.js';

// ── Mock services ─────────────────────────────────────────────────────────────

const mockClientMetricsService = {
  getClientMetrics: vi.fn(),
};

const mockGlobalMetricsService = {
  getGlobalMetrics: vi.fn(),
};

// ── App under test ────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/admin/metrics', createAdminMetricsRouter(mockClientMetricsService));
  app.use('/ruta-admin/metrics', createRutaAdminMetricsRouter(mockGlobalMetricsService));
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

function stubAdminClient(clientId = 7) {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '42',
    client_id: clientId,
    user_type: 'ADMIN_CLIENT',
    session_id: 1,
  });
}

function stubAdminRuta() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '1',
    client_id: 0,
    user_type: 'ADMIN_RUTA',
    session_id: 10,
  });
}

function stubBuyer() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '99',
    client_id: 7,
    user_type: 'BUYER',
    session_id: 3,
  });
}

function stubCourier() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '88',
    client_id: 7,
    user_type: 'COURIER',
    session_id: 4,
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT_METRICS = {
  orders_today: 12,
  orders_by_status: [
    { status: 'SELLER_CONFIRMED', count: 5 },
    { status: 'PREPARING', count: 7 },
  ],
  revenue_last_7_days: 5250000,
  active_couriers: 3,
  registered_buyers: 42,
};

const GLOBAL_METRICS = {
  active_clients_by_type: [
    { client_type: 'API', count: 4 },
    { client_type: 'FULL', count: 9 },
  ],
  orders_today: 58,
  orders_by_status: [
    { status: 'SELLER_CONFIRMED', count: 20 },
    { status: 'PREPARING', count: 38 },
  ],
  revenue_last_7_days: 85000000,
};

// ── GET /admin/metrics ────────────────────────────────────────────────────────

describe('GET /admin/metrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — no auth token', async () => {
    const res = await request(app).get('/admin/metrics');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('403 — BUYER cannot access', async () => {
    stubBuyer();
    const res = await request(app)
      .get('/admin/metrics')
      .set('Authorization', 'Bearer buyer-token');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('403 — COURIER cannot access', async () => {
    stubCourier();
    const res = await request(app)
      .get('/admin/metrics')
      .set('Authorization', 'Bearer courier-token');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('200 — ADMIN_CLIENT receives client metrics with correct structure', async () => {
    stubAdminClient(7);
    mockClientMetricsService.getClientMetrics.mockResolvedValue(CLIENT_METRICS);

    const res = await request(app)
      .get('/admin/metrics')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      orders_today: expect.any(Number),
      orders_by_status: expect.any(Array),
      revenue_last_7_days: expect.any(Number),
      active_couriers: expect.any(Number),
      registered_buyers: expect.any(Number),
    });
    expect(res.body.orders_today).toBe(12);
    expect(res.body.active_couriers).toBe(3);
    expect(res.body.registered_buyers).toBe(42);
    expect(mockClientMetricsService.getClientMetrics).toHaveBeenCalledWith(7);
  });

  it('200 — orders_by_status is an array of {status, count}', async () => {
    stubAdminClient(7);
    mockClientMetricsService.getClientMetrics.mockResolvedValue(CLIENT_METRICS);

    const res = await request(app)
      .get('/admin/metrics')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(200);
    expect(res.body.orders_by_status).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: expect.any(String), count: expect.any(Number) }),
      ]),
    );
  });

  it('500 — service error propagates as 500', async () => {
    stubAdminClient(7);
    mockClientMetricsService.getClientMetrics.mockRejectedValue(new Error('DB error'));

    const res = await request(app)
      .get('/admin/metrics')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(500);
  });
});

// ── GET /ruta-admin/metrics ───────────────────────────────────────────────────

describe('GET /ruta-admin/metrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — no auth token', async () => {
    const res = await request(app).get('/ruta-admin/metrics');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('403 — ADMIN_CLIENT cannot access global metrics', async () => {
    stubAdminClient(7);
    const res = await request(app)
      .get('/ruta-admin/metrics')
      .set('Authorization', 'Bearer admin-client-token');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('403 — BUYER cannot access global metrics', async () => {
    stubBuyer();
    const res = await request(app)
      .get('/ruta-admin/metrics')
      .set('Authorization', 'Bearer buyer-token');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('200 — ADMIN_RUTA receives global metrics with correct structure', async () => {
    stubAdminRuta();
    mockGlobalMetricsService.getGlobalMetrics.mockResolvedValue(GLOBAL_METRICS);

    const res = await request(app)
      .get('/ruta-admin/metrics')
      .set('Authorization', 'Bearer admin-ruta-token');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      active_clients_by_type: expect.any(Array),
      orders_today: expect.any(Number),
      orders_by_status: expect.any(Array),
      revenue_last_7_days: expect.any(Number),
    });
    expect(res.body.orders_today).toBe(58);
    expect(res.body.revenue_last_7_days).toBe(85000000);
    expect(mockGlobalMetricsService.getGlobalMetrics).toHaveBeenCalledTimes(1);
  });

  it('200 — active_clients_by_type contains {client_type, count} entries', async () => {
    stubAdminRuta();
    mockGlobalMetricsService.getGlobalMetrics.mockResolvedValue(GLOBAL_METRICS);

    const res = await request(app)
      .get('/ruta-admin/metrics')
      .set('Authorization', 'Bearer admin-ruta-token');

    expect(res.status).toBe(200);
    expect(res.body.active_clients_by_type).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client_type: expect.any(String), count: expect.any(Number) }),
      ]),
    );
  });

  it('500 — service error propagates as 500', async () => {
    stubAdminRuta();
    mockGlobalMetricsService.getGlobalMetrics.mockRejectedValue(new Error('DB error'));

    const res = await request(app)
      .get('/ruta-admin/metrics')
      .set('Authorization', 'Bearer admin-ruta-token');

    expect(res.status).toBe(500);
  });
});
