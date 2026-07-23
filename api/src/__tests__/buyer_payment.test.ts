import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ── Auth mock (antes de importar la app) ──────────────────────────────────────

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
import { authenticate } from '../middleware/auth.js';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import { createBuyerPaymentRouter } from '../routes/buyer_payment.js';

const mockService = {
  initiatePayment: vi.fn(),
} as unknown as Parameters<typeof createBuyerPaymentRouter>[0];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/buyer', createBuyerPaymentRouter(mockService));
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
const TOKEN = 'buyer-token';

function stubBuyer() {
  mockVerifyAccessToken.mockResolvedValue({
    sub: '99', client_id: 7, user_type: 'BUYER', session_id: 1,
  });
}

describe('POST /buyer/orders/:id/initiate-payment', () => {
  beforeEach(() => vi.clearAllMocks());

  // El frontend llama SIN cuerpo (redirect_url es opcional). El bug era que
  // `parse(undefined)` fallaba con 400 "Required" y rompía el pago online.
  it('200 — acepta la llamada sin cuerpo (no exige body)', async () => {
    stubBuyer();
    (mockService.initiatePayment as ReturnType<typeof vi.fn>).mockResolvedValue({
      order_id: 5001,
      payment_status: 'PENDING_ONLINE_PAYMENT',
      wompi_checkout_url: 'https://checkout.wompi.co/p/?public-key=pub_test',
      wompi_reference: 'RUTA-5001-ABC',
    });

    const res = await request(app)
      .post('/buyer/orders/5001/initiate-payment')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-Idempotency-Key', 'init-pay-nobody');

    expect(res.status).toBe(200);
    expect(res.body.wompi_checkout_url).toContain('checkout.wompi.co');
    expect(mockService.initiatePayment).toHaveBeenCalledTimes(1);
  });

  it('acepta un cuerpo con redirect_url opcional', async () => {
    stubBuyer();
    (mockService.initiatePayment as ReturnType<typeof vi.fn>).mockResolvedValue({
      order_id: 5001, wompi_checkout_url: 'https://checkout.wompi.co/p/x', wompi_reference: 'RUTA-5001-XYZ',
    });

    const res = await request(app)
      .post('/buyer/orders/5001/initiate-payment')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-Idempotency-Key', 'init-pay-redirect')
      .send({ redirect_url: 'https://tienda.example.com/gracias' });

    expect(res.status).toBe(200);
    expect(mockService.initiatePayment).toHaveBeenCalledWith(
      5001n,
      expect.anything(),
      'https://tienda.example.com/gracias',
    );
  });

  it('403 — un no-comprador no puede iniciar pago', async () => {
    mockVerifyAccessToken.mockResolvedValue({ sub: '1', client_id: 7, user_type: 'ADMIN_CLIENT', session_id: 1 });

    const res = await request(app)
      .post('/buyer/orders/5001/initiate-payment')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-Idempotency-Key', 'init-pay-admin');

    expect(res.status).toBe(403);
    expect(mockService.initiatePayment).not.toHaveBeenCalled();
  });
});
