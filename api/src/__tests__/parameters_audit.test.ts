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
import { createAdminParametersRouter } from '../routes/admin_parameters.js';
import { createAdminAuditRouter, createRutaAdminAuditRouter } from '../routes/admin_audit.js';

// ── Mock services ─────────────────────────────────────────────────────────────

const mockParamService = {
  list: vi.fn(),
  upsert: vi.fn(),
  auditParameterUpdated: vi.fn(),
};

const mockAuditService = {
  listForTenant: vi.fn(),
  listGlobal: vi.fn(),
};

// ── Error handler helper ──────────────────────────────────────────────────────

function addErrorHandler(app: express.Express) {
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
}

// ── Apps under test ───────────────────────────────────────────────────────────

function buildParametersApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/admin/parameters', createAdminParametersRouter(mockParamService));
  addErrorHandler(app);
  return app;
}

function buildAuditApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/admin/audit-events', createAdminAuditRouter(mockAuditService));
  app.use('/ruta-admin/audit-events', createRutaAdminAuditRouter(mockAuditService));
  addErrorHandler(app);
  return app;
}

const parametersApp = buildParametersApp();
const auditApp = buildAuditApp();

// ── Token helpers ─────────────────────────────────────────────────────────────

const ADMIN_TOKEN = 'admin-token';
const BUYER_TOKEN = 'buyer-token';
const RUTA_TOKEN = 'ruta-token';
const IDEMPOTENCY_KEY = '550e8400-e29b-41d4-a716-446655440000';

function stubAdminClient() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '42',
    client_id: 7,
    user_type: 'ADMIN_CLIENT',
    session_id: 1,
  });
}

function stubBuyer() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '99',
    client_id: 7,
    user_type: 'BUYER',
    session_id: 2,
  });
}

function stubAdminRuta() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '1',
    client_id: 0,
    user_type: 'ADMIN_RUTA',
    session_id: 3,
  });
}

// ── Shared fixture ────────────────────────────────────────────────────────────

const sampleParameter = {
  id: 1,
  client_id: 7,
  parameter_key: 'order.draft_expiration_minutes',
  parameter_value: '720',
  value_type: 'INTEGER',
  description: 'Tiempo máximo en DRAFT',
  is_overrideable_by_client: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const sampleAuditEvent = {
  id: 1,
  client_id: 7,
  actor_user_id: 42,
  actor_api_key_id: null,
  actor_type: 'USER',
  actor_role: 'ADMIN_CLIENT',
  acting_via_control_view: false,
  impersonator_user_id: null,
  control_view_session_id: null,
  action: 'PARAMETER_UPDATED',
  entity_type: 'client_parameters',
  entity_id: null,
  ip_address: null,
  user_agent: null,
  metadata: { parameter_key: 'order.draft_expiration_minutes', new_value: '720' },
  result: 'SUCCESS',
  occurred_at: '2026-01-01T00:00:00.000Z',
};

// ─────────────────────────────────────────────────────────────────────────────
// PARAMETERS
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /admin/parameters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParamService.auditParameterUpdated.mockResolvedValue(undefined);
  });

  it('returns 401 without auth token', async () => {
    const res = await request(parametersApp).get('/admin/parameters');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 for BUYER role', async () => {
    stubBuyer();
    const res = await request(parametersApp)
      .get('/admin/parameters')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 200 with list of parameters for ADMIN_CLIENT', async () => {
    stubAdminClient();
    mockParamService.list.mockResolvedValue([sampleParameter]);

    const res = await request(parametersApp)
      .get('/admin/parameters')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].parameter_key).toBe('order.draft_expiration_minutes');
    expect(mockParamService.list).toHaveBeenCalledWith(7, undefined);
  });

  it('passes group filter to service', async () => {
    stubAdminClient();
    mockParamService.list.mockResolvedValue([sampleParameter]);

    const res = await request(parametersApp)
      .get('/admin/parameters?group=order')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockParamService.list).toHaveBeenCalledWith(7, 'order');
  });

  it('returns 200 empty array when no parameters exist', async () => {
    stubAdminClient();
    mockParamService.list.mockResolvedValue([]);

    const res = await request(parametersApp)
      .get('/admin/parameters')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('PATCH /admin/parameters/:key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParamService.auditParameterUpdated.mockResolvedValue(undefined);
  });

  it('returns 401 without auth token', async () => {
    const res = await request(parametersApp)
      .patch('/admin/parameters/order.draft_expiration_minutes')
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ value: '720' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for BUYER role', async () => {
    stubBuyer();
    const res = await request(parametersApp)
      .patch('/admin/parameters/order.draft_expiration_minutes')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ value: '720' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 400 without X-Idempotency-Key header', async () => {
    stubAdminClient();
    const res = await request(parametersApp)
      .patch('/admin/parameters/order.draft_expiration_minutes')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ value: '720' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when body is missing value', async () => {
    stubAdminClient();
    const res = await request(parametersApp)
      .patch('/admin/parameters/order.draft_expiration_minutes')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when value is empty string', async () => {
    stubAdminClient();
    const res = await request(parametersApp)
      .patch('/admin/parameters/order.draft_expiration_minutes')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ value: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 200 and updated parameter on success', async () => {
    stubAdminClient();
    const updated = { ...sampleParameter, parameter_value: '720' };
    mockParamService.upsert.mockResolvedValue(updated);

    const res = await request(parametersApp)
      .patch('/admin/parameters/order.draft_expiration_minutes')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ value: '720' });

    expect(res.status).toBe(200);
    expect(res.body.parameter_value).toBe('720');
    expect(mockParamService.upsert).toHaveBeenCalledWith(7, 'order.draft_expiration_minutes', '720');
  });

  it('calls auditParameterUpdated after successful update', async () => {
    stubAdminClient();
    mockParamService.upsert.mockResolvedValue(sampleParameter);
    mockParamService.auditParameterUpdated.mockResolvedValue(undefined);

    await request(parametersApp)
      .patch('/admin/parameters/order.draft_expiration_minutes')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ value: '720' });

    // Allow the fire-and-forget audit to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(mockParamService.auditParameterUpdated).toHaveBeenCalledWith(
      7,
      42,
      'ADMIN_CLIENT',
      'order.draft_expiration_minutes',
      '720',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT — ADMIN_CLIENT
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /admin/audit-events (ADMIN_CLIENT)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 without auth token', async () => {
    const res = await request(auditApp).get('/admin/audit-events');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 for BUYER role', async () => {
    stubBuyer();
    const res = await request(auditApp)
      .get('/admin/audit-events')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 200 with audit events for the tenant', async () => {
    stubAdminClient();
    const payload = {
      items: [sampleAuditEvent],
      pagination: { page: 1, page_size: 20, total: 1 },
    };
    mockAuditService.listForTenant.mockResolvedValue(payload);

    const res = await request(auditApp)
      .get('/admin/audit-events')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].action).toBe('PARAMETER_UPDATED');
    expect(res.body.pagination.total).toBe(1);
    expect(mockAuditService.listForTenant).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ page: 1, page_size: 20 }),
    );
  });

  it('passes entity_type filter', async () => {
    stubAdminClient();
    mockAuditService.listForTenant.mockResolvedValue({ items: [], pagination: { page: 1, page_size: 20, total: 0 } });

    await request(auditApp)
      .get('/admin/audit-events?entity_type=orders')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(mockAuditService.listForTenant).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ entity_type: 'orders' }),
    );
  });

  it('passes date filters (from/to)', async () => {
    stubAdminClient();
    mockAuditService.listForTenant.mockResolvedValue({ items: [], pagination: { page: 1, page_size: 20, total: 0 } });

    await request(auditApp)
      .get('/admin/audit-events?from=2026-01-01T00:00:00.000Z&to=2026-01-31T23:59:59.000Z')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(mockAuditService.listForTenant).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-31T23:59:59.000Z',
      }),
    );
  });

  it('returns 400 for invalid date format', async () => {
    stubAdminClient();

    const res = await request(auditApp)
      .get('/admin/audit-events?from=not-a-date')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('respects pagination parameters', async () => {
    stubAdminClient();
    mockAuditService.listForTenant.mockResolvedValue({ items: [], pagination: { page: 2, page_size: 10, total: 0 } });

    await request(auditApp)
      .get('/admin/audit-events?page=2&page_size=10')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(mockAuditService.listForTenant).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ page: 2, page_size: 10 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT — ADMIN_RUTA
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /ruta-admin/audit-events (ADMIN_RUTA)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 without auth token', async () => {
    const res = await request(auditApp).get('/ruta-admin/audit-events');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 for ADMIN_CLIENT role', async () => {
    stubAdminClient();
    const res = await request(auditApp)
      .get('/ruta-admin/audit-events')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 200 with all-tenant events when no client_id filter', async () => {
    stubAdminRuta();
    const payload = {
      items: [sampleAuditEvent, { ...sampleAuditEvent, id: 2, client_id: 8 }],
      pagination: { page: 1, page_size: 20, total: 2 },
    };
    mockAuditService.listGlobal.mockResolvedValue(payload);

    const res = await request(auditApp)
      .get('/ruta-admin/audit-events')
      .set('Authorization', `Bearer ${RUTA_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(mockAuditService.listGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, page_size: 20 }),
    );
  });

  it('filters by client_id when provided', async () => {
    stubAdminRuta();
    mockAuditService.listGlobal.mockResolvedValue({
      items: [sampleAuditEvent],
      pagination: { page: 1, page_size: 20, total: 1 },
    });

    await request(auditApp)
      .get('/ruta-admin/audit-events?client_id=7')
      .set('Authorization', `Bearer ${RUTA_TOKEN}`);

    expect(mockAuditService.listGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 7 }),
    );
  });

  it('passes entity_type and date filters cross-tenant', async () => {
    stubAdminRuta();
    mockAuditService.listGlobal.mockResolvedValue({ items: [], pagination: { page: 1, page_size: 20, total: 0 } });

    await request(auditApp)
      .get('/ruta-admin/audit-events?entity_type=client_parameters&from=2026-01-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${RUTA_TOKEN}`);

    expect(mockAuditService.listGlobal).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'client_parameters',
        from: '2026-01-01T00:00:00.000Z',
      }),
    );
  });
});
