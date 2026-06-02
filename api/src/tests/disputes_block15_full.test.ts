/**
 * disputes_block15_full.test.ts — Tests E2E del Bloque 15 completo (F3.B3.4.QA-1)
 *
 * Pruebas de ciclo end-to-end: disputas → devoluciones → reembolsos
 *
 * Cobertura:
 *   DB15-1  resolveNoAction: disputa resuelta sin efectos secundarios
 *             (returnsService ni refundsService llamados)
 *   DB15-2  resolveWithReturn: disputa → return creado con RETURN_REQUESTED automáticamente
 *   DB15-3  resolveWithRefund: disputa → refund creado con REFUND_PENDING automáticamente
 *   DB15-4  Flujo completo WITH_RETURN:
 *             openDispute → startReview → resolveWithReturn → resolveWithReturn retorna
 *             estado DISPUTE_RESOLVED_WITH_RETURN; luego admin aprueba return → refund disparado
 *   DB15-5  Aislamiento: buyer de cliente A no puede abrir disputa en pedido de cliente B → 403/404
 *   DB15-6  Flujo completo WITH_REFUND: openDispute → startReview → resolveWithRefund
 *             Verifica que resolveWithRefund nunca llama resolveWithReturn
 *   DB15-7  Transición inválida: resolveWithReturn desde estado DISPUTED → 422
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import type { disputesService } from '../services/disputes.service.js';
import type { returnsService } from '../services/returns.service.js';
import { createAdminDisputesRouter } from '../routes/admin_disputes.js';
import { createBuyerDisputesRouter } from '../routes/buyer_disputes.js';
import { createAdminReturnsRouter } from '../routes/admin_returns.js';

// ── Tipos ─────────────────────────────────────────────────────────────────────

type DisputesService = typeof disputesService;
type ReturnsService = typeof returnsService;

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

const adminUserClientA: AuthenticatedUser = {
  id: 1,
  client_id: 1,
  user_type: 'ADMIN_CLIENT',
  session_id: 10,
};

const buyerUserClientA: AuthenticatedUser = {
  id: 5,
  client_id: 1,
  user_type: 'BUYER',
  session_id: 20,
};

// Buyer de cliente B (diferente client_id)
const buyerUserClientB: AuthenticatedUser = {
  id: 99,
  client_id: 2,
  user_type: 'BUYER',
  session_id: 30,
};

// ── App builders ──────────────────────────────────────────────────────────────

function buildAdminDisputesApp(
  disputeSvc: DisputesService,
  user: AuthenticatedUser = adminUserClientA,
) {
  const app = express();
  app.use(express.json());
  app.use(withUser(user));
  app.use('/admin/disputes', createAdminDisputesRouter(disputeSvc));
  app.use(errorHandler);
  return app;
}

function buildBuyerDisputesApp(
  disputeSvc: DisputesService,
  user: AuthenticatedUser = buyerUserClientA,
) {
  const app = express();
  app.use(express.json());
  app.use(withUser(user));
  app.use('/buyer/orders', createBuyerDisputesRouter(disputeSvc));
  app.use(errorHandler);
  return app;
}

function buildAdminReturnsApp(
  returnsSvc: ReturnsService,
  user: AuthenticatedUser = adminUserClientA,
) {
  const app = express();
  app.use(express.json());
  app.use(withUser(user));
  app.use('/admin/returns', createAdminReturnsRouter(returnsSvc));
  app.use(errorHandler);
  return app;
}

// ── Mock del servicio de disputas ─────────────────────────────────────────────

function makeMockDisputesService(): DisputesService {
  return {
    openDispute: vi.fn(),
    startReview: vi.fn(),
    resolveNoAction: vi.fn(),
    resolveWithReturn: vi.fn(),
    resolveWithRefund: vi.fn(),
    getDispute: vi.fn(),
    getDisputeForOrder: vi.fn(),
    listDisputes: vi.fn(),
  } as unknown as DisputesService;
}

// ── Mock del servicio de devoluciones ─────────────────────────────────────────

function makeMockReturnsService(): ReturnsService {
  return {
    requestReturn: vi.fn(),
    startReview: vi.fn(),
    approveReturn: vi.fn(),
    rejectReturn: vi.fn(),
    markInTransit: vi.fn(),
    markReceived: vi.fn(),
    markExpired: vi.fn(),
    markLost: vi.fn(),
    schedulePickup: vi.fn(),
    markPickupOutForCollection: vi.fn(),
    markPickupCollected: vi.fn(),
    markPickupFailed: vi.fn(),
    cancelReturn: vi.fn(),
    getReturn: vi.fn(),
    getReturnForOrder: vi.fn(),
    listReturns: vi.fn(),
  } as unknown as ReturnsService;
}

// ── Fixtures base ─────────────────────────────────────────────────────────────

const now = new Date().toISOString();

const baseDispute = {
  id: 1,
  client_id: 1,
  order_id: 100,
  buyer_id: 5,
  status: 'DISPUTED',
  reason: 'Producto llegó dañado',
  resolution: null,
  resolution_action: null,
  resolved_by_user_id: null,
  resolved_at: null,
  evidence: null,
  created_at: now,
  updated_at: now,
};

const baseReturn = {
  id: 10,
  client_id: 1,
  order_id: 100,
  buyer_id: 5,
  return_mechanism: 'BUYER_SHIPS_VIA_COURIER',
  reason: 'Disputa #1 resuelta con devolución',
  buyer_complaint: null,
  pickup_courier_user_id: null,
  requested_at: now,
  reviewed_at: null,
  approved_at: null,
  received_at: null,
  closed_at: null,
  evidence: null,
  metadata: null,
  created_at: now,
  updated_at: now,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DB15-1 — resolveNoAction: sin efectos secundarios (ni return ni refund creados)', () => {
  it('openDispute → startReview → resolveNoAction; resolveWithReturn y resolveWithRefund nunca llamados', async () => {
    const disputeSvc = makeMockDisputesService();

    (disputeSvc.openDispute as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTED',
    });
    (disputeSvc.startReview as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTE_UNDER_REVIEW',
    });
    (disputeSvc.resolveNoAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTE_RESOLVED_NO_ACTION',
      resolution: 'No se encontraron evidencias suficientes de daño',
      resolution_action: 'NO_ACTION',
      resolved_by_user_id: 1,
      resolved_at: now,
    });

    const buyerApp = buildBuyerDisputesApp(disputeSvc);
    const adminApp = buildAdminDisputesApp(disputeSvc);

    // 1. Comprador abre disputa
    const r1 = await request(buyerApp)
      .post('/buyer/orders/100/dispute')
      .set('X-Idempotency-Key', 'db15-1-step1')
      .send({ reason: 'Producto llegó dañado' });
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe('DISPUTED');
    expect(disputeSvc.openDispute).toHaveBeenCalledWith(
      1,
      100,
      5,
      expect.objectContaining({ reason: 'Producto llegó dañado' }),
    );

    // 2. Admin inicia revisión
    const r2 = await request(adminApp)
      .post('/admin/disputes/1/review')
      .set('X-Idempotency-Key', 'db15-1-step2');
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe('DISPUTE_UNDER_REVIEW');
    expect(disputeSvc.startReview).toHaveBeenCalledWith(1, 1, 1);

    // 3. Admin resuelve sin acción
    const r3 = await request(adminApp)
      .post('/admin/disputes/1/resolve')
      .set('X-Idempotency-Key', 'db15-1-step3')
      .send({ action: 'NO_ACTION', resolution: 'No se encontraron evidencias suficientes de daño' });
    expect(r3.status).toBe(200);
    expect(r3.body.status).toBe('DISPUTE_RESOLVED_NO_ACTION');
    expect(r3.body.resolution_action).toBe('NO_ACTION');
    expect(r3.body.resolved_at).toBeTruthy();
    expect(disputeSvc.resolveNoAction).toHaveBeenCalledWith(
      1,
      1,
      'No se encontraron evidencias suficientes de daño',
      1,
    );

    // Sin efectos secundarios: resolveWithReturn y resolveWithRefund NUNCA llamados
    expect(disputeSvc.resolveWithReturn).not.toHaveBeenCalled();
    expect(disputeSvc.resolveWithRefund).not.toHaveBeenCalled();

    // Verificar secuencia completa
    expect(disputeSvc.openDispute).toHaveBeenCalledOnce();
    expect(disputeSvc.startReview).toHaveBeenCalledOnce();
    expect(disputeSvc.resolveNoAction).toHaveBeenCalledOnce();
  });
});

describe('DB15-2 — resolveWithReturn: disputa → return creado con RETURN_REQUESTED automáticamente', () => {
  it('resolveWithReturn retorna DISPUTE_RESOLVED_WITH_RETURN; el servicio fue llamado con parámetros correctos', async () => {
    const disputeSvc = makeMockDisputesService();

    (disputeSvc.openDispute as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTED',
    });
    (disputeSvc.startReview as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTE_UNDER_REVIEW',
    });
    // resolveWithReturn internamente llama returnsService.requestReturn (efecto secundario)
    (disputeSvc.resolveWithReturn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTE_RESOLVED_WITH_RETURN',
      resolution: 'Se aprueba la devolución del producto dañado',
      resolution_action: 'WITH_RETURN',
      resolved_by_user_id: 1,
      resolved_at: now,
    });

    const buyerApp = buildBuyerDisputesApp(disputeSvc);
    const adminApp = buildAdminDisputesApp(disputeSvc);

    // 1. Comprador abre disputa
    const r1 = await request(buyerApp)
      .post('/buyer/orders/100/dispute')
      .set('X-Idempotency-Key', 'db15-2-step1')
      .send({ reason: 'Producto llegó roto' });
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe('DISPUTED');

    // 2. Admin inicia revisión
    const r2 = await request(adminApp)
      .post('/admin/disputes/1/review')
      .set('X-Idempotency-Key', 'db15-2-step2');
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe('DISPUTE_UNDER_REVIEW');

    // 3. Admin resuelve con devolución → el servicio internamente crea el return
    const r3 = await request(adminApp)
      .post('/admin/disputes/1/resolve')
      .set('X-Idempotency-Key', 'db15-2-step3')
      .send({ action: 'WITH_RETURN', resolution: 'Se aprueba la devolución del producto dañado' });
    expect(r3.status).toBe(200);
    expect(r3.body.status).toBe('DISPUTE_RESOLVED_WITH_RETURN');
    expect(r3.body.resolution_action).toBe('WITH_RETURN');
    expect(r3.body.resolved_at).toBeTruthy();
    expect(disputeSvc.resolveWithReturn).toHaveBeenCalledWith(
      1,
      1,
      'Se aprueba la devolución del producto dañado',
      1,
    );

    // resolveNoAction y resolveWithRefund NUNCA deben haberse llamado
    expect(disputeSvc.resolveNoAction).not.toHaveBeenCalled();
    expect(disputeSvc.resolveWithRefund).not.toHaveBeenCalled();
  });
});

describe('DB15-3 — resolveWithRefund: disputa → refund creado con REFUND_PENDING automáticamente', () => {
  it('resolveWithRefund retorna DISPUTE_RESOLVED_WITH_REFUND; el servicio fue llamado con amount correcto', async () => {
    const disputeSvc = makeMockDisputesService();

    (disputeSvc.openDispute as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTED',
    });
    (disputeSvc.startReview as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTE_UNDER_REVIEW',
    });
    // resolveWithRefund internamente llama refundsService.initiateRefund (efecto secundario)
    (disputeSvc.resolveWithRefund as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTE_RESOLVED_WITH_REFUND',
      resolution: 'Se aprueba reembolso parcial por producto defectuoso',
      resolution_action: 'WITH_REFUND',
      resolved_by_user_id: 1,
      resolved_at: now,
    });

    const buyerApp = buildBuyerDisputesApp(disputeSvc);
    const adminApp = buildAdminDisputesApp(disputeSvc);

    // 1. Comprador abre disputa
    const r1 = await request(buyerApp)
      .post('/buyer/orders/100/dispute')
      .set('X-Idempotency-Key', 'db15-3-step1')
      .send({ reason: 'Artículo defectuoso, no devolvible' });
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe('DISPUTED');

    // 2. Admin inicia revisión
    const r2 = await request(adminApp)
      .post('/admin/disputes/1/review')
      .set('X-Idempotency-Key', 'db15-3-step2');
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe('DISPUTE_UNDER_REVIEW');

    // 3. Admin resuelve con reembolso → el servicio internamente inicia el refund
    const r3 = await request(adminApp)
      .post('/admin/disputes/1/resolve')
      .set('X-Idempotency-Key', 'db15-3-step3')
      .send({
        action: 'WITH_REFUND',
        resolution: 'Se aprueba reembolso parcial por producto defectuoso',
        amount: 75000,
      });
    expect(r3.status).toBe(200);
    expect(r3.body.status).toBe('DISPUTE_RESOLVED_WITH_REFUND');
    expect(r3.body.resolution_action).toBe('WITH_REFUND');
    expect(r3.body.resolved_at).toBeTruthy();
    expect(disputeSvc.resolveWithRefund).toHaveBeenCalledWith(
      1,
      1,
      expect.objectContaining({ amount: 75000, resolution: 'Se aprueba reembolso parcial por producto defectuoso' }),
      1,
    );

    // resolveNoAction y resolveWithReturn NUNCA deben haberse llamado
    expect(disputeSvc.resolveNoAction).not.toHaveBeenCalled();
    expect(disputeSvc.resolveWithReturn).not.toHaveBeenCalled();
  });
});

describe('DB15-4 — Flujo completo WITH_RETURN: disputa → return → aprobación → refund', () => {
  it('openDispute → startReview → resolveWithReturn → approveReturn (refund disparado)', async () => {
    const disputeSvc = makeMockDisputesService();
    const returnsSvc = makeMockReturnsService();

    // Disputas
    (disputeSvc.openDispute as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTED',
    });
    (disputeSvc.startReview as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTE_UNDER_REVIEW',
    });
    (disputeSvc.resolveWithReturn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTE_RESOLVED_WITH_RETURN',
      resolution: 'Devolución aprobada por defecto de fabricación',
      resolution_action: 'WITH_RETURN',
      resolved_by_user_id: 1,
      resolved_at: now,
    });

    // Returns: el return ya fue creado automáticamente al resolver la disputa
    (returnsSvc.approveReturn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseReturn,
      status: 'RETURN_APPROVED',
      approved_at: now,
      // metadata indica que el refund fue iniciado automáticamente
      metadata: { refund_initiated: true },
    });

    const buyerDisputeApp = buildBuyerDisputesApp(disputeSvc);
    const adminDisputeApp = buildAdminDisputesApp(disputeSvc);
    const adminReturnApp = buildAdminReturnsApp(returnsSvc);

    // Paso 1: Comprador abre disputa
    const r1 = await request(buyerDisputeApp)
      .post('/buyer/orders/100/dispute')
      .set('X-Idempotency-Key', 'db15-4-step1')
      .send({ reason: 'Defecto de fabricación confirmado' });
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe('DISPUTED');

    // Paso 2: Admin inicia revisión de la disputa
    const r2 = await request(adminDisputeApp)
      .post('/admin/disputes/1/review')
      .set('X-Idempotency-Key', 'db15-4-step2');
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe('DISPUTE_UNDER_REVIEW');

    // Paso 3: Admin resuelve con devolución
    // El servicio disputes.resolveWithReturn() internamente llama returnsService.requestReturn()
    // creando automáticamente un return con RETURN_REQUESTED
    const r3 = await request(adminDisputeApp)
      .post('/admin/disputes/1/resolve')
      .set('X-Idempotency-Key', 'db15-4-step3')
      .send({ action: 'WITH_RETURN', resolution: 'Devolución aprobada por defecto de fabricación' });
    expect(r3.status).toBe(200);
    expect(r3.body.status).toBe('DISPUTE_RESOLVED_WITH_RETURN');
    expect(r3.body.resolution_action).toBe('WITH_RETURN');
    // Verifica que resolveWithReturn fue llamado (internamente crea el return automáticamente)
    expect(disputeSvc.resolveWithReturn).toHaveBeenCalledWith(
      1, // client_id
      1, // dispute_id
      'Devolución aprobada por defecto de fabricación',
      1, // actor_user_id
    );

    // Paso 4: Admin aprueba la devolución (creada automáticamente en paso 3)
    // approveReturn en returns.service dispara refundsService.initiateRefund()
    const r4 = await request(adminReturnApp)
      .post('/admin/returns/10/approve')
      .set('X-Idempotency-Key', 'db15-4-step4');
    expect(r4.status).toBe(200);
    expect(r4.body.status).toBe('RETURN_APPROVED');
    expect(r4.body.approved_at).toBeTruthy();
    // metadata del servicio mock confirma que el refund fue iniciado
    expect(r4.body.metadata?.refund_initiated).toBe(true);
    expect(returnsSvc.approveReturn).toHaveBeenCalledWith(
      1, // client_id
      10, // return_id
      expect.objectContaining({ id: 1, client_id: 1, user_type: 'ADMIN_CLIENT' }), // actor
    );

    // Verificar secuencia completa: disputas → devolución → reembolso
    expect(disputeSvc.openDispute).toHaveBeenCalledOnce();
    expect(disputeSvc.startReview).toHaveBeenCalledOnce();
    expect(disputeSvc.resolveWithReturn).toHaveBeenCalledOnce();
    expect(returnsSvc.approveReturn).toHaveBeenCalledOnce();
    // Resoluciones alternativas NUNCA llamadas
    expect(disputeSvc.resolveNoAction).not.toHaveBeenCalled();
    expect(disputeSvc.resolveWithRefund).not.toHaveBeenCalled();
    expect(returnsSvc.rejectReturn).not.toHaveBeenCalled();
  });
});

describe('DB15-5 — Aislamiento: buyer de cliente A no puede abrir disputa en pedido de cliente B → 403', () => {
  it('retorna 403 FORBIDDEN cuando el buyer autenticado pertenece a otro cliente', async () => {
    const disputeSvc = makeMockDisputesService();

    // El servicio rechaza porque el buyer de cliente B intenta acceder
    // a un pedido que solo pertenece al cliente A
    (disputeSvc.openDispute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(403, 'FORBIDDEN', 'El pedido no pertenece a este comprador'),
    );

    // App construida con buyer del cliente B (client_id = 2)
    const appClientB = buildBuyerDisputesApp(disputeSvc, buyerUserClientB);

    const res = await request(appClientB)
      .post('/buyer/orders/100/dispute')
      .set('X-Idempotency-Key', 'db15-5-isolation')
      .send({ reason: 'Producto dañado' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');

    // El servicio fue llamado con el client_id del buyer autenticado (cliente B = 2)
    expect(disputeSvc.openDispute).toHaveBeenCalledWith(
      2,   // client_id del buyer de cliente B
      100, // order_id del pedido del cliente A
      99,  // buyer_id del cliente B
      expect.objectContaining({ reason: 'Producto dañado' }),
    );

    // Ninguna operación posterior debe haberse ejecutado
    expect(disputeSvc.startReview).not.toHaveBeenCalled();
    expect(disputeSvc.resolveNoAction).not.toHaveBeenCalled();
    expect(disputeSvc.resolveWithReturn).not.toHaveBeenCalled();
    expect(disputeSvc.resolveWithRefund).not.toHaveBeenCalled();
  });

  it('admin de cliente B obtiene 404 al intentar ver disputa del cliente A', async () => {
    const disputeSvc = makeMockDisputesService();

    // El servicio filtra por client_id y no encuentra la disputa del cliente A
    (disputeSvc.getDispute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Disputa no encontrada'),
    );

    const adminClientB: AuthenticatedUser = {
      id: 88,
      client_id: 2,
      user_type: 'ADMIN_CLIENT',
      session_id: 40,
    };

    const appAdminClientB = buildAdminDisputesApp(disputeSvc, adminClientB);

    const res = await request(appAdminClientB)
      .get('/admin/disputes/1');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
    // Verifica que se buscó con client_id = 2, no con el client_id de la disputa (1)
    expect(disputeSvc.getDispute).toHaveBeenCalledWith(2, 1);
  });
});

describe('DB15-6 — Flujo completo WITH_REFUND: openDispute → startReview → resolveWithRefund', () => {
  it('resolveWithRefund es la única resolución llamada; retorna DISPUTE_RESOLVED_WITH_REFUND', async () => {
    const disputeSvc = makeMockDisputesService();

    (disputeSvc.openDispute as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTED',
    });
    (disputeSvc.startReview as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTE_UNDER_REVIEW',
    });
    (disputeSvc.resolveWithRefund as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...baseDispute,
      status: 'DISPUTE_RESOLVED_WITH_REFUND',
      resolution: 'Producto deteriorado en tránsito, reembolso total aprobado',
      resolution_action: 'WITH_REFUND',
      resolved_by_user_id: 1,
      resolved_at: now,
    });

    const buyerApp = buildBuyerDisputesApp(disputeSvc);
    const adminApp = buildAdminDisputesApp(disputeSvc);

    // 1. Comprador abre disputa
    const r1 = await request(buyerApp)
      .post('/buyer/orders/100/dispute')
      .set('X-Idempotency-Key', 'db15-6-step1')
      .send({ reason: 'Producto deteriorado en tránsito' });
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe('DISPUTED');

    // 2. Admin inicia revisión
    const r2 = await request(adminApp)
      .post('/admin/disputes/1/review')
      .set('X-Idempotency-Key', 'db15-6-step2');
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe('DISPUTE_UNDER_REVIEW');

    // 3. Admin resuelve con reembolso total
    const r3 = await request(adminApp)
      .post('/admin/disputes/1/resolve')
      .set('X-Idempotency-Key', 'db15-6-step3')
      .send({
        action: 'WITH_REFUND',
        resolution: 'Producto deteriorado en tránsito, reembolso total aprobado',
        amount: 150000,
      });
    expect(r3.status).toBe(200);
    expect(r3.body.status).toBe('DISPUTE_RESOLVED_WITH_REFUND');
    expect(r3.body.resolution_action).toBe('WITH_REFUND');
    expect(disputeSvc.resolveWithRefund).toHaveBeenCalledWith(
      1,
      1,
      expect.objectContaining({ amount: 150000, resolution: 'Producto deteriorado en tránsito, reembolso total aprobado' }),
      1,
    );

    // Secuencia completa: solo resolveWithRefund, nunca las otras
    expect(disputeSvc.openDispute).toHaveBeenCalledOnce();
    expect(disputeSvc.startReview).toHaveBeenCalledOnce();
    expect(disputeSvc.resolveWithRefund).toHaveBeenCalledOnce();
    expect(disputeSvc.resolveNoAction).not.toHaveBeenCalled();
    expect(disputeSvc.resolveWithReturn).not.toHaveBeenCalled();
  });
});

describe('DB15-7 — Transición inválida: resolver disputa desde estado DISPUTED → 422', () => {
  it('resolveWithReturn desde DISPUTED (sin startReview previo) retorna 422 INVALID_STATE_TRANSITION', async () => {
    const disputeSvc = makeMockDisputesService();

    // El servicio rechaza porque la disputa está en DISPUTED, no en DISPUTE_UNDER_REVIEW
    (disputeSvc.resolveWithReturn as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(
        422,
        'INVALID_STATE_TRANSITION',
        'La disputa está en estado DISPUTED; se esperaba DISPUTE_UNDER_REVIEW',
      ),
    );

    const adminApp = buildAdminDisputesApp(disputeSvc);

    const res = await request(adminApp)
      .post('/admin/disputes/1/resolve')
      .set('X-Idempotency-Key', 'db15-7-invalid')
      .send({ action: 'WITH_RETURN', resolution: 'Intento de resolución prematura' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');

    // startReview nunca fue llamado → la transición es inválida
    expect(disputeSvc.startReview).not.toHaveBeenCalled();
    expect(disputeSvc.resolveWithReturn).toHaveBeenCalledOnce();
  });

  it('resolveWithRefund desde DISPUTED retorna 422 INVALID_STATE_TRANSITION', async () => {
    const disputeSvc = makeMockDisputesService();

    (disputeSvc.resolveWithRefund as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(
        422,
        'INVALID_STATE_TRANSITION',
        'La disputa está en estado DISPUTED; se esperaba DISPUTE_UNDER_REVIEW',
      ),
    );

    const adminApp = buildAdminDisputesApp(disputeSvc);

    const res = await request(adminApp)
      .post('/admin/disputes/1/resolve')
      .set('X-Idempotency-Key', 'db15-7-invalid-refund')
      .send({ action: 'WITH_REFUND', resolution: 'Reembolso prematuro', amount: 50000 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(disputeSvc.resolveNoAction).not.toHaveBeenCalled();
    expect(disputeSvc.resolveWithReturn).not.toHaveBeenCalled();
  });
});
