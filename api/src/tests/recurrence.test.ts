/**
 * recurrence.test.ts — Tests del Flujo 5: Recurrencia de pedidos (F3.B4.2.BACK-1)
 *
 * Cobertura:
 *   RC1  markOrderAsRecurring: WEEKLY → next_generation_at = +7 días
 *   RC2  markOrderAsRecurring: MONTHLY → next_generation_at = +30 días
 *   RC3  pauseRecurrence: RECURRENCE_ACTIVE → RECURRENCE_PAUSED
 *   RC4  resumeRecurrence: RECURRENCE_PAUSED → RECURRENCE_ACTIVE + next_generation_at recalculado
 *   RC5  cancelRecurrence: * → RECURRENCE_CANCELLED
 *   RC6  repeatLastOrder → DRAFT creado con mismos ítems
 *   RC7  aislamiento multi-tenant: comprador A no puede gestionar plantilla de B (403/404)
 *   RC8  getTemplate con ID inexistente → 404
 *   RC9  admin puede pausar plantilla sin ser el comprador
 *   RC10 CUSTOM_INTERVAL con custom_interval_days=10 → next_generation_at = NOW + 10 días
 *   RC11 markOrderAsRecurring: pedido ya tiene plantilla → 409 IDEMPOTENCY_CONFLICT
 *   RC12 listBuyerTemplates: retorna lista paginada para el comprador
 *   RC13 admin cancel: lanza auditoría + retorna CANCELLED
 *   RC14 updateTemplate: actualiza periodicidad y recalcula next_generation_at
 *   RC15 listTemplates (admin): lista todas las plantillas del cliente
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import type { recurrenceService } from '../services/recurrence.service.js';
import { createBuyerRecurrenceRouter, createBuyerOrderRecurrenceRouter } from '../routes/buyer_recurrence.js';
import { createAdminRecurrenceRouter } from '../routes/admin_recurrence.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';

// ─── Tipos ────────────────────────────────────────────────────────────────────

type RecurrenceService = typeof recurrenceService;

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

const buyerUser: AuthenticatedUser = { id: 10, client_id: 1, user_type: 'BUYER', session_id: 100 };
const buyerUser2: AuthenticatedUser = { id: 20, client_id: 1, user_type: 'BUYER', session_id: 200 };
const adminUser: AuthenticatedUser = { id: 1, client_id: 1, user_type: 'ADMIN_CLIENT', session_id: 101 };

function buildBuyerApp(svc: RecurrenceService, user: AuthenticatedUser = buyerUser) {
  const app = express();
  app.use(express.json());
  app.use(withUser(user));
  app.use('/buyer/recurrence', createBuyerRecurrenceRouter(svc));
  app.use('/buyer/orders', requireIdempotencyKey, createBuyerOrderRecurrenceRouter(svc));
  app.use(errorHandler);
  return app;
}

function buildAdminApp(svc: RecurrenceService, user: AuthenticatedUser = adminUser) {
  const app = express();
  app.use(express.json());
  app.use(withUser(user));
  app.use('/admin/recurrence', createAdminRecurrenceRouter(svc));
  app.use(errorHandler);
  return app;
}

// ─── Mock del servicio ────────────────────────────────────────────────────────

function makeMockService(): RecurrenceService {
  return {
    markOrderAsRecurring: vi.fn(),
    repeatLastOrder: vi.fn(),
    pauseRecurrence: vi.fn(),
    resumeRecurrence: vi.fn(),
    cancelRecurrence: vi.fn(),
    updateTemplate: vi.fn(),
    pauseRecurrenceAsAdmin: vi.fn(),
    cancelRecurrenceAsAdmin: vi.fn(),
    getTemplate: vi.fn(),
    listTemplates: vi.fn(),
    listBuyerTemplates: vi.fn(),
  } as unknown as RecurrenceService;
}

// ─── Datos de prueba ──────────────────────────────────────────────────────────

const now = new Date();
const plus7 = new Date(now);
plus7.setDate(plus7.getDate() + 7);

const plus30 = new Date(now);
plus30.setDate(plus30.getDate() + 30);

const plus10 = new Date(now);
plus10.setDate(plus10.getDate() + 10);

const mockTemplate = {
  id: 1,
  client_id: 1,
  buyer_id: 10,
  recurrence_mode: 'SCHEDULED_RECURRING',
  recurrence_status: 'RECURRENCE_ACTIVE',
  recurrence_periodicity: 'WEEKLY',
  custom_interval_days: null,
  template_payload: { order_id: 100 },
  delivery_type: 'SHIP',
  delivery_carrier_type: null,
  payment_method: 'CASH_ON_DELIVERY',
  payment_method_submethod: null,
  next_generation_at: plus7.toISOString(),
  last_generated_at: null,
  created_at: now.toISOString(),
  updated_at: now.toISOString(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RC1 — markOrderAsRecurring: WEEKLY → next_generation_at = +7 días', () => {
  it('crea la plantilla con status RECURRENCE_ACTIVE y next_generation_at en +7 días', async () => {
    const svc = makeMockService();
    (svc.markOrderAsRecurring as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockTemplate,
      recurrence_periodicity: 'WEEKLY',
      next_generation_at: plus7.toISOString(),
    });
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/orders/100/mark-recurring')
      .set('X-Idempotency-Key', 'key-rc1')
      .send({ recurrence_periodicity: 'WEEKLY' });

    expect(res.status).toBe(201);
    expect(res.body.recurrence_status).toBe('RECURRENCE_ACTIVE');
    expect(res.body.recurrence_periodicity).toBe('WEEKLY');
    expect(svc.markOrderAsRecurring).toHaveBeenCalledWith(
      1, 100, 10,
      expect.objectContaining({ recurrence_periodicity: 'WEEKLY' }),
    );

    // Verificar que next_generation_at está ~7 días en el futuro
    const nextDate = new Date(res.body.next_generation_at);
    const diffDays = Math.round((nextDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(7);
  });
});

describe('RC2 — markOrderAsRecurring: MONTHLY → next_generation_at = +30 días', () => {
  it('crea la plantilla con next_generation_at en +30 días', async () => {
    const svc = makeMockService();
    (svc.markOrderAsRecurring as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockTemplate,
      recurrence_periodicity: 'MONTHLY',
      next_generation_at: plus30.toISOString(),
    });
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/orders/101/mark-recurring')
      .set('X-Idempotency-Key', 'key-rc2')
      .send({ recurrence_periodicity: 'MONTHLY' });

    expect(res.status).toBe(201);
    expect(res.body.recurrence_periodicity).toBe('MONTHLY');

    const nextDate = new Date(res.body.next_generation_at);
    const diffDays = Math.round((nextDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(30);
  });
});

describe('RC3 — pauseRecurrence: RECURRENCE_ACTIVE → RECURRENCE_PAUSED', () => {
  it('pausa una plantilla activa y retorna RECURRENCE_PAUSED', async () => {
    const svc = makeMockService();
    const paused = { ...mockTemplate, recurrence_status: 'RECURRENCE_PAUSED' };
    (svc.pauseRecurrence as ReturnType<typeof vi.fn>).mockResolvedValue(paused);
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/recurrence/1/pause')
      .set('X-Idempotency-Key', 'key-rc3');

    expect(res.status).toBe(200);
    expect(res.body.recurrence_status).toBe('RECURRENCE_PAUSED');
    expect(svc.pauseRecurrence).toHaveBeenCalledWith(1, 1, 10);
  });
});

describe('RC4 — resumeRecurrence: RECURRENCE_PAUSED → RECURRENCE_ACTIVE + next_generation_at recalculado', () => {
  it('reanuda la plantilla y recalcula next_generation_at', async () => {
    const svc = makeMockService();
    const newNext = new Date();
    newNext.setDate(newNext.getDate() + 7);
    const resumed = {
      ...mockTemplate,
      recurrence_status: 'RECURRENCE_ACTIVE',
      next_generation_at: newNext.toISOString(),
    };
    (svc.resumeRecurrence as ReturnType<typeof vi.fn>).mockResolvedValue(resumed);
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/recurrence/1/resume')
      .set('X-Idempotency-Key', 'key-rc4');

    expect(res.status).toBe(200);
    expect(res.body.recurrence_status).toBe('RECURRENCE_ACTIVE');
    expect(res.body.next_generation_at).toBeDefined();
    expect(svc.resumeRecurrence).toHaveBeenCalledWith(1, 1, 10);
  });
});

describe('RC5 — cancelRecurrence: * → RECURRENCE_CANCELLED', () => {
  it('cancela la plantilla y retorna RECURRENCE_CANCELLED', async () => {
    const svc = makeMockService();
    const cancelled = { ...mockTemplate, recurrence_status: 'RECURRENCE_CANCELLED' };
    (svc.cancelRecurrence as ReturnType<typeof vi.fn>).mockResolvedValue(cancelled);
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .delete('/buyer/recurrence/1')
      .set('X-Idempotency-Key', 'key-rc5');

    expect(res.status).toBe(200);
    expect(res.body.recurrence_status).toBe('RECURRENCE_CANCELLED');
    expect(svc.cancelRecurrence).toHaveBeenCalledWith(1, 1, 10);
  });
});

describe('RC6 — repeatLastOrder: crea DRAFT con mismos ítems', () => {
  it('retorna 201 con un pedido DRAFT', async () => {
    const svc = makeMockService();
    const draftOrder = {
      id: 999,
      client_id: 1,
      buyer_id: 10,
      order_status: 'DRAFT',
      order_origin: 'RECURRENCE',
      payment_method: 'CASH_ON_DELIVERY',
      delivery_type: 'SHIP',
      subtotal: 50000,
      total: 50000,
      created_at: now.toISOString(),
    };
    (svc.repeatLastOrder as ReturnType<typeof vi.fn>).mockResolvedValue(draftOrder);
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/recurrence/repeat-last')
      .set('X-Idempotency-Key', 'key-rc6');

    expect(res.status).toBe(201);
    expect(res.body.order_status).toBe('DRAFT');
    expect(res.body.order_origin).toBe('RECURRENCE');
    expect(svc.repeatLastOrder).toHaveBeenCalledWith(1, 10);
  });
});

describe('RC7 — aislamiento multi-tenant: comprador B no puede gestionar plantilla del comprador A', () => {
  it('retorna 404 cuando el comprador B intenta pausar la plantilla del comprador A', async () => {
    const svc = makeMockService();
    (svc.pauseRecurrence as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Plantilla de recurrencia no encontrada'),
    );
    // Comprador B (id: 20) intenta gestionar plantilla que pertenece al comprador A (id: 10)
    const app = buildBuyerApp(svc, buyerUser2);

    const res = await request(app)
      .post('/buyer/recurrence/1/pause')
      .set('X-Idempotency-Key', 'key-rc7');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
    // Verificar que se llamó con el buyerId del comprador B (20), no del A (10)
    expect(svc.pauseRecurrence).toHaveBeenCalledWith(1, 1, 20);
  });
});

describe('RC8 — getTemplate con ID inexistente → 404', () => {
  it('retorna 404 para un template inexistente', async () => {
    const svc = makeMockService();
    (svc.getTemplate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Plantilla de recurrencia no encontrada'),
    );
    const app = buildAdminApp(svc);

    const res = await request(app).get('/admin/recurrence/999999');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('RC9 — admin puede pausar plantilla sin ser el comprador', () => {
  it('admin pausa la plantilla usando pauseRecurrenceAsAdmin', async () => {
    const svc = makeMockService();
    const paused = { ...mockTemplate, recurrence_status: 'RECURRENCE_PAUSED' };
    (svc.pauseRecurrenceAsAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(paused);
    const app = buildAdminApp(svc);

    const res = await request(app)
      .post('/admin/recurrence/1/pause')
      .set('X-Idempotency-Key', 'key-rc9');

    expect(res.status).toBe(200);
    expect(res.body.recurrence_status).toBe('RECURRENCE_PAUSED');
    expect(svc.pauseRecurrenceAsAdmin).toHaveBeenCalledWith(
      1, 1, expect.objectContaining({ id: 1, user_type: 'ADMIN_CLIENT' }),
    );
  });
});

describe('RC10 — CUSTOM_INTERVAL con custom_interval_days=10 → next_generation_at = NOW + 10 días', () => {
  it('crea plantilla con next_generation_at en +10 días para CUSTOM_INTERVAL', async () => {
    const svc = makeMockService();
    (svc.markOrderAsRecurring as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockTemplate,
      recurrence_periodicity: 'CUSTOM_INTERVAL',
      custom_interval_days: 10,
      next_generation_at: plus10.toISOString(),
    });
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/orders/102/mark-recurring')
      .set('X-Idempotency-Key', 'key-rc10')
      .send({ recurrence_periodicity: 'CUSTOM_INTERVAL', custom_interval_days: 10 });

    expect(res.status).toBe(201);
    expect(res.body.recurrence_periodicity).toBe('CUSTOM_INTERVAL');
    expect(res.body.custom_interval_days).toBe(10);

    const nextDate = new Date(res.body.next_generation_at);
    const diffDays = Math.round((nextDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(10);
  });
});

describe('RC11 — markOrderAsRecurring: pedido ya tiene plantilla → 409', () => {
  it('retorna 409 IDEMPOTENCY_CONFLICT cuando el pedido ya tiene plantilla', async () => {
    const svc = makeMockService();
    (svc.markOrderAsRecurring as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'El pedido ya está asociado a una plantilla de recurrencia'),
    );
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/orders/100/mark-recurring')
      .set('X-Idempotency-Key', 'key-rc11')
      .send({ recurrence_periodicity: 'WEEKLY' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('RC12 — listBuyerTemplates: retorna lista paginada para el comprador', () => {
  it('retorna las plantillas del comprador autenticado', async () => {
    const svc = makeMockService();
    (svc.listBuyerTemplates as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockTemplate],
      pagination: { page: 1, page_size: 20, total: 1 },
    });
    const app = buildBuyerApp(svc);

    const res = await request(app).get('/buyer/recurrence');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(svc.listBuyerTemplates).toHaveBeenCalledWith(1, 10, expect.objectContaining({ page: 1 }));
  });
});

describe('RC13 — admin cancel: retorna RECURRENCE_CANCELLED', () => {
  it('admin cancela la plantilla usando cancelRecurrenceAsAdmin', async () => {
    const svc = makeMockService();
    const cancelled = { ...mockTemplate, recurrence_status: 'RECURRENCE_CANCELLED' };
    (svc.cancelRecurrenceAsAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(cancelled);
    const app = buildAdminApp(svc);

    const res = await request(app)
      .post('/admin/recurrence/1/cancel')
      .set('X-Idempotency-Key', 'key-rc13');

    expect(res.status).toBe(200);
    expect(res.body.recurrence_status).toBe('RECURRENCE_CANCELLED');
    expect(svc.cancelRecurrenceAsAdmin).toHaveBeenCalledWith(
      1, 1, expect.objectContaining({ id: 1, user_type: 'ADMIN_CLIENT' }),
    );
  });
});

describe('RC14 — updateTemplate: actualiza periodicidad', () => {
  it('actualiza la periodicidad y retorna la plantilla actualizada', async () => {
    const svc = makeMockService();
    const updated = { ...mockTemplate, recurrence_periodicity: 'MONTHLY', next_generation_at: plus30.toISOString() };
    (svc.updateTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .patch('/buyer/recurrence/1')
      .set('X-Idempotency-Key', 'key-rc14')
      .send({ recurrence_periodicity: 'MONTHLY' });

    expect(res.status).toBe(200);
    expect(res.body.recurrence_periodicity).toBe('MONTHLY');
    expect(svc.updateTemplate).toHaveBeenCalledWith(
      1, 1, 10,
      expect.objectContaining({ recurrence_periodicity: 'MONTHLY' }),
    );
  });
});

describe('RC15 — listTemplates admin: lista todas las plantillas del cliente', () => {
  it('retorna todas las plantillas del cliente con paginación', async () => {
    const svc = makeMockService();
    (svc.listTemplates as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockTemplate, { ...mockTemplate, id: 2, buyer_id: 20 }],
      pagination: { page: 1, page_size: 20, total: 2 },
    });
    const app = buildAdminApp(svc);

    const res = await request(app).get('/admin/recurrence');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(2);
    expect(svc.listTemplates).toHaveBeenCalledWith(1, expect.objectContaining({ page: 1 }));
  });
});
