/**
 * wompi_webhook.test.ts - 2.QA-1
 *
 * Tests inbound Wompi webhooks with valid/invalid HMAC signatures and
 * external event deduplication. DB access is mocked at the repository boundary.
 */

import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { PaymentStatus } from '@orkoruta/shared';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';

const dbMock = vi.hoisted(() => {
  const readTx = {
    client_payment_providers: {
      findUnique: vi.fn(),
    },
    orders: {
      findFirst: vi.fn(),
    },
  };

  const writeTx = {
    external_webhook_events: {
      create: vi.fn(),
    },
    orders: {
      update: vi.fn(),
    },
    payments: {
      updateMany: vi.fn(),
    },
  };

  return {
    readTx,
    writeTx,
    prisma: {
      external_webhook_events: {
        findUnique: vi.fn(),
      },
    },
    withTenantReadOnly: vi.fn((_clientId: number, _role: string, callback: (tx: typeof readTx) => unknown) =>
      callback(readTx),
    ),
    withTenant: vi.fn((_clientId: number, _role: string, callback: (tx: typeof writeTx) => unknown) =>
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

const CLIENT_ID = 7;
const PROVIDER_ID = 11n;
const WEBHOOK_SECRET = 'wompi-webhook-secret';
const REFERENCE = 'RUTA-5001-ABCD1234';
const PROVIDER_EVENT_ID = 'txn_test_123';

function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos invalidos'), details: err.flatten() });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.statusCode).json(sendHttpError(err));
    return;
  }
  res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno'));
}

function testApp() {
  const app = express();
  app.use('/webhooks', express.raw({ type: 'application/json' }), createWebhooksRouter());
  app.use(errorHandler as express.ErrorRequestHandler);
  return app;
}

function wompiPayload(overrides: Partial<{ id: string; status: string; reference: string }> = {}) {
  return {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: overrides.id ?? PROVIDER_EVENT_ID,
        status: overrides.status ?? 'APPROVED',
        reference: overrides.reference ?? REFERENCE,
        amount_in_cents: 10500000,
        currency: 'COP',
        payment_method_type: 'CARD',
        customer_email: 'buyer@example.com',
        created_at: '2026-05-28T12:00:00.000Z',
      },
    },
    signature: {
      checksum: 'wompi-native-checksum',
      properties: ['transaction.id', 'transaction.status', 'transaction.reference'],
    },
    environment: 'test',
    timestamp: 1779969600,
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

beforeEach(() => {
  vi.clearAllMocks();

  dbMock.readTx.client_payment_providers.findUnique.mockResolvedValue({
    id: PROVIDER_ID,
    webhook_secret: WEBHOOK_SECRET,
    status: 'ACTIVE',
  });
  dbMock.readTx.orders.findFirst.mockResolvedValue({
    id: 5001n,
    client_id: BigInt(CLIENT_ID),
    payment_status: PaymentStatus.PAYMENT_PROCESSING,
  });
  dbMock.prisma.external_webhook_events.findUnique.mockResolvedValue(null);
  dbMock.writeTx.external_webhook_events.create.mockResolvedValue({ id: 99n });
  dbMock.writeTx.orders.update.mockResolvedValue({});
  dbMock.writeTx.payments.updateMany.mockResolvedValue({ count: 1 });
});

describe('POST /webhooks/wompi/:client_id/:provider_id', () => {
  it('accepts a valid HMAC signature and records the external event once', async () => {
    const rawBody = JSON.stringify(wompiPayload());

    const res = await postWebhook(rawBody).expect(200);

    expect(res.body).toEqual({ received: true });
    expect(dbMock.withTenantReadOnly).toHaveBeenCalledWith(CLIENT_ID, 'ADMIN_RUTA', expect.any(Function));
    expect(dbMock.prisma.external_webhook_events.findUnique).toHaveBeenCalledWith({
      where: {
        payment_provider_id_provider_event_id: {
          payment_provider_id: PROVIDER_ID,
          provider_event_id: PROVIDER_EVENT_ID,
        },
      },
      select: { id: true },
    });
    expect(dbMock.writeTx.external_webhook_events.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        client_id: BigInt(CLIENT_ID),
        payment_provider_id: PROVIDER_ID,
        provider_event_id: PROVIDER_EVENT_ID,
        signature_valid: true,
        processing_result: PaymentStatus.PAID,
        related_order_id: 5001n,
      }),
    });
    expect(dbMock.writeTx.orders.update).toHaveBeenCalledWith({
      where: { id_client_id: { id: 5001n, client_id: BigInt(CLIENT_ID) } },
      data: { payment_status: PaymentStatus.PAID },
    });
    expect(dbMock.writeTx.payments.updateMany).toHaveBeenCalledWith({
      where: {
        client_id: BigInt(CLIENT_ID),
        order_id: 5001n,
        status: 'PENDING',
        external_payment_reference: REFERENCE,
      },
      data: expect.objectContaining({
        status: 'CONFIRMED',
        external_transaction_id: PROVIDER_EVENT_ID,
      }),
    });
  });

  it('rejects an invalid HMAC signature before parsing or persisting the payload', async () => {
    const rawBody = JSON.stringify(wompiPayload());

    const res = await postWebhook(rawBody, 'a'.repeat(64)).expect(400);

    expect(res.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(dbMock.prisma.external_webhook_events.findUnique).not.toHaveBeenCalled();
    expect(dbMock.writeTx.external_webhook_events.create).not.toHaveBeenCalled();
    expect(dbMock.writeTx.orders.update).not.toHaveBeenCalled();
    expect(dbMock.writeTx.payments.updateMany).not.toHaveBeenCalled();
  });

  it('deduplicates an already processed external event by provider_event_id', async () => {
    dbMock.prisma.external_webhook_events.findUnique.mockResolvedValue({ id: 123n });
    const rawBody = JSON.stringify(wompiPayload());

    const res = await postWebhook(rawBody).expect(200);

    expect(res.body).toEqual({ received: true });
    expect(dbMock.prisma.external_webhook_events.findUnique).toHaveBeenCalledWith({
      where: {
        payment_provider_id_provider_event_id: {
          payment_provider_id: PROVIDER_ID,
          provider_event_id: PROVIDER_EVENT_ID,
        },
      },
      select: { id: true },
    });
    expect(dbMock.writeTx.external_webhook_events.create).not.toHaveBeenCalled();
    expect(dbMock.writeTx.orders.update).not.toHaveBeenCalled();
    expect(dbMock.writeTx.payments.updateMany).not.toHaveBeenCalled();
  });

  it('maps declined Wompi transactions to retryable payment failures', async () => {
    const rawBody = JSON.stringify(wompiPayload({ id: 'txn_declined_1', status: 'DECLINED' }));

    await postWebhook(rawBody).expect(200);

    expect(dbMock.writeTx.external_webhook_events.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider_event_id: 'txn_declined_1',
        processing_result: PaymentStatus.PAYMENT_FAILED_RETRYABLE,
      }),
    });
    expect(dbMock.writeTx.orders.update).toHaveBeenCalledWith({
      where: { id_client_id: { id: 5001n, client_id: BigInt(CLIENT_ID) } },
      data: { payment_status: PaymentStatus.PAYMENT_FAILED_RETRYABLE },
    });
    expect(dbMock.writeTx.payments.updateMany).not.toHaveBeenCalled();
  });
});
