/**
 * admin_refunds.ts — Rutas del panel admin para gestión de reembolsos (Fase 3, Bloque 3.1)
 *
 * Endpoints:
 *   GET  /admin/refunds               — lista paginada
 *   GET  /admin/refunds/:id           — detalle
 *   POST /admin/orders/:id/initiate-refund  — inicia reembolso (elige monto y modalidad)
 *   POST /admin/refunds/:id/process         — PENDING → PROCESSING
 *   POST /admin/refunds/:id/request-provider — PROCESSING → PROVIDER_REQUESTED
 *   POST /admin/refunds/:id/mark-executed   — marca como ejecutado
 */

import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { toApiError } from '../lib/errors.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import {
  refundsService,
  initiateRefundBodySchema,
  markRefundExecutedBodySchema,
  refundListQuerySchema,
} from '../services/refunds.service.js';

// ── Auth helpers ──────────────────────────────────────────────────────────────

function requireAdminOrOperator(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }
  const { user_type } = req.user;
  if (user_type !== 'ADMIN_CLIENT' && user_type !== 'OPERATOR_CLIENT' && user_type !== 'ADMIN_RUTA') {
    res.status(403).json(toApiError('FORBIDDEN', 'Acceso restringido al personal del Cliente'));
    return;
  }
  next();
}

// ── Schemas de params ─────────────────────────────────────────────────────────

const refundIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const orderIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ── Router factory ────────────────────────────────────────────────────────────

type RefundsService = typeof refundsService;

export function createAdminRefundsRouter(svc: RefundsService = refundsService): Router {
  const router = Router();

  router.use(requireAdminOrOperator);

  // GET /admin/refunds — lista de reembolsos
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = refundListQuerySchema.parse(req.query);
      res.json(await svc.listRefunds(req.user!.client_id, query));
    } catch (error) {
      next(error);
    }
  });

  // GET /admin/refunds/:id — detalle de reembolso
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = refundIdParamsSchema.parse(req.params);
      res.json(await svc.getRefund(req.user!.client_id, id));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/refunds/:id/process — PENDING → PROCESSING
  router.post('/:id/process', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = refundIdParamsSchema.parse(req.params);
      res.json(await svc.processRefund(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/refunds/:id/request-provider — PROCESSING → PROVIDER_REQUESTED
  router.post('/:id/request-provider', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = refundIdParamsSchema.parse(req.params);
      res.json(await svc.requestProviderRefund(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/refunds/:id/mark-executed — marca como REFUNDED / PARTIALLY_REFUNDED / FAILED
  router.post('/:id/mark-executed', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = refundIdParamsSchema.parse(req.params);
      const input = markRefundExecutedBodySchema.parse(req.body);
      res.json(await svc.markRefundExecuted(req.user!.client_id, id, input, req.user!));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// ── Router de órdenes para iniciar reembolso ─────────────────────────────────
// Montado en /admin/orders para: POST /admin/orders/:id/initiate-refund

export function createAdminOrderRefundRouter(svc: RefundsService = refundsService): Router {
  const router = Router({ mergeParams: true });

  router.use(requireAdminOrOperator);

  // POST /admin/orders/:id/initiate-refund
  router.post('/:id/initiate-refund', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const input = initiateRefundBodySchema.parse(req.body);
      const refund = await svc.initiateRefund(req.user!.client_id, id, input, req.user!);
      res.status(201).json(refund);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminRefundsRouter = createAdminRefundsRouter();
export const adminOrderRefundRouter = createAdminOrderRefundRouter();
