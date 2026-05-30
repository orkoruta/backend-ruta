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
import { createControlViewRouter } from '../routes/ruta_admin_control_view.js';

// ── Mock service ──────────────────────────────────────────────────────────────

const mockService = {
  enterControlView: vi.fn(),
  exitControlView: vi.fn(),
};

// ── App under test ────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/ruta-admin/control-view', createControlViewRouter(mockService));
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

const ADMIN_RUTA_TOKEN = 'admin-ruta-token';
const BUYER_TOKEN = 'buyer-token';
const COURIER_TOKEN = 'courier-token';
const IMPERSONATION_TOKEN = 'impersonation-token';

function stubAdminRuta() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '1',
    client_id: 0,
    user_type: 'ADMIN_RUTA',
    session_id: 100,
  });
}

function stubAdminRutaImpersonating() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '1',
    client_id: 7,
    user_type: 'ADMIN_RUTA',
    session_id: 200,
    impersonating: true,
    target_client_id: 7,
  });
}

function stubBuyer() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '10',
    client_id: 7,
    user_type: 'BUYER',
    session_id: 300,
  });
}

function stubCourier() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '20',
    client_id: 7,
    user_type: 'COURIER',
    session_id: 400,
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ENTER_BODY = {
  target_client_id: 7,
  master_password: 'sup3r-s3cr3t-master-password',
};

const ENTER_RESULT = {
  accessToken: 'new-access-token-with-impersonation',
  refreshToken: 'new-refresh-token',
  targetClient: { id: 7, name: 'Acme Corp', slug: 'acme-corp' },
};

// ── POST /ruta-admin/control-view/enter ───────────────────────────────────────

describe('POST /ruta-admin/control-view/enter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — without auth token', async () => {
    const res = await request(app)
      .post('/ruta-admin/control-view/enter')
      .send(ENTER_BODY);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('200 — ADMIN_RUTA with correct master password gets impersonation token', async () => {
    stubAdminRuta();
    mockService.enterControlView.mockResolvedValue(ENTER_RESULT);

    const res = await request(app)
      .post('/ruta-admin/control-view/enter')
      .set('Authorization', `Bearer ${ADMIN_RUTA_TOKEN}`)
      .send(ENTER_BODY);

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe(ENTER_RESULT.accessToken);
    expect(res.body.refresh_token).toBe(ENTER_RESULT.refreshToken);
    expect(res.body.target_client).toEqual(ENTER_RESULT.targetClient);
    expect(mockService.enterControlView).toHaveBeenCalledOnce();
    expect(mockService.enterControlView).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, user_type: 'ADMIN_RUTA' }),
      expect.objectContaining({
        targetClientId: ENTER_BODY.target_client_id,
        masterPassword: ENTER_BODY.master_password,
      }),
      expect.objectContaining({ ip: expect.anything() })
    );
  });

  it('401 — incorrect master password (service throws 401)', async () => {
    stubAdminRuta();
    mockService.enterControlView.mockRejectedValue(
      new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Contraseña maestra inválida')
    );

    const res = await request(app)
      .post('/ruta-admin/control-view/enter')
      .set('Authorization', `Bearer ${ADMIN_RUTA_TOKEN}`)
      .send(ENTER_BODY);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('404 — target client does not exist (service throws 404)', async () => {
    stubAdminRuta();
    mockService.enterControlView.mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Cliente no encontrado')
    );

    const res = await request(app)
      .post('/ruta-admin/control-view/enter')
      .set('Authorization', `Bearer ${ADMIN_RUTA_TOKEN}`)
      .send({ ...ENTER_BODY, target_client_id: 9999 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('403 — BUYER cannot use Vista de Control', async () => {
    stubBuyer();

    const res = await request(app)
      .post('/ruta-admin/control-view/enter')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .send(ENTER_BODY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(mockService.enterControlView).not.toHaveBeenCalled();
  });

  it('403 — COURIER cannot use Vista de Control', async () => {
    stubCourier();

    const res = await request(app)
      .post('/ruta-admin/control-view/enter')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .send(ENTER_BODY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(mockService.enterControlView).not.toHaveBeenCalled();
  });

  it('400 — missing required fields in body', async () => {
    stubAdminRuta();

    const res = await request(app)
      .post('/ruta-admin/control-view/enter')
      .set('Authorization', `Bearer ${ADMIN_RUTA_TOKEN}`)
      .send({ target_client_id: 7 }); // missing master_password

    expect(res.status).toBe(400);
  });

  it('200 — accepts optional reason field', async () => {
    stubAdminRuta();
    mockService.enterControlView.mockResolvedValue(ENTER_RESULT);

    const res = await request(app)
      .post('/ruta-admin/control-view/enter')
      .set('Authorization', `Bearer ${ADMIN_RUTA_TOKEN}`)
      .send({ ...ENTER_BODY, reason: 'Soporte ticket #1234' });

    expect(res.status).toBe(200);
    expect(mockService.enterControlView).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'Soporte ticket #1234' }),
      expect.anything()
    );
  });
});

// ── POST /ruta-admin/control-view/exit ───────────────────────────────────────

describe('POST /ruta-admin/control-view/exit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 — without auth token', async () => {
    const res = await request(app)
      .post('/ruta-admin/control-view/exit')
      .set('X-Idempotency-Key', 'test-idem-key-1');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('400 — missing X-Idempotency-Key header', async () => {
    stubAdminRuta();

    const res = await request(app)
      .post('/ruta-admin/control-view/exit')
      .set('Authorization', `Bearer ${ADMIN_RUTA_TOKEN}`)
      .send();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(mockService.exitControlView).not.toHaveBeenCalled();
  });

  it('200 — ADMIN_RUTA can exit Vista de Control', async () => {
    stubAdminRuta();
    mockService.exitControlView.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/ruta-admin/control-view/exit')
      .set('Authorization', `Bearer ${ADMIN_RUTA_TOKEN}`)
      .set('X-Idempotency-Key', 'exit-idem-key-1')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();
    expect(mockService.exitControlView).toHaveBeenCalledOnce();
  });

  it('200 — impersonating ADMIN_RUTA can exit Vista de Control', async () => {
    stubAdminRutaImpersonating();
    mockService.exitControlView.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/ruta-admin/control-view/exit')
      .set('Authorization', `Bearer ${IMPERSONATION_TOKEN}`)
      .set('X-Idempotency-Key', 'exit-idem-key-2')
      .send();

    expect(res.status).toBe(200);
    expect(mockService.exitControlView).toHaveBeenCalledOnce();
    expect(mockService.exitControlView).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, session_id: 200 }),
      expect.anything()
    );
  });

  it('403 — BUYER cannot exit Vista de Control', async () => {
    stubBuyer();

    const res = await request(app)
      .post('/ruta-admin/control-view/exit')
      .set('Authorization', `Bearer ${BUYER_TOKEN}`)
      .set('X-Idempotency-Key', 'exit-buyer-idem-1')
      .send();

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(mockService.exitControlView).not.toHaveBeenCalled();
  });

  it('403 — COURIER cannot exit Vista de Control', async () => {
    stubCourier();

    const res = await request(app)
      .post('/ruta-admin/control-view/exit')
      .set('Authorization', `Bearer ${COURIER_TOKEN}`)
      .set('X-Idempotency-Key', 'exit-courier-idem-1')
      .send();

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(mockService.exitControlView).not.toHaveBeenCalled();
  });
});
