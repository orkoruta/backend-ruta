import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { createAuthRouter } from '../routes/auth.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';

function testApp(service: Parameters<typeof createAuthRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter(service));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
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

const loginResult = {
  accessToken: 'token.access.mock',
  refreshToken: 'token.refresh.mock',
  user: { id: 1, client_id: 1, user_type: 'BUYER', email: 'user@test.com' },
};

const adminLoginResult = {
  accessToken: 'token.access.admin',
  refreshToken: 'token.refresh.admin',
  user: { id: 9, client_id: 0, user_type: 'ADMIN_RUTA', email: 'admin@ruta.com' },
};

function serviceMock() {
  return {
    register: vi.fn().mockResolvedValue(loginResult),
    login: vi.fn().mockResolvedValue(loginResult),
    loginRutaAdmin: vi.fn().mockResolvedValue(adminLoginResult),
    refresh: vi.fn().mockResolvedValue(loginResult),
    logout: vi.fn().mockResolvedValue(undefined),
  };
}

describe('auth routes', () => {
  it('registra un comprador y devuelve access_token', async () => {
    const service = serviceMock();
    const res = await request(testApp(service))
      .post('/auth/register')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ email: 'user@test.com', password: 'password123', client_slug: 'cliente-test' })
      .expect(201);

    expect(res.body.access_token).toBe('token.access.mock');
    expect(res.body.user.email).toBe('user@test.com');
    expect(service.register).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'user@test.com', client_slug: 'cliente-test' }),
      expect.objectContaining({ ip: expect.anything() })
    );
  });

  it('requiere idempotency key para registro', async () => {
    const service = serviceMock();
    const res = await request(testApp(service))
      .post('/auth/register')
      .send({ email: 'user@test.com', password: 'password123', client_slug: 'cliente-test' })
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(service.register).not.toHaveBeenCalled();
  });

  it('login OK devuelve access_token y setea cookies', async () => {
    const service = serviceMock();
    const res = await request(testApp(service))
      .post('/auth/login')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ email: 'user@test.com', password: 'pass', client_slug: 'cliente-test' })
      .expect(200);

    expect(res.body.access_token).toBeDefined();
    expect(res.headers['set-cookie']).toBeDefined();
    expect(service.login).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'user@test.com', client_slug: 'cliente-test' }),
      expect.anything()
    );
  });

  it('login devuelve 401 con credenciales inválidas', async () => {
    const service = serviceMock();
    service.login.mockRejectedValue(new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Credenciales inválidas'));

    const res = await request(testApp(service))
      .post('/auth/login')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ email: 'bad@test.com', password: 'wrong', client_slug: 'cliente-test' })
      .expect(401);

    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('login ADMIN_RUTA OK', async () => {
    const service = serviceMock();
    const res = await request(testApp(service))
      .post('/auth/ruta-admin/login')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ email: 'admin@ruta.com', password: 'adminpass' })
      .expect(200);

    expect(res.body.user.user_type).toBe('ADMIN_RUTA');
    expect(service.loginRutaAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'admin@ruta.com' }),
      expect.anything()
    );
  });

  it('refresh devuelve nuevo access_token', async () => {
    const service = serviceMock();
    const res = await request(testApp(service))
      .post('/auth/refresh')
      .send({ refresh_token: 'token.refresh.mock' })
      .expect(200);

    expect(res.body.access_token).toBeDefined();
    expect(service.refresh).toHaveBeenCalledWith(
      { refreshToken: 'token.refresh.mock' },
      expect.anything()
    );
  });

  it('refresh devuelve 401 sin token', async () => {
    const service = serviceMock();
    const res = await request(testApp(service))
      .post('/auth/refresh')
      .send({})
      .expect(401);

    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.refresh).not.toHaveBeenCalled();
  });

  it('logout requiere autenticación', async () => {
    const service = serviceMock();
    const res = await request(testApp(service))
      .post('/auth/logout')
      .send({})
      .expect(401);

    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.logout).not.toHaveBeenCalled();
  });

  it('valida campos requeridos en login', async () => {
    const service = serviceMock();
    const res = await request(testApp(service))
      .post('/auth/login')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ email: 'bad' })
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
