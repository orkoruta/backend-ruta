/**
 * admin_recurrence.ts — Rutas del panel admin para gestión de recurrencia (Fase 3, Bloque 4.2)
 *
 * Endpoints:
 *   GET  /admin/recurrence          — todas las plantillas del cliente
 *   POST /admin/recurrence/:id/pause   — pausar plantilla activa
 *   POST /admin/recurrence/:id/cancel  — cancelar plantilla
 */

import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { toApiError } from '../lib/errors.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import {
  recurrenceService,
  recurrenceListQuerySchema,
} from '../services/recurrence.service.js';

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

const templateIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const adminRecurrenceListQuerySchema = recurrenceListQuerySchema.extend({
  buyer_id: z.coerce.number().int().positive().optional(),
});

// ── Router factory ────────────────────────────────────────────────────────────

type RecurrenceService = typeof recurrenceService;

export function createAdminRecurrenceRouter(svc: RecurrenceService = recurrenceService): Router {
  const router = Router();

  router.use(requireAdminOrOperator);

  // GET /admin/recurrence — lista todas las plantillas del cliente (con filtros)
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = adminRecurrenceListQuerySchema.parse(req.query);
      const result = await svc.listTemplates(req.user!.client_id, query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /admin/recurrence/:id — detalle de una plantilla
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = templateIdParamsSchema.parse(req.params);
      const template = await svc.getTemplate(req.user!.client_id, id);
      res.json(template);
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/recurrence/:id/pause — pausar plantilla activa (admin, sin validar buyerId)
  router.post('/:id/pause', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = templateIdParamsSchema.parse(req.params);
      const template = await svc.pauseRecurrenceAsAdmin(req.user!.client_id, id, req.user!);
      res.json(template);
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/recurrence/:id/cancel — cancelar plantilla (admin, sin validar buyerId)
  router.post('/:id/cancel', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = templateIdParamsSchema.parse(req.params);
      const template = await svc.cancelRecurrenceAsAdmin(req.user!.client_id, id, req.user!);
      res.json(template);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminRecurrenceRouter = createAdminRecurrenceRouter();
