/**
 * admin_disputes.ts — Rutas del panel admin para gestión de disputas (Fase 3, Bloque 3.3)
 *
 * Endpoints:
 *   GET  /admin/disputes               — lista con filtros
 *   GET  /admin/disputes/:id           — detalle
 *   POST /admin/disputes/:id/review    — iniciar revisión (DISPUTED → DISPUTE_UNDER_REVIEW)
 *   POST /admin/disputes/:id/resolve   — resolver con action: NO_ACTION | WITH_RETURN | WITH_REFUND
 */

import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { toApiError } from '../lib/errors.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import {
  disputesService,
  resolveDisputeBodySchema,
  disputeListQuerySchema,
} from '../services/disputes.service.js';

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

const disputeIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ── Router factory ────────────────────────────────────────────────────────────

type DisputesService = typeof disputesService;

export function createAdminDisputesRouter(svc: DisputesService = disputesService): Router {
  const router = Router();

  router.use(requireAdminOrOperator);

  // GET /admin/disputes — lista de disputas
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = disputeListQuerySchema.parse(req.query);
      res.json(await svc.listDisputes(req.user!.client_id, query));
    } catch (error) {
      next(error);
    }
  });

  // GET /admin/disputes/:id — detalle
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = disputeIdParamsSchema.parse(req.params);
      res.json(await svc.getDispute(req.user!.client_id, id));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/disputes/:id/review — iniciar revisión
  router.post('/:id/review', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = disputeIdParamsSchema.parse(req.params);
      res.json(await svc.startReview(req.user!.client_id, id, req.user!.id));
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/disputes/:id/resolve — resolver disputa
  // Body: { action: 'NO_ACTION' | 'WITH_RETURN' | 'WITH_REFUND', resolution, amount? }
  router.post('/:id/resolve', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = disputeIdParamsSchema.parse(req.params);
      const body = resolveDisputeBodySchema.parse(req.body);
      const clientId = req.user!.client_id;
      const actorUserId = req.user!.id;

      let result;

      if (body.action === 'NO_ACTION') {
        result = await svc.resolveNoAction(clientId, id, body.resolution, actorUserId);
      } else if (body.action === 'WITH_RETURN') {
        result = await svc.resolveWithReturn(clientId, id, body.resolution, actorUserId);
      } else {
        // WITH_REFUND: amount required
        if (body.amount === undefined || body.amount === null) {
          res.status(422).json(
            toApiError('VALIDATION_ERROR', 'El campo amount es requerido para resolución WITH_REFUND'),
          );
          return;
        }
        result = await svc.resolveWithRefund(clientId, id, { amount: body.amount, resolution: body.resolution }, actorUserId);
      }

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminDisputesRouter = createAdminDisputesRouter();
