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
import { createAdminPickupPointsRouter } from '../routes/admin_pickup_points.js';

// ── Mock service ──────────────────────────────────────────────────────────────

const mockService = {
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  activate: vi.fn(),
  deactivate: vi.fn(),
};

// ── App under test ────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/admin/pickup-points', createAdminPickupPointsRouter(mockService));
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
const COURIER_TOKEN = 'courier-token';

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

function stubCourier() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '20',
    client_id: 7,
    user_type: 'COURIER',
    session_id: 4,
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PICKUP_POINT = {
  id: 1001,
  client_id: 7,
  name: 'Punto Norte',
  address_line: 'Cra 7 # 100-50',
  city: 'Bogotá',
  state: 'Bogotá D.C.',
  country: 'CO',
  postal_code: '110111',
  latitude: 4.6951,
  longitude: -74.0427,
  opening_hours: { monday: '08:00-18:00' },
  contact_phone: '+57 300 1234567',
  status: 'ACTIVE',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ── GET /admin/pickup-points ──────────────────────────────────────────────────

describe('GET /admin/pickup-points', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — without auth token', async () => {
    const res = await request(app)
      .get('/admin/pickup-points');

    expect(res.status).toBe(401);
  });

  it('200 — ADMIN_CLIENT can list pickup points', async () => {
    stubAdminClient();
    mockService.list.mockResolvedValue({
      items: [BASE_PICKUP_POINT],
      pagination: { page: 1, page_size: 20, total: 1 },
    });

    const res = await request(app)
      .get('/admin/pickup-points')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(mockService.list).toHaveBeenCalledWith(7, expect.objectContaining({ page: 1, page_size: 20 }));
  });

  it('403 — OPERATOR_CLIENT cannot access admin pickup points', async () => {
    stubOperator();
    const res = await request(app)
      .get('/admin/pickup-points')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`);

    expect(res.status).toBe(403);
  });

  it('403 — BUYER cannot list admin pickup points', async () => {
    stubBuyer();
    const res = await request(app)
      .get('/admin/pickup-points')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`);

    expect(res.status).toBe(403);
  });

  it('403 — COURIER cannot list admin pickup points', async () => {
    stubCourier();
    const res = await request(app)
      .get('/admin/pickup-points')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`);

    expect(res.status).toBe(403);
  });

  it('200 — filters by status', async () => {
    stubAdminClient();
    mockService.list.mockResolvedValue({ items: [], pagination: { page: 1, page_size: 20, total: 0 } });

    const res = await request(app)
      .get('/admin/pickup-points?status=INACTIVE')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockService.list).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'INACTIVE' }));
  });

  it('400 — invalid status value', async () => {
    stubAdminClient();
    const res = await request(app)
      .get('/admin/pickup-points?status=DELETED')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
  });
});

// ── GET /admin/pickup-points/:id ──────────────────────────────────────────────

describe('GET /admin/pickup-points/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — without auth token', async () => {
    const res = await request(app)
      .get('/admin/pickup-points/1001');

    expect(res.status).toBe(401);
  });

  it('200 — ADMIN_CLIENT can get pickup point by id', async () => {
    stubAdminClient();
    mockService.getById.mockResolvedValue(BASE_PICKUP_POINT);

    const res = await request(app)
      .get('/admin/pickup-points/1001')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1001);
    expect(mockService.getById).toHaveBeenCalledWith(7, 1001);
  });

  it('403 — OPERATOR_CLIENT cannot access admin pickup points detail', async () => {
    stubOperator();
    const res = await request(app)
      .get('/admin/pickup-points/1001')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`);

    expect(res.status).toBe(403);
  });

  it('404 — service throws RESOURCE_NOT_FOUND', async () => {
    stubAdminClient();
    mockService.getById.mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Punto de recogida no encontrado'),
    );

    const res = await request(app)
      .get('/admin/pickup-points/9999')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('400 — invalid id param (non-numeric)', async () => {
    stubAdminClient();
    const res = await request(app)
      .get('/admin/pickup-points/abc')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
  });

  it('403 — BUYER cannot access admin endpoint', async () => {
    stubBuyer();
    const res = await request(app)
      .get('/admin/pickup-points/1001')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`);

    expect(res.status).toBe(403);
  });
});

// ── POST /admin/pickup-points ─────────────────────────────────────────────────

describe('POST /admin/pickup-points', () => {
  beforeEach(() => vi.clearAllMocks());

  const VALID_BODY = {
    name: 'Punto Sur',
    address_line: 'Av 1 # 20-10',
    city: 'Medellín',
    country: 'CO',
  };

  it('401 — without auth token', async () => {
    const res = await request(app)
      .post('/admin/pickup-points')
      .set('X-Idempotency-Key', 'key-1')
      .send(VALID_BODY);

    expect(res.status).toBe(401);
  });

  it('400 — missing X-Idempotency-Key (authenticated but no key)', async () => {
    stubAdminClient();
    const res = await request(app)
      .post('/admin/pickup-points')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('201 — ADMIN_CLIENT can create pickup point', async () => {
    stubAdminClient();
    mockService.create.mockResolvedValue({ ...BASE_PICKUP_POINT, name: 'Punto Sur' });

    const res = await request(app)
      .post('/admin/pickup-points')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'key-create-1')
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(mockService.create).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ name: 'Punto Sur' }),
      expect.objectContaining({ user: expect.objectContaining({ client_id: 7 }) }),
    );
  });

  it('403 — OPERATOR_CLIENT cannot create pickup point', async () => {
    stubOperator();
    const res = await request(app)
      .post('/admin/pickup-points')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .set('X-Idempotency-Key', 'key-op-create')
      .send(VALID_BODY);

    expect(res.status).toBe(403);
  });

  it('403 — BUYER cannot create pickup point', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/admin/pickup-points')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .set('X-Idempotency-Key', 'key-buyer-create')
      .send(VALID_BODY);

    expect(res.status).toBe(403);
  });

  it('403 — COURIER cannot create pickup point', async () => {
    stubCourier();
    const res = await request(app)
      .post('/admin/pickup-points')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'key-courier-create')
      .send(VALID_BODY);

    expect(res.status).toBe(403);
  });

  it('400 — missing required field name', async () => {
    stubAdminClient();
    const res = await request(app)
      .post('/admin/pickup-points')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'key-invalid-1')
      .send({ address_line: 'Av 1 # 20-10' }); // missing name

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 — missing required field address_line', async () => {
    stubAdminClient();
    const res = await request(app)
      .post('/admin/pickup-points')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'key-invalid-2')
      .send({ name: 'Punto' }); // missing address_line

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 — invalid latitude out of range', async () => {
    stubAdminClient();
    const res = await request(app)
      .post('/admin/pickup-points')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'key-invalid-3')
      .send({ ...VALID_BODY, latitude: 200 }); // out of -90..90

    expect(res.status).toBe(400);
  });
});

// ── PATCH /admin/pickup-points/:id ────────────────────────────────────────────

describe('PATCH /admin/pickup-points/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — without auth token', async () => {
    const res = await request(app)
      .patch('/admin/pickup-points/1001')
      .set('X-Idempotency-Key', 'key-patch-1')
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(401);
  });

  it('400 — missing X-Idempotency-Key (authenticated but no key)', async () => {
    stubAdminClient();
    const res = await request(app)
      .patch('/admin/pickup-points/1001')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('200 — ADMIN_CLIENT can update pickup point', async () => {
    stubAdminClient();
    mockService.update.mockResolvedValue({ ...BASE_PICKUP_POINT, name: 'Updated Name' });

    const res = await request(app)
      .patch('/admin/pickup-points/1001')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'key-patch-ok')
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
    expect(mockService.update).toHaveBeenCalledWith(
      7,
      1001,
      expect.objectContaining({ name: 'Updated Name' }),
      expect.anything(),
    );
  });

  it('403 — OPERATOR_CLIENT cannot update pickup point', async () => {
    stubOperator();
    const res = await request(app)
      .patch('/admin/pickup-points/1001')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .set('X-Idempotency-Key', 'key-op-patch')
      .send({ name: 'Updated' });

    expect(res.status).toBe(403);
  });

  it('403 — BUYER cannot update pickup point', async () => {
    stubBuyer();
    const res = await request(app)
      .patch('/admin/pickup-points/1001')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .set('X-Idempotency-Key', 'key-buyer-patch')
      .send({ name: 'Updated' });

    expect(res.status).toBe(403);
  });

  it('404 — service throws RESOURCE_NOT_FOUND', async () => {
    stubAdminClient();
    mockService.update.mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Punto de recogida no encontrado'),
    );

    const res = await request(app)
      .patch('/admin/pickup-points/9999')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'key-patch-404')
      .send({ name: 'Updated' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });
});

// ── POST /admin/pickup-points/:id/activate ────────────────────────────────────

describe('POST /admin/pickup-points/:id/activate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — without auth token', async () => {
    const res = await request(app)
      .post('/admin/pickup-points/1001/activate')
      .set('X-Idempotency-Key', 'key-act-1');

    expect(res.status).toBe(401);
  });

  it('400 — missing X-Idempotency-Key (authenticated but no key)', async () => {
    stubAdminClient();
    const res = await request(app)
      .post('/admin/pickup-points/1001/activate')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('200 — ADMIN_CLIENT can activate pickup point', async () => {
    stubAdminClient();
    mockService.activate.mockResolvedValue({ ...BASE_PICKUP_POINT, status: 'ACTIVE' });

    const res = await request(app)
      .post('/admin/pickup-points/1001/activate')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'key-act-ok');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(mockService.activate).toHaveBeenCalledWith(7, 1001, expect.anything());
  });

  it('403 — BUYER cannot activate pickup point', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/admin/pickup-points/1001/activate')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .set('X-Idempotency-Key', 'key-buyer-act');

    expect(res.status).toBe(403);
  });

  it('403 — COURIER cannot activate pickup point', async () => {
    stubCourier();
    const res = await request(app)
      .post('/admin/pickup-points/1001/activate')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'key-courier-act');

    expect(res.status).toBe(403);
  });

  it('404 — service throws RESOURCE_NOT_FOUND', async () => {
    stubAdminClient();
    mockService.activate.mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Punto de recogida no encontrado'),
    );

    const res = await request(app)
      .post('/admin/pickup-points/9999/activate')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'key-act-404');

    expect(res.status).toBe(404);
  });
});

// ── POST /admin/pickup-points/:id/deactivate ──────────────────────────────────

describe('POST /admin/pickup-points/:id/deactivate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — without auth token', async () => {
    const res = await request(app)
      .post('/admin/pickup-points/1001/deactivate')
      .set('X-Idempotency-Key', 'key-deact-1');

    expect(res.status).toBe(401);
  });

  it('400 — missing X-Idempotency-Key (authenticated but no key)', async () => {
    stubAdminClient();
    const res = await request(app)
      .post('/admin/pickup-points/1001/deactivate')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('200 — ADMIN_CLIENT can deactivate pickup point', async () => {
    stubAdminClient();
    mockService.deactivate.mockResolvedValue({ ...BASE_PICKUP_POINT, status: 'INACTIVE' });

    const res = await request(app)
      .post('/admin/pickup-points/1001/deactivate')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'key-deact-ok');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('INACTIVE');
    expect(mockService.deactivate).toHaveBeenCalledWith(7, 1001, expect.anything());
  });

  it('403 — BUYER cannot deactivate pickup point', async () => {
    stubBuyer();
    const res = await request(app)
      .post('/admin/pickup-points/1001/deactivate')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .set('X-Idempotency-Key', 'key-buyer-deact');

    expect(res.status).toBe(403);
  });

  it('403 — COURIER cannot deactivate pickup point', async () => {
    stubCourier();
    const res = await request(app)
      .post('/admin/pickup-points/1001/deactivate')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'key-courier-deact');

    expect(res.status).toBe(403);
  });

  it('404 — service throws RESOURCE_NOT_FOUND', async () => {
    stubAdminClient();
    mockService.deactivate.mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Punto de recogida no encontrado'),
    );

    const res = await request(app)
      .post('/admin/pickup-points/9999/deactivate')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', 'key-deact-404');

    expect(res.status).toBe(404);
  });
});
