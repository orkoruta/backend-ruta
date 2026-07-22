/**
 * admin_audit.test.ts — 6.QA-2
 *
 * Cobertura de admin_audit.ts:
 *  - GET /admin/audit-events — ADMIN_CLIENT, auth guards, filtros
 *  - GET /ruta-admin/audit-events — ADMIN_RUTA, auth guards, filtros cross-tenant
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
import { createAdminAuditRouter, createRutaAdminAuditRouter } from '../routes/admin_audit.js';

const mockAdminAuditService = {
  listForTenant: vi.fn(),
  listGlobal: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/admin/audit-events', createAdminAuditRouter(mockAdminAuditService));
  app.use('/ruta-admin/audit-events', createRutaAdminAuditRouter(mockAdminAuditService));
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

function stubAdminClient(clientId = 1) {
  mockVerifyAccessToken.mockResolvedValue({ sub: '21', client_id: clientId, user_type: 'ADMIN_CLIENT', session_id: 1 });
}

function stubAdminRuta() {
  mockVerifyAccessToken.mockResolvedValue({ sub: '1', client_id: 0, user_type: 'ADMIN_RUTA', session_id: 10 });
}

function stubBuyer() {
  mockVerifyAccessToken.mockResolvedValue({ sub: '41', client_id: 1, user_type: 'BUYER', session_id: 3 });
}

function stubCourier() {
  mockVerifyAccessToken.mockResolvedValue({ sub: '31', client_id: 1, user_type: 'COURIER', session_id: 4 });
}

const NOW = '2026-05-29T12:00:00.000Z';

const AUDIT_EVENTS_PAGE = {
  data: [
    {
      id: 1001,
      client_id: 1,
      actor_user_id: 21,
      actor_api_key_id: null,
      actor_type: 'USER',
      actor_role: 'ADMIN_CLIENT',
      acting_via_control_view: false,
      impersonator_user_id: null,
      control_view_session_id: null,
      action: 'ORDER_ACCEPTED',
      entity_type: 'order',
      entity_id: 701,
      ip_address: '127.0.0.1',
      user_agent: 'Mozilla/5.0',
      metadata: {},
      result: 'SUCCESS',
      occurred_at: NOW,
    },
  ],
  pagination: { page: 1, page_size: 20, total: 1 },
};

// ── GET /admin/audit-events ───────────────────────────────────────────────────

describe('GET /admin/audit-events', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — unauthenticated', async () => {
    const res = await request(app).get('/admin/audit-events');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('403 — BUYER cannot access audit events', async () => {
    stubBuyer();
    const res = await request(app)
      .get('/admin/audit-events')
      .set('Authorization', 'Bearer buyer-token');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('403 — COURIER cannot access audit events', async () => {
    stubCourier();
    const res = await request(app)
      .get('/admin/audit-events')
      .set('Authorization', 'Bearer courier-token');

    expect(res.status).toBe(403);
  });

  it('200 — ADMIN_CLIENT lists audit events for their tenant', async () => {
    stubAdminClient(1);
    mockAdminAuditService.listForTenant.mockResolvedValue(AUDIT_EVENTS_PAGE);

    const res = await request(app)
      .get('/admin/audit-events')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(mockAdminAuditService.listForTenant).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ page: 1, page_size: 20 }),
    );
  });

  it('200 — filters: entity_type and user_id are forwarded to service', async () => {
    stubAdminClient(1);
    mockAdminAuditService.listForTenant.mockResolvedValue({
      ...AUDIT_EVENTS_PAGE,
      pagination: { ...AUDIT_EVENTS_PAGE.pagination, total: 0 },
    });

    const res = await request(app)
      .get('/admin/audit-events?entity_type=order&user_id=21&page=2&page_size=10')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(200);
    expect(mockAdminAuditService.listForTenant).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ entity_type: 'order', user_id: 21, page: 2, page_size: 10 }),
    );
  });

  it('400 — invalid date format in from/to', async () => {
    stubAdminClient(1);
    const res = await request(app)
      .get('/admin/audit-events?from=not-a-date')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(400);
  });

  it('500 — service error propagates', async () => {
    stubAdminClient(1);
    mockAdminAuditService.listForTenant.mockRejectedValue(new Error('DB failure'));

    const res = await request(app)
      .get('/admin/audit-events')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(500);
  });
});

// ── GET /ruta-admin/audit-events ──────────────────────────────────────────────

describe('GET /ruta-admin/audit-events', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — unauthenticated', async () => {
    const res = await request(app).get('/ruta-admin/audit-events');
    expect(res.status).toBe(401);
  });

  it('403 — ADMIN_CLIENT cannot access global audit', async () => {
    stubAdminClient(1);
    const res = await request(app)
      .get('/ruta-admin/audit-events')
      .set('Authorization', 'Bearer admin-client-token');

    expect(res.status).toBe(403);
  });

  it('403 — BUYER cannot access global audit', async () => {
    stubBuyer();
    const res = await request(app)
      .get('/ruta-admin/audit-events')
      .set('Authorization', 'Bearer buyer-token');

    expect(res.status).toBe(403);
  });

  it('200 — ADMIN_RUTA lists global audit events', async () => {
    stubAdminRuta();
    mockAdminAuditService.listGlobal.mockResolvedValue(AUDIT_EVENTS_PAGE);

    const res = await request(app)
      .get('/ruta-admin/audit-events')
      .set('Authorization', 'Bearer ruta-token');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(mockAdminAuditService.listGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, page_size: 20 }),
    );
  });

  it('200 — client_id filter passed to service', async () => {
    stubAdminRuta();
    mockAdminAuditService.listGlobal.mockResolvedValue({
      data: [],
      pagination: { page: 1, page_size: 20, total: 0 },
    });

    const res = await request(app)
      .get('/ruta-admin/audit-events?client_id=5&entity_type=order')
      .set('Authorization', 'Bearer ruta-token');

    expect(res.status).toBe(200);
    expect(mockAdminAuditService.listGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 5, entity_type: 'order' }),
    );
  });

  it('500 — service error propagates', async () => {
    stubAdminRuta();
    mockAdminAuditService.listGlobal.mockRejectedValue(new Error('DB error'));

    const res = await request(app)
      .get('/ruta-admin/audit-events')
      .set('Authorization', 'Bearer ruta-token');

    expect(res.status).toBe(500);
  });
});
