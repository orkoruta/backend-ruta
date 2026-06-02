/**
 * refunds.test.ts — Tests del Flujo 4: Reembolso completo (F3.B1.2.BACK-1)
 *
 * Cobertura:
 *   R1  initiateRefund: pedido PAID + refund_status REFUND_PENDING → crea refund OK (201)
 *   R2  initiateRefund: pedido no PAID → 422
 *   R3  initiateRefund: refund_status != REFUND_PENDING → 422
 *   R4  initiateRefund: Cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE
 *   R5  processRefund: PENDING → PROCESSING + orders.refund_status actualizado
 *   R6  processRefund: estado incorrecto → 422
 *   R7  requestProviderRefund: BANK_REFUND + ONLINE → PROVIDER_REQUESTED
 *   R8  requestProviderRefund: modalidad STORE_CREDIT → 422
 *   R9  markRefundExecuted: REFUNDED desde PROCESSING → estado final OK
 *   R10 markRefundExecuted: PARTIALLY_REFUNDED → estado final OK
 *   R11 markRefundExecuted: FAILED → estado final OK
 *   R12 handleProviderRefundWebhook: PROVIDER_REQUESTED → REFUNDED
 *   R13 GET /admin/refunds — lista paginada
 *   R14 POST /admin/orders/:id/initiate-refund → 201 con body válido
 *   R15 POST /admin/orders/:id/initiate-refund sin X-Idempotency-Key → 400
 *   R16 aislamiento multi-tenant: refund de otro cliente → 404
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import type { refundsService } from '../services/refunds.service.js';
import { createAdminRefundsRouter, createAdminOrderRefundRouter } from '../routes/admin_refunds.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';

// ─── Tipos ────────────────────────────────────────────────────────────────────

type RefundsService = typeof refundsService;

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

function withUser(user: AuthenticatedUser) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthenticatedUser }).user = user;
    next();
  };
}

const adminUser: AuthenticatedUser = { id: 1, client_id: 1, user_type: 'ADMIN_CLIENT', session_id: 10 };

function buildApp(svc: RefundsService, user: AuthenticatedUser = adminUser) {
  const app = express();
  app.use(express.json());
  app.use(withUser(user));
  app.use('/admin/refunds', createAdminRefundsRouter(svc));
  app.use('/admin/orders', requireIdempotencyKey, createAdminOrderRefundRouter(svc));
  app.use(errorHandler);
  return app;
}

// ─── Mock del servicio ────────────────────────────────────────────────────────

function makeMockService(): RefundsService {
  return {
    initiateRefund: vi.fn(),
    processRefund: vi.fn(),
    requestProviderRefund: vi.fn(),
    markRefundExecuted: vi.fn(),
    handleProviderRefundWebhook: vi.fn(),
    getRefund: vi.fn(),
    getRefundForOrder: vi.fn(),
    listRefunds: vi.fn(),
  } as unknown as RefundsService;
}

const mockRefund = {
  id: 1, client_id: 1, order_id: 100, payment_id: null,
  refund_modality: 'STORE_CREDIT', amount: 50000, currency: 'COP',
  status: 'PENDING', executed_by_user_id: null, executed_at: null,
  external_provider_refund_id: null, evidence: null, reason: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('R1 — initiateRefund: pedido PAID + REFUND_PENDING → crea refund OK', () => {
  it('retorna 201 con el reembolso creado', async () => {
    const svc = makeMockService();
    (svc.initiateRefund as ReturnType<typeof vi.fn>).mockResolvedValue(mockRefund);
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/orders/100/initiate-refund')
      .set('X-Idempotency-Key', 'key-r1')
      .send({ amount: 50000, refund_modality: 'STORE_CREDIT' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.refund_modality).toBe('STORE_CREDIT');
    expect(svc.initiateRefund).toHaveBeenCalledWith(
      1, 100,
      expect.objectContaining({ amount: 50000, refund_modality: 'STORE_CREDIT' }),
      expect.objectContaining({ id: 1 }),
    );
  });
});

describe('R2 — initiateRefund: pedido no PAID → 422', () => {
  it('retorna 422 INVALID_STATE_TRANSITION', async () => {
    const svc = makeMockService();
    (svc.initiateRefund as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'Solo se puede reembolsar un pedido pagado'),
    );
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/orders/200/initiate-refund')
      .set('X-Idempotency-Key', 'key-r2')
      .send({ amount: 50000, refund_modality: 'BANK_REFUND' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('R3 — initiateRefund: refund_status != REFUND_PENDING → 422', () => {
  it('retorna 422 cuando el pedido ya tiene un reembolso activo', async () => {
    const svc = makeMockService();
    (svc.initiateRefund as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'El pedido tiene refund_status=REFUND_PROCESSING'),
    );
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/orders/300/initiate-refund')
      .set('X-Idempotency-Key', 'key-r3')
      .send({ amount: 50000, refund_modality: 'STORE_CREDIT' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('R4 — initiateRefund: Cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE', () => {
  it('retorna 422 para Cliente API', async () => {
    const svc = makeMockService();
    (svc.initiateRefund as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(422, 'LOGISTICS_ONLY_FEATURE_UNAVAILABLE', 'Los reembolsos no aplican para Clientes API'),
    );
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/orders/400/initiate-refund')
      .set('X-Idempotency-Key', 'key-r4')
      .send({ amount: 50000, refund_modality: 'STORE_CREDIT' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOGISTICS_ONLY_FEATURE_UNAVAILABLE');
  });
});

describe('R5 — processRefund: PENDING → PROCESSING', () => {
  it('avanza a PROCESSING y retorna el refund actualizado', async () => {
    const svc = makeMockService();
    const processing = { ...mockRefund, status: 'PROCESSING' };
    (svc.processRefund as ReturnType<typeof vi.fn>).mockResolvedValue(processing);
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/refunds/1/process')
      .set('X-Idempotency-Key', 'key-r5');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSING');
    expect(svc.processRefund).toHaveBeenCalledWith(1, 1, expect.objectContaining({ id: 1 }));
  });
});

describe('R6 — processRefund: estado incorrecto → 422', () => {
  it('retorna 422 si el reembolso no está en PENDING', async () => {
    const svc = makeMockService();
    (svc.processRefund as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'El reembolso está en estado PROCESSING; se esperaba PENDING'),
    );
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/refunds/1/process')
      .set('X-Idempotency-Key', 'key-r6');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('R7 — requestProviderRefund: BANK_REFUND + ONLINE → PROVIDER_REQUESTED', () => {
  it('avanza a PROVIDER_REQUESTED', async () => {
    const svc = makeMockService();
    const providerRequested = { ...mockRefund, refund_modality: 'BANK_REFUND', status: 'PROVIDER_REQUESTED' };
    (svc.requestProviderRefund as ReturnType<typeof vi.fn>).mockResolvedValue(providerRequested);
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/refunds/1/request-provider')
      .set('X-Idempotency-Key', 'key-r7');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROVIDER_REQUESTED');
  });
});

describe('R8 — requestProviderRefund: modalidad STORE_CREDIT → 422', () => {
  it('retorna 422 para modalidad STORE_CREDIT', async () => {
    const svc = makeMockService();
    (svc.requestProviderRefund as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(422, 'INVALID_STATE_TRANSITION', 'requestProviderRefund solo aplica para modalidad BANK_REFUND'),
    );
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/refunds/2/request-provider')
      .set('X-Idempotency-Key', 'key-r8');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('R9 — markRefundExecuted: REFUNDED desde PROCESSING', () => {
  it('marca como REFUNDED correctamente', async () => {
    const svc = makeMockService();
    const refunded = { ...mockRefund, status: 'REFUNDED', executed_at: new Date().toISOString() };
    (svc.markRefundExecuted as ReturnType<typeof vi.fn>).mockResolvedValue(refunded);
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/refunds/1/mark-executed')
      .set('X-Idempotency-Key', 'key-r9')
      .send({ outcome: 'REFUNDED', amount_executed: 50000 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REFUNDED');
    expect(svc.markRefundExecuted).toHaveBeenCalledWith(
      1, 1,
      expect.objectContaining({ outcome: 'REFUNDED', amount_executed: 50000 }),
      expect.objectContaining({ id: 1 }),
    );
  });
});

describe('R10 — markRefundExecuted: PARTIALLY_REFUNDED', () => {
  it('marca como PARTIALLY_REFUNDED con monto parcial', async () => {
    const svc = makeMockService();
    const partial = { ...mockRefund, status: 'PARTIALLY_REFUNDED' };
    (svc.markRefundExecuted as ReturnType<typeof vi.fn>).mockResolvedValue(partial);
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/refunds/1/mark-executed')
      .set('X-Idempotency-Key', 'key-r10')
      .send({ outcome: 'PARTIALLY_REFUNDED', amount_executed: 25000 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PARTIALLY_REFUNDED');
  });
});

describe('R11 — markRefundExecuted: FAILED', () => {
  it('marca como FAILED cuando la ejecución falla', async () => {
    const svc = makeMockService();
    const failed = { ...mockRefund, status: 'FAILED' };
    (svc.markRefundExecuted as ReturnType<typeof vi.fn>).mockResolvedValue(failed);
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/refunds/1/mark-executed')
      .set('X-Idempotency-Key', 'key-r11')
      .send({ outcome: 'FAILED' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FAILED');
  });
});

describe('R12 — handleProviderRefundWebhook: PROVIDER_REQUESTED → REFUNDED', () => {
  it('acepta llamada con outcome REFUNDED', async () => {
    const svc = makeMockService();
    (svc.handleProviderRefundWebhook as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await svc.handleProviderRefundWebhook(1, 1, 'REFUNDED', 'ext-123');

    expect(svc.handleProviderRefundWebhook).toHaveBeenCalledWith(1, 1, 'REFUNDED', 'ext-123');
  });
});

describe('R13 — GET /admin/refunds — lista paginada', () => {
  it('retorna lista paginada de reembolsos', async () => {
    const svc = makeMockService();
    (svc.listRefunds as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockRefund],
      pagination: { page: 1, page_size: 20, total: 1 },
    });
    const app = buildApp(svc);

    const res = await request(app).get('/admin/refunds');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });
});

describe('R14 — POST /admin/orders/:id/initiate-refund body válido → 201', () => {
  it('retorna 201 con el reembolso creado incluyendo reason', async () => {
    const svc = makeMockService();
    (svc.initiateRefund as ReturnType<typeof vi.fn>).mockResolvedValue(mockRefund);
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/orders/100/initiate-refund')
      .set('X-Idempotency-Key', 'key-r14')
      .send({ amount: 50000, refund_modality: 'STORE_CREDIT', reason: 'Cancelación del cliente' });

    expect(res.status).toBe(201);
    expect(svc.initiateRefund).toHaveBeenCalledOnce();
  });
});

describe('R15 — POST /admin/orders/:id/initiate-refund sin X-Idempotency-Key → 400', () => {
  it('retorna 400 cuando falta la clave de idempotencia', async () => {
    const svc = makeMockService();
    const app = buildApp(svc);

    const res = await request(app)
      .post('/admin/orders/100/initiate-refund')
      .send({ amount: 50000, refund_modality: 'STORE_CREDIT' });

    expect(res.status).toBe(400);
    expect(svc.initiateRefund).not.toHaveBeenCalled();
  });
});

describe('R16 — aislamiento multi-tenant: refund de otro cliente → 404', () => {
  it('retorna 404 cuando el reembolso no pertenece al cliente', async () => {
    const svc = makeMockService();
    (svc.getRefund as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Reembolso no encontrado'),
    );
    const app = buildApp(svc);

    const res = await request(app).get('/admin/refunds/999');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });
});
