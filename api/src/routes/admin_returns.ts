/**
 * admin_returns.ts — Rutas del panel admin para gestión de devoluciones (Fase 3, Bloque 3.2)
 *
 * Endpoints:
 *   GET  /admin/returns               — lista con filtros (status, return_mechanism)
 *   GET  /admin/returns/:id           — detalle
 *   POST /admin/returns/:id/review    — inicia revisión (RETURN_REQUESTED → RETURN_UNDER_REVIEW)
 *   POST /admin/returns/:id/approve   — aprueba (RETURN_UNDER_REVIEW → RETURN_APPROVED)
 *   POST /admin/returns/:id/reject    — rechaza (RETURN_UNDER_REVIEW → RETURN_REJECTED)
 *   POST /admin/returns/:id/schedule-pickup — programa recogida
 *   POST /admin/returns/:id/mark-out-for-collection — repartidor en camino
 *   POST /admin/returns/:id/mark-collected — repartidor recogió
 *   POST /admin/returns/:id/mark-in-transit — el comprador envió
 *   POST /admin/returns/:id/mark-received  — mercancía recibida
 *   POST /admin/returns/:id/mark-lost      — mercancía perdida
 *   POST /admin/returns/:id/mark-pickup-failed — recogida fallida
 *   POST /admin/returns/:id/cancel         — cancelar devolución
 */

import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { toApiError } from '../lib/errors.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import {
  returnsService,
  rejectReturnBodySchema,
  schedulePickupBodySchema,
  returnListQuerySchema,
} from '../services/returns.service.js';

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

// ── Param schemas ─────────────────────────────────────────────────────────────

const returnIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const markPickupFailedBodySchema = z.object({
  reason: z.string().min(1).max(500),
});

// ── Router factory ────────────────────────────────────────────────────────────

type ReturnsService = typeof returnsService;

export function createAdminReturnsRouter(svc: ReturnsService = returnsService): Router {
  const router = Router();

  router.use(requireAdminOrOperator);

  // GET /admin/returns — lista de devoluciones
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = returnListQuerySchema.parse(req.query);
      res.json(await svc.listReturns(req.user!.client_id, query));
    } catch (error) {
      next(error);
    }
  });

  // GET /admin/returns/:id — detalle
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = returnIdParamsSchema.parse(req.params);
      res.json(await svc.getReturn(req.user!.client_id, id));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/returns/:id/review — inicia revisión
  router.post('/:id/review', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = returnIdParamsSchema.parse(req.params);
      res.json(await svc.startReview(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/returns/:id/approve — aprueba
  router.post('/:id/approve', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = returnIdParamsSchema.parse(req.params);
      res.json(await svc.approveReturn(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/returns/:id/reject — rechaza
  router.post('/:id/reject', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = returnIdParamsSchema.parse(req.params);
      const { reason } = rejectReturnBodySchema.parse(req.body);
      res.json(await svc.rejectReturn(req.user!.client_id, id, reason, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/returns/:id/schedule-pickup — programa recogida (CLIENT_PICKS_UP)
  router.post('/:id/schedule-pickup', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = returnIdParamsSchema.parse(req.params);
      const { courier_id } = schedulePickupBodySchema.parse(req.body);
      res.json(await svc.schedulePickup(req.user!.client_id, id, courier_id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/returns/:id/mark-out-for-collection — repartidor en camino
  router.post('/:id/mark-out-for-collection', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = returnIdParamsSchema.parse(req.params);
      res.json(await svc.markPickupOutForCollection(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/returns/:id/mark-collected — repartidor recogió
  router.post('/:id/mark-collected', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = returnIdParamsSchema.parse(req.params);
      res.json(await svc.markPickupCollected(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/returns/:id/mark-in-transit — comprador ya envió (BUYER_SHIPS_VIA_COURIER)
  router.post('/:id/mark-in-transit', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = returnIdParamsSchema.parse(req.params);
      res.json(await svc.markInTransit(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/returns/:id/mark-received — mercancía recibida
  router.post('/:id/mark-received', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = returnIdParamsSchema.parse(req.params);
      res.json(await svc.markReceived(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/returns/:id/mark-lost — mercancía perdida
  router.post('/:id/mark-lost', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = returnIdParamsSchema.parse(req.params);
      res.json(await svc.markLost(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/returns/:id/mark-pickup-failed — recogida fallida
  router.post('/:id/mark-pickup-failed', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = returnIdParamsSchema.parse(req.params);
      const { reason } = markPickupFailedBodySchema.parse(req.body);
      res.json(await svc.markPickupFailed(req.user!.client_id, id, reason, req.user!));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/returns/:id/cancel — cancelar devolución
  router.post('/:id/cancel', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = returnIdParamsSchema.parse(req.params);
      res.json(await svc.cancelReturn(req.user!.client_id, id, req.user!));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminReturnsRouter = createAdminReturnsRouter();
