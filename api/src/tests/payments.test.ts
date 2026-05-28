/**
 * payments.test.ts — Tests de rutas y servicios de pagos (2.BACK-3)
 *
 * Cobertura:
 *   C1-C5  WompiClient: checkout URL, referencia, HMAC válido, inválido, length mismatch
 *   P1     buyer inicia pago correctamente → 200
 *   P2     INVALID_STATE_TRANSITION desde service → 422
 *   P3     FORBIDDEN desde service → 403
 *   P4     sin X-Idempotency-Key → 400
 *   P5     rol ADMIN_CLIENT (no BUYER) → 403
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { ZodError } from 'zod';
import { createBuyerPaymentRouter } from '../routes/buyer_payment.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { PaymentStatus } from '@orkoruta/shared';
import { WompiClient } from '../lib/wompi_client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.statusCode).json(sendHttpError(err));
    return;
  }
  res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno'));
}

function withUser(user: AuthenticatedUser) {
  return (_req: Request, _res: Response, next: NextFunction) => {
    (_req as Request & { user: AuthenticatedUser }).user = user;
    next();
  };
}

const buyerUser: AuthenticatedUser = { id: 10, client_id: 1, user_type: 'BUYER', session_id: 100 };
const adminUser: AuthenticatedUser = { id: 20, client_id: 1, user_type: 'ADMIN_CLIENT', session_id: 200 };

// ─── C: WompiClient unit tests ────────────────────────────────────────────────

describe('WompiClient', () => {
  const SECRET = 'secret-32chars-abcdefgh-ijklmnop';
  const client = new WompiClient({
    publicKey: 'pub_test_key',
    privateKey: 'prv_test_key',
    webhookSecret: SECRET,
    sandbox: true,
  });

  it('C1 — buildCheckoutUrl contiene todos los parámetros obligatorios', () => {
    const url = client.buildCheckoutUrl({
      reference: 'RUTA-5001-ABCD',
      amountInCents: 10500000,
      currency: 'COP',
    });
    expect(url).toContain('checkout.wompi.co');
    expect(url).toContain('public-key=pub_test_key');
    expect(url).toContain('reference=RUTA-5001-ABCD');
    expect(url).toContain('amount-in-cents=10500000');
    expect(url).toContain('currency=COP');
  });

  it('C2 — buildCheckoutUrl incluye redirect-url si se pasa', () => {
    const url = client.buildCheckoutUrl({
      reference: 'RUTA-5001-ABCD',
      amountInCents: 10500000,
      currency: 'COP',
      redirectUrl: 'https://example.com/return',
    });
    expect(url).toContain('redirect-url=');
  });

  it('C3 — generateReference tiene formato RUTA-{id}-{HEX8}', () => {
    const ref = client.generateReference(5001n);
    expect(ref).toMatch(/^RUTA-5001-[A-F0-9]{8}$/);
  });

  it('C4 — verifySignature valida HMAC correcto', () => {
    const body = '{"event":"transaction.updated"}';
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(client.verifySignature(body, sig)).toBe(true);
  });

  it('C5a — verifySignature rechaza HMAC incorrecto', () => {
    const body = '{"event":"transaction.updated"}';
    const badSig = 'a'.repeat(64);
    expect(client.verifySignature(body, badSig)).toBe(false);
  });

  it('C5b — verifySignature rechaza signature de longitud inválida', () => {
    expect(client.verifySignature('{}', 'short')).toBe(false);
  });

  it('C5c — verifySignature rechaza string vacío', () => {
    expect(client.verifySignature('{}', '')).toBe(false);
  });
});

// ─── P: buyer_payment route tests ────────────────────────────────────────────

describe('buyer payment route', () => {
  const initiateMock = vi.fn().mockResolvedValue({
    order_id: 5001,
    payment_status: PaymentStatus.PAYMENT_PROCESSING,
    wompi_checkout_url: 'https://checkout.wompi.co/p/?public-key=pub_test&reference=RUTA-5001-ABCD',
    wompi_reference: 'RUTA-5001-ABCD',
  });

  function testApp(user: AuthenticatedUser, initiateFn = initiateMock) {
    const app = express();
    app.use(express.json());
    app.use(withUser(user) as express.RequestHandler);
    app.use('/buyer', createBuyerPaymentRouter({ initiatePayment: initiateFn }));
    app.use(errorHandler as express.ErrorRequestHandler);
    return app;
  }

  it('P1 — buyer inicia pago correctamente', async () => {
    const res = await request(testApp(buyerUser))
      .post('/buyer/orders/5001/initiate-payment')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({})
      .expect(200);

    expect(res.body.payment_status).toBe(PaymentStatus.PAYMENT_PROCESSING);
    expect(res.body.wompi_checkout_url).toContain('checkout.wompi.co');
    expect(initiateMock).toHaveBeenCalledWith(5001n, buyerUser, undefined);
  });

  it('P2 — INVALID_STATE_TRANSITION desde service → 422', async () => {
    const svc = vi.fn().mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'No se puede iniciar el pago'),
    );
    const res = await request(testApp(buyerUser, svc))
      .post('/buyer/orders/5001/initiate-payment')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({})
      .expect(422);

    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('P3 — FORBIDDEN desde service → 403', async () => {
    const svc = vi.fn().mockRejectedValue(
      new HttpError(403, 'FORBIDDEN', 'Pedido no pertenece al comprador'),
    );
    await request(testApp(buyerUser, svc))
      .post('/buyer/orders/5001/initiate-payment')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({})
      .expect(403);
  });

  it('P4 — sin X-Idempotency-Key → 400', async () => {
    await request(testApp(buyerUser))
      .post('/buyer/orders/5001/initiate-payment')
      .send({})
      .expect(400);
  });

  it('P5 — ADMIN_CLIENT recibe 403 (solo BUYER puede iniciar pagos)', async () => {
    await request(testApp(adminUser))
      .post('/buyer/orders/5001/initiate-payment')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({})
      .expect(403);
  });

  it('P6 — order_id inválido (no número) → 400', async () => {
    await request(testApp(buyerUser))
      .post('/buyer/orders/abc/initiate-payment')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({})
      .expect(400);
  });

  it('P7 — redirect_url inválida → 400', async () => {
    await request(testApp(buyerUser))
      .post('/buyer/orders/5001/initiate-payment')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ redirect_url: 'not-a-url' })
      .expect(400);
  });
});
