/**
 * disputes.test.ts — Tests del Bloque 15: Disputas post-entrega (F3.B3.2.BACK-1)
 *
 * Cobertura:
 *   DT01  Comprador abre disputa en pedido DELIVERED → DISPUTED (201)
 *   DT02  Comprador NO puede abrir disputa en pedido no entregado → 422
 *   DT03  Admin inicia revisión → DISPUTE_UNDER_REVIEW
 *   DT04  Resolución NO_ACTION → DISPUTE_RESOLVED_NO_ACTION, sin efectos secundarios
 *   DT05  Resolución WITH_RETURN → DISPUTE_RESOLVED_WITH_RETURN, returns creado RETURN_REQUESTED
 *   DT06  Resolución WITH_REFUND → DISPUTE_RESOLVED_WITH_REFUND, refunds creado REFUND_PENDING
 *   DT07  Aislamiento: buyer A no puede abrir disputa en pedido del cliente B
 *   DT08  Aislamiento: admin de cliente A no ve disputas del cliente B
 *   DT09  Disputa ya abierta → no se puede abrir otra (409)
 *   DT10  Cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE
 *   DT11  GET /buyer/orders/:id/dispute — estado de disputa del comprador
 *   DT12  POST /buyer/orders/:id/dispute sin X-Idempotency-Key → 400
 *   DT13  Transición inválida: resolver disputa en estado DISPUTED → 422
 *   DT14  GET /admin/disputes/:id — detalle de disputa existente
 *   DT15  GET /admin/disputes — lista de disputas
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import type { disputesService } from '../services/disputes.service.js';
import { createAdminDisputesRouter } from '../routes/admin_disputes.js';
import { createBuyerDisputesRouter } from '../routes/buyer_disputes.js';

// ── Tipos ─────────────────────────────────────────────────────────────────────

type DisputesService = typeof disputesService;

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

const adminUser: AuthenticatedUser = {
  id: 1,
  client_id: 1,
  user_type: 'ADMIN_CLIENT',
  session_id: 10,
};

const buyerUser: AuthenticatedUser = {
  id: 5,
  client_id: 1,
  user_type: 'BUYER',
  session_id: 20,
};

// Admin de cliente B (diferente client_id)
const adminUserClientB: AuthenticatedUser = {
  id: 99,
  client_id: 2,
  user_type: 'ADMIN_CLIENT',
  session_id: 30,
};

function buildAdminApp(svc: DisputesService, user: AuthenticatedUser = adminUser) {
  const app = express();
  app.use(express.json());
  app.use(withUser(user));
  app.use('/admin/disputes', createAdminDisputesRouter(svc));
  app.use(errorHandler);
  return app;
}

function buildBuyerApp(svc: DisputesService, user: AuthenticatedUser = buyerUser) {
  const app = express();
  app.use(express.json());
  app.use(withUser(user));
  app.use('/buyer/orders', createBuyerDisputesRouter(svc));
  app.use(errorHandler);
  return app;
}

// ── Mock del servicio ─────────────────────────────────────────────────────────

function makeMockService(): DisputesService {
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

const mockDispute = {
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
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DT01 — Comprador abre disputa en pedido DELIVERED → DISPUTED', () => {
  it('retorna 201 con la disputa creada', async () => {
    const svc = makeMockService();
    (svc.openDispute as ReturnType<typeof vi.fn>).mockResolvedValue(mockDispute);
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/orders/100/dispute')
      .set('X-Idempotency-Key', 'key-dt01')
      .send({ reason: 'Producto llegó dañado' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DISPUTED');
    expect(svc.openDispute).toHaveBeenCalledWith(
      1,
      100,
      5,
      expect.objectContaining({ reason: 'Producto llegó dañado' }),
    );
  });
});

describe('DT02 — Comprador NO puede abrir disputa en pedido no entregado → 422', () => {
  it('retorna 422 INVALID_STATE_TRANSITION', async () => {
    const svc = makeMockService();
    (svc.openDispute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(
        422,
        'INVALID_STATE_TRANSITION',
        'El pedido tiene order_status=SHIPPED; se requiere DELIVERED',
      ),
    );
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/orders/200/dispute')
      .set('X-Idempotency-Key', 'key-dt02')
      .send({ reason: 'No recibí el pedido' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('DT03 — Admin inicia revisión → DISPUTE_UNDER_REVIEW', () => {
  it('retorna 200 con status DISPUTE_UNDER_REVIEW', async () => {
    const svc = makeMockService();
    (svc.startReview as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockDispute,
      status: 'DISPUTE_UNDER_REVIEW',
    });
    const app = buildAdminApp(svc);

    const res = await request(app)
      .post('/admin/disputes/1/review')
      .set('X-Idempotency-Key', 'key-dt03');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISPUTE_UNDER_REVIEW');
    expect(svc.startReview).toHaveBeenCalledWith(1, 1, 1);
  });
});

describe('DT04 — Resolución NO_ACTION → DISPUTE_RESOLVED_NO_ACTION, sin efectos secundarios', () => {
  it('retorna 200, no llama returnsService ni refundsService', async () => {
    const svc = makeMockService();
    (svc.resolveNoAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockDispute,
      status: 'DISPUTE_RESOLVED_NO_ACTION',
      resolution: 'No se encontraron evidencias de daño',
      resolution_action: 'NO_ACTION',
    });
    const app = buildAdminApp(svc);

    const res = await request(app)
      .post('/admin/disputes/1/resolve')
      .set('X-Idempotency-Key', 'key-dt04')
      .send({ action: 'NO_ACTION', resolution: 'No se encontraron evidencias de daño' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISPUTE_RESOLVED_NO_ACTION');
    expect(res.body.resolution_action).toBe('NO_ACTION');
    // Verifica que solo se llamó resolveNoAction y NO las otras resoluciones
    expect(svc.resolveNoAction).toHaveBeenCalledWith(
      1,
      1,
      'No se encontraron evidencias de daño',
      1,
    );
    expect(svc.resolveWithReturn).not.toHaveBeenCalled();
    expect(svc.resolveWithRefund).not.toHaveBeenCalled();
  });
});

describe('DT05 — Resolución WITH_RETURN → DISPUTE_RESOLVED_WITH_RETURN, returns creado', () => {
  it('retorna 200 con status DISPUTE_RESOLVED_WITH_RETURN', async () => {
    const svc = makeMockService();
    (svc.resolveWithReturn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockDispute,
      status: 'DISPUTE_RESOLVED_WITH_RETURN',
      resolution: 'Se aprueba devolución del producto',
      resolution_action: 'WITH_RETURN',
    });
    const app = buildAdminApp(svc);

    const res = await request(app)
      .post('/admin/disputes/1/resolve')
      .set('X-Idempotency-Key', 'key-dt05')
      .send({ action: 'WITH_RETURN', resolution: 'Se aprueba devolución del producto' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISPUTE_RESOLVED_WITH_RETURN');
    expect(res.body.resolution_action).toBe('WITH_RETURN');
    expect(svc.resolveWithReturn).toHaveBeenCalledWith(
      1,
      1,
      'Se aprueba devolución del producto',
      1,
    );
  });
});

describe('DT06 — Resolución WITH_REFUND → DISPUTE_RESOLVED_WITH_REFUND, refunds creado', () => {
  it('retorna 200 con status DISPUTE_RESOLVED_WITH_REFUND', async () => {
    const svc = makeMockService();
    (svc.resolveWithRefund as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockDispute,
      status: 'DISPUTE_RESOLVED_WITH_REFUND',
      resolution: 'Se aprueba reembolso parcial',
      resolution_action: 'WITH_REFUND',
    });
    const app = buildAdminApp(svc);

    const res = await request(app)
      .post('/admin/disputes/1/resolve')
      .set('X-Idempotency-Key', 'key-dt06')
      .send({ action: 'WITH_REFUND', resolution: 'Se aprueba reembolso parcial', amount: 50000 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISPUTE_RESOLVED_WITH_REFUND');
    expect(res.body.resolution_action).toBe('WITH_REFUND');
    expect(svc.resolveWithRefund).toHaveBeenCalledWith(
      1,
      1,
      expect.objectContaining({ amount: 50000, resolution: 'Se aprueba reembolso parcial' }),
      1,
    );
  });

  it('WITH_REFUND sin amount → 422', async () => {
    const svc = makeMockService();
    const app = buildAdminApp(svc);

    const res = await request(app)
      .post('/admin/disputes/1/resolve')
      .set('X-Idempotency-Key', 'key-dt06b')
      .send({ action: 'WITH_REFUND', resolution: 'Se aprueba reembolso' });

    expect(res.status).toBe(422);
    expect(svc.resolveWithRefund).not.toHaveBeenCalled();
  });
});

describe('DT07 — Aislamiento: buyer no puede abrir disputa en pedido de otro cliente', () => {
  it('retorna 403 FORBIDDEN cuando el pedido no pertenece al comprador', async () => {
    const svc = makeMockService();
    (svc.openDispute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(403, 'FORBIDDEN', 'El pedido no pertenece a este comprador'),
    );
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/orders/999/dispute')
      .set('X-Idempotency-Key', 'key-dt07')
      .send({ reason: 'Producto dañado' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

describe('DT08 — Aislamiento: admin de cliente A no ve disputas del cliente B', () => {
  it('retorna 404 cuando la disputa no pertenece al cliente del admin', async () => {
    const svc = makeMockService();
    // Admin del cliente B intenta ver una disputa que solo existe en cliente A
    // El servicio verifica client_id y devuelve 404
    (svc.getDispute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Disputa no encontrada'),
    );
    // Admin del cliente B
    const app = buildAdminApp(svc, adminUserClientB);

    const res = await request(app)
      .get('/admin/disputes/1');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
    // Verifica que se llamó con client_id=2 (del cliente B)
    expect(svc.getDispute).toHaveBeenCalledWith(2, 1);
  });
});

describe('DT09 — Disputa ya abierta → no se puede abrir otra (409)', () => {
  it('retorna 409 IDEMPOTENCY_CONFLICT', async () => {
    const svc = makeMockService();
    (svc.openDispute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Ya existe una disputa para este pedido'),
    );
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/orders/100/dispute')
      .set('X-Idempotency-Key', 'key-dt09')
      .send({ reason: 'Segunda disputa' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('DT10 — Cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE', () => {
  it('retorna 422 para buyer de cliente API', async () => {
    const svc = makeMockService();
    (svc.openDispute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(422, 'LOGISTICS_ONLY_FEATURE_UNAVAILABLE', 'Las disputas no aplican para Clientes API'),
    );
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/orders/100/dispute')
      .set('X-Idempotency-Key', 'key-dt10')
      .send({ reason: 'Producto dañado' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOGISTICS_ONLY_FEATURE_UNAVAILABLE');
  });

  it('retorna 422 para admin de cliente API intentando resolver', async () => {
    const svc = makeMockService();
    (svc.startReview as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(422, 'LOGISTICS_ONLY_FEATURE_UNAVAILABLE', 'Las disputas no aplican para Clientes API'),
    );
    const app = buildAdminApp(svc);

    const res = await request(app)
      .post('/admin/disputes/1/review')
      .set('X-Idempotency-Key', 'key-dt10b');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOGISTICS_ONLY_FEATURE_UNAVAILABLE');
  });
});

describe('DT11 — GET /buyer/orders/:id/dispute — estado de disputa del comprador', () => {
  it('retorna 200 con dispute_status y datos de la disputa', async () => {
    const svc = makeMockService();
    (svc.getDisputeForOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      dispute_status: 'DISPUTED',
      dispute: mockDispute,
    });
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .get('/buyer/orders/100/dispute');

    expect(res.status).toBe(200);
    expect(res.body.dispute_status).toBe('DISPUTED');
    expect(res.body.dispute).not.toBeNull();
    expect(svc.getDisputeForOrder).toHaveBeenCalledWith(1, 100, 5);
  });

  it('retorna dispute: null cuando no hay disputa', async () => {
    const svc = makeMockService();
    (svc.getDisputeForOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      dispute_status: null,
      dispute: null,
    });
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .get('/buyer/orders/100/dispute');

    expect(res.status).toBe(200);
    expect(res.body.dispute).toBeNull();
  });
});

describe('DT12 — POST /buyer/orders/:id/dispute sin X-Idempotency-Key → 400', () => {
  it('retorna 400 cuando falta el header de idempotencia', async () => {
    const svc = makeMockService();
    const app = buildBuyerApp(svc);

    const res = await request(app)
      .post('/buyer/orders/100/dispute')
      .send({ reason: 'Producto dañado' });
    // Sin X-Idempotency-Key

    expect(res.status).toBe(400);
    expect(svc.openDispute).not.toHaveBeenCalled();
  });
});

describe('DT13 — Transición inválida: resolver disputa en estado DISPUTED → 422', () => {
  it('retorna 422 INVALID_STATE_TRANSITION al intentar resolver sin haber iniciado revisión', async () => {
    const svc = makeMockService();
    (svc.resolveNoAction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(
        422,
        'INVALID_STATE_TRANSITION',
        'La disputa está en estado DISPUTED; se esperaba DISPUTE_UNDER_REVIEW',
      ),
    );
    const app = buildAdminApp(svc);

    const res = await request(app)
      .post('/admin/disputes/1/resolve')
      .set('X-Idempotency-Key', 'key-dt13')
      .send({ action: 'NO_ACTION', resolution: 'Sin acción requerida' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('DT14 — GET /admin/disputes/:id — detalle de disputa existente', () => {
  it('retorna 200 con los datos de la disputa', async () => {
    const svc = makeMockService();
    (svc.getDispute as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockDispute,
      status: 'DISPUTE_UNDER_REVIEW',
    });
    const app = buildAdminApp(svc);

    const res = await request(app)
      .get('/admin/disputes/1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.body.status).toBe('DISPUTE_UNDER_REVIEW');
    expect(svc.getDispute).toHaveBeenCalledWith(1, 1);
  });

  it('retorna 404 cuando la disputa no existe', async () => {
    const svc = makeMockService();
    (svc.getDispute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Disputa no encontrada'),
    );
    const app = buildAdminApp(svc);

    const res = await request(app)
      .get('/admin/disputes/999');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('DT15 — GET /admin/disputes — lista de disputas', () => {
  it('retorna 200 con lista paginada', async () => {
    const svc = makeMockService();
    (svc.listDisputes as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockDispute],
      pagination: { page: 1, page_size: 20, total: 1 },
    });
    const app = buildAdminApp(svc);

    const res = await request(app)
      .get('/admin/disputes');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(svc.listDisputes).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ page: 1, page_size: 20 }),
    );
  });

  it('aplica filtro por status', async () => {
    const svc = makeMockService();
    (svc.listDisputes as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      pagination: { page: 1, page_size: 20, total: 0 },
    });
    const app = buildAdminApp(svc);

    const res = await request(app)
      .get('/admin/disputes?status=DISPUTE_UNDER_REVIEW');

    expect(res.status).toBe(200);
    expect(svc.listDisputes).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'DISPUTE_UNDER_REVIEW' }),
    );
  });
});
