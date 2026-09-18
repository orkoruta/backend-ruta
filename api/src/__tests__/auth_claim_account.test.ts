/**
 * POST /auth/claim-account — un invitado se queda con su cuenta.
 *
 * Lo que importa de verdad aquí no es el camino feliz, sino que la conversión
 * **no** sea una puerta trasera: sin sesión no se puede llamar, un usuario que
 * ya tiene cuenta no puede cambiarse correo y contraseña sin la actual, y el
 * Cliente sale de la sesión y nunca del cuerpo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockVerifyAccessToken = vi.fn();

vi.mock('../lib/token.js', () => ({
  verifyAccessToken: (...args: unknown[]) => mockVerifyAccessToken(...args),
}));

vi.mock('../middleware/logger.js', () => ({
  loggerMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import express from 'express';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import { createAuthRouter } from '../routes/auth.js';

const mockService = {
  register: vi.fn(),
  startGuest: vi.fn(),
  claimAccount: vi.fn(),
  login: vi.fn(),
  loginRutaAdmin: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/auth', createAuthRouter(mockService as never));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json(toApiError('VALIDATION_ERROR', 'Datos inválidos'));
      return;
    }
    if (err instanceof HttpError) {
      // `sendHttpError` devuelve el cuerpo; no envía. Llamarla como si enviara
      // deja la petición abierta y el test muere por timeout sin decir por qué.
      res.status(err.statusCode).json(sendHttpError(err));
      return;
    }
    res.status(500).json(toApiError('INTERNAL_ERROR', 'Error interno'));
  });
  return app;
}

const SESION_INVITADO = {
  id: 32,
  client_id: 7,
  session_id: 1,
  user_type: 'BUYER' as const,
  email: 'guest-abc@guest.ruta',
};

const RESULTADO = {
  accessToken: 'nuevo-access',
  refreshToken: 'nuevo-refresh',
  expiresInSeconds: 1800,
  user: { id: 32, client_id: 7, user_type: 'BUYER', email: 'simon@ejemplo.com' },
};

const CUERPO = { email: 'simon@ejemplo.com', password: 'unaClaveLarga1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyAccessToken.mockResolvedValue(SESION_INVITADO);
});

describe('POST /auth/claim-account', () => {
  it('convierte al invitado y devuelve cookies nuevas', async () => {
    mockService.claimAccount.mockResolvedValue(RESULTADO);

    const res = await request(buildApp())
      .post('/auth/claim-account')
      .set('Cookie', ['access_token=t'])
      .set('X-Idempotency-Key', 'k-1')
      .send(CUERPO);

    expect(res.status).toBe(200);
    expect(res.body.is_guest).toBe(false);
    expect(res.body.email).toBe('simon@ejemplo.com');

    // Cookies nuevas: la identidad cambió, las del invitado ya no valen.
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('access_token='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('refresh_token='))).toBe(true);
  });

  it('el Cliente sale de la sesión, no del cuerpo', async () => {
    mockService.claimAccount.mockResolvedValue(RESULTADO);

    await request(buildApp())
      .post('/auth/claim-account')
      .set('Cookie', ['access_token=t'])
      .set('X-Idempotency-Key', 'k-2')
      // Un client_slug colado en el cuerpo no debe llegar al servicio.
      .send({ ...CUERPO, client_slug: 'otro-cliente' });

    const [actor, input] = mockService.claimAccount.mock.calls[0];
    expect(actor.client_id).toBe(7);
    expect(input).not.toHaveProperty('client_slug');
  });

  it('sin sesión responde 401', async () => {
    mockVerifyAccessToken.mockRejectedValue(new Error('sin token'));

    const res = await request(buildApp())
      .post('/auth/claim-account')
      .set('X-Idempotency-Key', 'k-3')
      .send(CUERPO);

    expect(res.status).toBe(401);
    expect(mockService.claimAccount).not.toHaveBeenCalled();
  });

  it('exige la cabecera de idempotencia, como toda mutación', async () => {
    const res = await request(buildApp())
      .post('/auth/claim-account')
      .set('Cookie', ['access_token=t'])
      .send(CUERPO);

    expect(res.status).toBe(400);
    expect(mockService.claimAccount).not.toHaveBeenCalled();
  });

  it('rechaza una contraseña corta con el mismo mínimo que el registro', async () => {
    const res = await request(buildApp())
      .post('/auth/claim-account')
      .set('Cookie', ['access_token=t'])
      .set('X-Idempotency-Key', 'k-4')
      .send({ email: 'simon@ejemplo.com', password: 'corta1' });

    expect(res.status).toBe(400);
    expect(mockService.claimAccount).not.toHaveBeenCalled();
  });

  it('propaga el 422 cuando la sesión ya tiene cuenta', async () => {
    mockService.claimAccount.mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'Esta sesión ya tiene una cuenta'),
    );

    const res = await request(buildApp())
      .post('/auth/claim-account')
      .set('Cookie', ['access_token=t'])
      .set('X-Idempotency-Key', 'k-5')
      .send(CUERPO);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('propaga el 409 cuando el correo ya tiene cuenta', async () => {
    mockService.claimAccount.mockRejectedValue(
      new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Ese correo ya tiene cuenta'),
    );

    const res = await request(buildApp())
      .post('/auth/claim-account')
      .set('Cookie', ['access_token=t'])
      .set('X-Idempotency-Key', 'k-6')
      .send(CUERPO);

    expect(res.status).toBe(409);
  });
});
