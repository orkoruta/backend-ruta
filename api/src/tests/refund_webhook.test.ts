/**
 * refund_webhook.test.ts — Tests del webhook de reembolso Wompi (F3.B1.2.BACK-2)
 *
 * Cobertura:
 *   W1  Wompi refund confirmado (APPROVED) → handleProviderRefundWebhook con outcome REFUNDED
 *   W2  Wompi refund rechazado (DECLINED)  → handleProviderRefundWebhook con outcome FAILED
 *   W3  Webhook duplicado → procesado una sola vez (deduplicación)
 *   W4  Firma HMAC inválida → 400 WEBHOOK_SIGNATURE_INVALID
 */

import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';

// ─── DB mock (vi.hoisted) ─────────────────────────────────────────────────────

const dbMock = vi.hoisted(() => {
  const readTx = {
    client_payment_providers: { findUnique: vi.fn() },
    orders: { findFirst: vi.fn() },
    payments: { findFirst: vi.fn() },
    refunds: { findFirst: vi.fn() },
  };

  const writeTx = {
    external_webhook_events: { create: vi.fn() },
    orders: { update: vi.fn() },
    payments: { updateMany: vi.fn() },
    // handleProviderRefundWebhook llama findFirst dentro de withTenant para verificar estado
    refunds: { findFirst: vi.fn(), update: vi.fn() },
    audit_events: { create: vi.fn() },
  };

  return {
    readTx,
    writeTx,
    prisma: {
      external_webhook_events: { findUnique: vi.fn() },
    },
    withTenantReadOnly: vi.fn(
      (_clientId: number, _role: string, callback: (tx: typeof readTx) => unknown) =>
        callback(readTx),
    ),
    withTenant: vi.fn(
      (_clientId: number, _role: string, callback: (tx: typeof writeTx) => unknown) =>
        callback(writeTx),
    ),
  };
});

vi.mock('@orkoruta/db', () => ({
  prisma: dbMock.prisma,
  withTenantReadOnly: dbMock.withTenantReadOnly,
  withTenant: dbMock.withTenant,
}));

const { createWebhooksRouter } = await import('../routes/webhooks.js');

// ─── Constantes ───────────────────────────────────────────────────────────────

const CLIENT_ID = 7;
const PROVIDER_ID = 11n;
const WEBHOOK_SECRET = 'wompi-webhook-secret';
const WOMPI_TRANSACTION_ID = 'txn_original_abc123';
const WOMPI_REFUND_ID = 'ref_wompi_xyz456';
const ORDER_ID = 5001n;
const REFUND_RECORD_ID = 99n;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.statusCode).json(sendHttpError(err));
    return;
  }
  res.status(500).json(toApiError('INTERNAL_ERROR', 'Error interno'));
}

function testApp() {
  const app = express();
  app.use('/webhooks', express.raw({ type: 'application/json' }), createWebhooksRouter());
  app.use(errorHandler as express.ErrorRequestHandler);
  return app;
}

function refundWebhookPayload(status: 'APPROVED' | 'DECLINED' | 'ERROR' = 'APPROVED') {
  return {
    event: 'refund.updated',
    data: {
      refund: {
        id: WOMPI_REFUND_ID,
        status,
        transaction_id: WOMPI_TRANSACTION_ID,
        amount_in_cents: 50000_00,
      },
    },
    timestamp: 1779969600,
    environment: 'test',
  };
}

function sign(rawBody: string): string {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

function postWebhook(rawBody: string, signature = sign(rawBody)) {
  return request(testApp())
    .post(`/webhooks/wompi/${CLIENT_ID}/${PROVIDER_ID.toString()}`)
    .set('Content-Type', 'application/json')
    .set('X-Event-Checksum', signature)
    .send(rawBody);
}

// ─── Setup por defecto ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Proveedor activo con secret conocido
  dbMock.readTx.client_payment_providers.findUnique.mockResolvedValue({
    id: PROVIDER_ID,
    webhook_secret: WEBHOOK_SECRET,
    status: 'ACTIVE',
  });

  // No hay evento duplicado por defecto
  dbMock.prisma.external_webhook_events.findUnique.mockResolvedValue(null);

  // Pago original encontrado
  dbMock.readTx.payments.findFirst.mockResolvedValue({
    id: 200n,
    order_id: ORDER_ID,
  });

  // Refund record en PROVIDER_REQUESTED (en readTx para búsquedas externas al servicio)
  dbMock.readTx.refunds.findFirst.mockResolvedValue({
    id: REFUND_RECORD_ID,
    status: 'PROVIDER_REQUESTED',
  });

  // Mocks de escritura
  dbMock.writeTx.external_webhook_events.create.mockResolvedValue({ id: 300n });
  // handleProviderRefundWebhook llama findFirst dentro de withTenant para verificar estado
  dbMock.writeTx.refunds.findFirst.mockResolvedValue({
    id: REFUND_RECORD_ID,
    status: 'PROVIDER_REQUESTED',
    order_id: ORDER_ID,
  });
  dbMock.writeTx.refunds.update.mockResolvedValue({ id: REFUND_RECORD_ID, status: 'REFUNDED' });
  dbMock.writeTx.orders.update.mockResolvedValue({});
  dbMock.writeTx.audit_events.create.mockResolvedValue({ id: 1n });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('W1 — Wompi refund confirmado → handleProviderRefundWebhook REFUNDED', () => {
  it('registra el evento, llama al servicio con outcome REFUNDED y retorna 200', async () => {
    const rawBody = JSON.stringify(refundWebhookPayload('APPROVED'));

    const res = await postWebhook(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // Deduplicación consultada
    expect(dbMock.prisma.external_webhook_events.findUnique).toHaveBeenCalledWith({
      where: {
        payment_provider_id_provider_event_id: {
          payment_provider_id: PROVIDER_ID,
          provider_event_id: `refund_${WOMPI_REFUND_ID}`,
        },
      },
      select: { id: true },
    });

    // Evento externo registrado
    expect(dbMock.writeTx.external_webhook_events.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        client_id: BigInt(CLIENT_ID),
        payment_provider_id: PROVIDER_ID,
        provider_event_id: `refund_${WOMPI_REFUND_ID}`,
        signature_valid: true,
        processing_result: 'REFUND_REFUNDED',
        related_order_id: ORDER_ID,
      }),
    });

    // Refund actualizado a REFUNDED
    expect(dbMock.writeTx.refunds.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REFUNDED', external_provider_refund_id: WOMPI_REFUND_ID }),
      }),
    );

    // orders.refund_status actualizado
    expect(dbMock.writeTx.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refund_status: 'REFUNDED' }),
      }),
    );
  });
});

describe('W2 — Wompi refund rechazado → handleProviderRefundWebhook FAILED', () => {
  it('registra el evento y marca el reembolso como FAILED', async () => {
    dbMock.writeTx.refunds.update.mockResolvedValue({ id: REFUND_RECORD_ID, status: 'FAILED' });
    const rawBody = JSON.stringify(refundWebhookPayload('DECLINED'));

    const res = await postWebhook(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    expect(dbMock.writeTx.external_webhook_events.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ processing_result: 'REFUND_FAILED' }),
      }),
    );

    expect(dbMock.writeTx.refunds.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );

    expect(dbMock.writeTx.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refund_status: 'REFUND_FAILED' }),
      }),
    );
  });
});

describe('W3 — Webhook duplicado → procesado una sola vez', () => {
  it('retorna 200 sin re-procesar cuando el evento ya existe', async () => {
    dbMock.prisma.external_webhook_events.findUnique.mockResolvedValue({ id: 300n });
    const rawBody = JSON.stringify(refundWebhookPayload('APPROVED'));

    const res = await postWebhook(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // NO debe crear el evento ni actualizar el refund
    expect(dbMock.writeTx.external_webhook_events.create).not.toHaveBeenCalled();
    expect(dbMock.writeTx.refunds.update).not.toHaveBeenCalled();
    expect(dbMock.writeTx.orders.update).not.toHaveBeenCalled();
  });
});

describe('W4 — Firma HMAC inválida → 400 WEBHOOK_SIGNATURE_INVALID', () => {
  it('rechaza el webhook antes de parsear o persistir', async () => {
    const rawBody = JSON.stringify(refundWebhookPayload('APPROVED'));

    const res = await postWebhook(rawBody, 'a'.repeat(64));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');

    expect(dbMock.prisma.external_webhook_events.findUnique).not.toHaveBeenCalled();
    expect(dbMock.writeTx.external_webhook_events.create).not.toHaveBeenCalled();
    expect(dbMock.writeTx.refunds.update).not.toHaveBeenCalled();
  });
});
