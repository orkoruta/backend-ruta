/**
 * buyer_recurrence.ts — Rutas del comprador para gestión de recurrencia (Fase 3, Bloque 4.2)
 *
 * Endpoints:
 *   POST /buyer/orders/:id/mark-recurring  — marcar pedido como recurrente
 *   POST /buyer/recurrence/repeat-last     — repetir último pedido (DRAFT)
 *   GET  /buyer/recurrence                 — mis plantillas de recurrencia
 *   PATCH /buyer/recurrence/:id            — editar plantilla
 *   POST /buyer/recurrence/:id/pause       — pausar plantilla activa
 *   POST /buyer/recurrence/:id/resume      — reanudar plantilla pausada
 *   DELETE /buyer/recurrence/:id           — cancelar plantilla
 */

import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { toApiError } from '../lib/errors.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import {
  recurrenceService,
  markAsRecurringSchema,
  updateTemplateSchema,
  recurrenceListQuerySchema,
} from '../services/recurrence.service.js';

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

// ── Schemas de params ─────────────────────────────────────────────────────────

const orderIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const templateIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ── Router factory ────────────────────────────────────────────────────────────

type RecurrenceService = typeof recurrenceService;

export function createBuyerRecurrenceRouter(svc: RecurrenceService = recurrenceService): Router {
  const router = Router({ mergeParams: true });

  router.use(requireBuyer);

  // POST /buyer/recurrence/repeat-last — Repetir último pedido (crea DRAFT)
  router.post('/repeat-last', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await svc.repeatLastOrder(req.user!.client_id, req.user!.id);
      res.status(201).json(order);
    } catch (error) {
      next(error);
    }
  });

  // GET /buyer/recurrence — Mis plantillas de recurrencia
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = recurrenceListQuerySchema.parse(req.query);
      const result = await svc.listBuyerTemplates(req.user!.client_id, req.user!.id, query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // PATCH /buyer/recurrence/:id — Editar plantilla
  router.patch('/:id', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = templateIdParamsSchema.parse(req.params);
      const input = updateTemplateSchema.parse(req.body);
      const template = await svc.updateTemplate(req.user!.client_id, id, req.user!.id, input);
      res.json(template);
    } catch (error) {
      next(error);
    }
  });

  // POST /buyer/recurrence/:id/pause — Pausar plantilla activa
  router.post('/:id/pause', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = templateIdParamsSchema.parse(req.params);
      const template = await svc.pauseRecurrence(req.user!.client_id, id, req.user!.id);
      res.json(template);
    } catch (error) {
      next(error);
    }
  });

  // POST /buyer/recurrence/:id/resume — Reanudar plantilla pausada
  router.post('/:id/resume', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = templateIdParamsSchema.parse(req.params);
      const template = await svc.resumeRecurrence(req.user!.client_id, id, req.user!.id);
      res.json(template);
    } catch (error) {
      next(error);
    }
  });

  // DELETE /buyer/recurrence/:id — Cancelar plantilla
  router.delete('/:id', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = templateIdParamsSchema.parse(req.params);
      const template = await svc.cancelRecurrence(req.user!.client_id, id, req.user!.id);
      res.json(template);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// ── Router de órdenes (montado en /buyer/orders para: POST /buyer/orders/:id/mark-recurring) ──

export function createBuyerOrderRecurrenceRouter(svc: RecurrenceService = recurrenceService): Router {
  const router = Router({ mergeParams: true });

  router.use(requireBuyer);

  // POST /buyer/orders/:id/mark-recurring
  router.post('/:id/mark-recurring', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const input = markAsRecurringSchema.parse(req.body);
      const template = await svc.markOrderAsRecurring(req.user!.client_id, id, req.user!.id, input);
      res.status(201).json(template);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const buyerRecurrenceRouter = createBuyerRecurrenceRouter();
export const buyerOrderRecurrenceRouter = createBuyerOrderRecurrenceRouter();
