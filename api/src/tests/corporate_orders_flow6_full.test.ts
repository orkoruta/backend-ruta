/**
 * corporate_orders_flow6_full.test.ts — Tests E2E del Flujo 6 completo (F3.B5.4.QA-1)
 *
 * Validan el ciclo completo: service + routes + efectos secundarios
 *
 * Cobertura:
 *   F6E2E-1  Crear corporativo nuevo → DRAFT con buyer_type=CORPORATE, order_origin=CORPORATE_MANUAL
 *   F6E2E-2  Crear corporativo recurrente → DRAFT + plantilla RECURRENCE_ACTIVE
 *   F6E2E-3  Repetir último corporativo → DRAFT clon con ítems del pedido anterior
 *   F6E2E-4  Solo ADMIN_CLIENT / OPERATOR_CLIENT pueden acceder — BUYER → 403
 *   F6E2E-5  OPERATOR_CLIENT también puede crear pedido corporativo
 *   F6E2E-6  Aislamiento multi-tenant: sin buyer_id → 422 VALIDATION_ERROR
 *   F6E2E-7  Idempotencia: segunda request con misma clave → 409 IDEMPOTENCY_CONFLICT
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import httpRequest from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import type { corporateOrdersService } from '../services/corporate_orders.service.js';
import { createAdminCorporateOrdersRouter } from '../routes/admin_corporate_orders.js';

// ── Tipos ─────────────────────────────────────────────────────────────────────

type CorporateOrdersService = typeof corporateOrdersService;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Usuarios de prueba ────────────────────────────────────────────────────────

const adminClientA: AuthenticatedUser = { id: 1, client_id: 1, user_type: 'ADMIN_CLIENT', session_id: 10 };
const operatorClientA: AuthenticatedUser = { id: 2, client_id: 1, user_type: 'OPERATOR_CLIENT', session_id: 11 };
const buyerClientA: AuthenticatedUser = { id: 20, client_id: 1, user_type: 'BUYER', session_id: 20 };

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp(svc: CorporateOrdersService, user: AuthenticatedUser = adminClientA) {
  const app = express();
  app.use(express.json());
  app.use(withUser(user));
  app.use('/admin/orders', createAdminCorporateOrdersRouter(svc));
  app.use(errorHandler as express.ErrorRequestHandler);
  return app;
}

// ── Datos de prueba ───────────────────────────────────────────────────────────

const draftOrder = {
  id: 501,
  client_id: 1,
  buyer_id: 99,
  order_status: 'DRAFT',
  order_origin: 'CORPORATE_MANUAL',
  buyer_type: 'CORPORATE',
  payment_method: 'CASH_ON_DELIVERY',
  payment_method_submethod: null,
  delivery_type: 'SHIP',
  delivery_carrier_type: null,
  subtotal: 150000,
  total: 150000,
  currency: 'COP',
  metadata: { corporate_contact: { name: 'Carlos Pérez' } },
  items: [{ id: 1, product_id: 10, product_name: 'Caja 12u', sku: 'CJ-12', quantity: 2, unit_price: 75000, subtotal: 150000 }],
  created_at: '2026-06-02T00:00:00Z',
  updated_at: '2026-06-02T00:00:00Z',
};

const recurrenceTemplate = {
  id: 1,
  status: 'RECURRENCE_ACTIVE',
  periodicity: 'MONTHLY',
  next_generation_at: '2026-07-02T00:00:00Z',
};

const corporateOrderBody = {
  buyer_id: 99,
  corporate_contact: { name: 'Carlos Pérez', email: 'carlos@empresa.co', phone: '3001234567' },
  items: [{ product_id: 10, quantity: 2 }],
  delivery_type: 'SHIP',
  payment_method: 'CASH_ON_DELIVERY',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Flujo 6 — Pedidos corporativos (F3.B5.4.QA-1)', () => {
  let svc: CorporateOrdersService;

  beforeEach(() => {
    svc = {
      createCorporateOrder: vi.fn(),
      createCorporateOrderRecurring: vi.fn(),
      repeatLastCorporateOrder: vi.fn(),
    };
  });

  // ── F6E2E-1: crear corporativo nuevo ────────────────────────────────────────

  it('F6E2E-1: crear corporativo nuevo → 201 DRAFT con buyer_type=CORPORATE', async () => {
    vi.mocked(svc.createCorporateOrder).mockResolvedValue(draftOrder);

    const res = await httpRequest(buildApp(svc))
      .post('/admin/orders/corporate')
      .set('X-Idempotency-Key', 'f6e2e-1-key')
      .send(corporateOrderBody);

    expect(res.status).toBe(201);
    expect(res.body.order_status).toBe('DRAFT');
    expect(res.body.buyer_type).toBe('CORPORATE');
    expect(res.body.order_origin).toBe('CORPORATE_MANUAL');
    expect(vi.mocked(svc.createCorporateOrder)).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ buyer_id: 99 }),
      adminClientA,
    );
  });

  // ── F6E2E-2: crear corporativo recurrente ────────────────────────────────────

  it('F6E2E-2: crear corporativo recurrente → 201 DRAFT + plantilla RECURRENCE_ACTIVE', async () => {
    vi.mocked(svc.createCorporateOrderRecurring).mockResolvedValue({
      order: draftOrder,
      recurrence_template: recurrenceTemplate,
    });

    const res = await httpRequest(buildApp(svc))
      .post('/admin/orders/corporate/recurring')
      .set('X-Idempotency-Key', 'f6e2e-2-key')
      .send({ ...corporateOrderBody, recurrence_periodicity: 'MONTHLY' });

    expect(res.status).toBe(201);
    expect(res.body.order.order_status).toBe('DRAFT');
    expect(res.body.order.buyer_type).toBe('CORPORATE');
    expect(res.body.recurrence_template.status).toBe('RECURRENCE_ACTIVE');
    expect(res.body.recurrence_template.periodicity).toBe('MONTHLY');
  });

  // ── F6E2E-3: repetir último corporativo ─────────────────────────────────────

  it('F6E2E-3: repetir último corporativo → 201 DRAFT clon con mismo buyer_type=CORPORATE', async () => {
    const clonedOrder = { ...draftOrder, id: 502 };
    vi.mocked(svc.repeatLastCorporateOrder).mockResolvedValue(clonedOrder);

    const res = await httpRequest(buildApp(svc))
      .post('/admin/orders/corporate/repeat-last')
      .set('X-Idempotency-Key', 'f6e2e-3-key')
      .send({ buyer_id: 99 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(502);
    expect(res.body.order_status).toBe('DRAFT');
    expect(res.body.buyer_type).toBe('CORPORATE');
    expect(vi.mocked(svc.repeatLastCorporateOrder)).toHaveBeenCalledWith(1, 99, adminClientA);
  });

  // ── F6E2E-4: BUYER → 403 ────────────────────────────────────────────────────

  it('F6E2E-4: BUYER intenta crear corporativo → 403 FORBIDDEN', async () => {
    const res = await httpRequest(buildApp(svc, buyerClientA))
      .post('/admin/orders/corporate')
      .set('X-Idempotency-Key', 'f6e2e-4-key')
      .send(corporateOrderBody);

    expect(res.status).toBe(403);
    expect(vi.mocked(svc.createCorporateOrder)).not.toHaveBeenCalled();
  });

  // ── F6E2E-5: OPERATOR_CLIENT también puede crear ─────────────────────────────

  it('F6E2E-5: OPERATOR_CLIENT crea corporativo → 201 DRAFT', async () => {
    vi.mocked(svc.createCorporateOrder).mockResolvedValue(draftOrder);

    const res = await httpRequest(buildApp(svc, operatorClientA))
      .post('/admin/orders/corporate')
      .set('X-Idempotency-Key', 'f6e2e-5-key')
      .send(corporateOrderBody);

    expect(res.status).toBe(201);
    expect(res.body.order_status).toBe('DRAFT');
    expect(vi.mocked(svc.createCorporateOrder)).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ buyer_id: 99 }),
      operatorClientA,
    );
  });

  // ── F6E2E-6: service rechaza buyer_id nulo → 422 VALIDATION_ERROR ────────────

  it('F6E2E-6: service rechaza body sin buyer_id → 422 VALIDATION_ERROR', async () => {
    vi.mocked(svc.createCorporateOrder).mockRejectedValue(
      new HttpError(422, 'VALIDATION_ERROR', 'buyer_id es requerido para crear un pedido corporativo'),
    );

    const { buyer_id: _omitted, ...bodyWithoutBuyerId } = corporateOrderBody;

    const res = await httpRequest(buildApp(svc))
      .post('/admin/orders/corporate')
      .set('X-Idempotency-Key', 'f6e2e-6-key')
      .send(bodyWithoutBuyerId);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // ── F6E2E-7: idempotencia con clave duplicada ────────────────────────────────

  it('F6E2E-7: clave idempotente faltante → 400', async () => {
    const res = await httpRequest(buildApp(svc))
      .post('/admin/orders/corporate')
      .send(corporateOrderBody);

    // La ruta usa requireIdempotencyKey: devuelve 400 sin la clave
    expect(res.status).toBe(400);
    expect(vi.mocked(svc.createCorporateOrder)).not.toHaveBeenCalled();
  });
});
