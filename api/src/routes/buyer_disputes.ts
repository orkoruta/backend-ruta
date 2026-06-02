/**
 * buyer_disputes.ts — Rutas del Comprador para disputas post-entrega (Fase 3, Bloque 3.3)
 *
 * Endpoints:
 *   POST /buyer/orders/:id/dispute — abrir disputa
 *   GET  /buyer/orders/:id/dispute — ver estado de la disputa
 */

import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { toApiError } from '../lib/errors.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { disputesService, openDisputeBodySchema } from '../services/disputes.service.js';

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

type DisputesService = typeof disputesService;

export function createBuyerDisputesRouter(svc: DisputesService = disputesService): Router {
  const router = Router({ mergeParams: true });

  router.use(requireBuyer);

  // POST /buyer/orders/:id/dispute — abrir disputa post-entrega
  router.post('/:id/dispute', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const input = openDisputeBodySchema.parse(req.body);
      const dispute = await svc.openDispute(req.user!.client_id, id, req.user!.id, input);
      res.status(201).json(dispute);
    } catch (error) {
      next(error);
    }
  });

  // GET /buyer/orders/:id/dispute — estado de la disputa del pedido
  router.get('/:id/dispute', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      res.json(await svc.getDisputeForOrder(req.user!.client_id, id, req.user!.id));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const buyerDisputesRouter = createBuyerDisputesRouter();
