/**
 * buyer_returns.ts — Rutas del Comprador para devoluciones post-cierre (Fase 3, Bloque 3.2)
 *
 * Endpoints:
 *   POST /buyer/orders/:id/request-return — solicitar devolución
 *   GET  /buyer/orders/:id/return         — ver estado de la devolución
 */

import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { toApiError } from '../lib/errors.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { returnsService, requestReturnBodySchema } from '../services/returns.service.js';

// ── Auth helpers ──────────────────────────────────────────────────────────────

function requireBuyer(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }
  if (req.user.user_type !== 'BUYER') {
    res.status(403).json(toApiError('FORBIDDEN', 'Solo compradores pueden acceder a este recurso'));
    return;
  }
  next();
}

// ── Param schemas ─────────────────────────────────────────────────────────────

const orderIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ── Router factory ────────────────────────────────────────────────────────────

type ReturnsService = typeof returnsService;

export function createBuyerReturnsRouter(svc: ReturnsService = returnsService): Router {
  const router = Router({ mergeParams: true });

  router.use(requireBuyer);

  // POST /buyer/orders/:id/request-return — solicitar devolución post-cierre
  router.post('/:id/request-return', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const input = requestReturnBodySchema.parse(req.body);
      const ret = await svc.requestReturn(req.user!.client_id, id, req.user!.id, input);
      res.status(201).json(ret);
    } catch (error) {
      next(error);
    }
  });

  // GET /buyer/orders/:id/return — estado de la devolución del pedido
  router.get('/:id/return', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      res.json(await svc.getReturnForOrder(req.user!.client_id, id, req.user!.id));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const buyerReturnsRouter = createBuyerReturnsRouter();
