/**
 * courier_collection.ts
 *
 * Router para cobro contra entrega (COD).
 *
 * Rutas:
 *   POST /courier/orders/:id/initiate-collection      — inicia el cobro
 *   POST /courier/orders/:id/record-collection        — registra cobro exitoso (JSON)
 *   POST /courier/orders/:id/record-failed-collection — registra cobro fallido definitivo
 *
 * Auth: solo COURIER.
 * Todos los POST requieren X-Idempotency-Key.
 *
 * NOTA sobre file storage: el proyecto aún no tiene file storage definido
 * (CLAUDE.md sección 2). El campo `evidence_url` se acepta como string
 * opcional en el body JSON. No se implementa upload multipart.
 *
 * Para montar en app.ts agregar:
 *   app.use('/courier', courierCollectionRouter)
 */

import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { toApiError } from '../lib/errors.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import {
  collectionService,
  recordCollectionBodySchema,
} from '../services/orders/collection.service.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const orderIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ── Auth guard ────────────────────────────────────────────────────────────────

function requireCourier(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }
  if (req.user.user_type !== 'COURIER') {
    res.status(403).json(toApiError('FORBIDDEN', 'Solo repartidores pueden acceder a este recurso'));
    return;
  }
  next();
}

// ── Service type for injection ────────────────────────────────────────────────

type CollectionService = typeof collectionService;

// ── Router factory ────────────────────────────────────────────────────────────

export function createCourierCollectionRouter(service: CollectionService = collectionService): Router {
  const router = Router();

  router.use(requireCourier);
  router.use(requireIdempotencyKey);

  /**
   * POST /courier/orders/:id/initiate-collection
   *
   * Transiciona ARRIVED_AT_CUSTOMER al estado de cobro según payment_method:
   *   ELECTRONIC_ON_DELIVERY → PAYMENT_COLLECTION_PENDING
   *   CASH_ON_DELIVERY       → CASH_COLLECTION_PENDING
   */
  router.post('/orders/:id/initiate-collection', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const result = await service.initiateCollection(req.user!.client_id, req.user!.id, id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /courier/orders/:id/record-collection
   *
   * Registra cobro exitoso contra entrega.
   * Body (application/json):
   *   { amount, currency, method, electronic_submethod?, external_txn_id?, notes?, evidence_url? }
   *
   * NOTA (regla 4.1): RUTA solo registra el cobro como evidencia.
   * No transfiere ni custodia dinero.
   */
  router.post('/orders/:id/record-collection', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const input = recordCollectionBodySchema.parse(req.body);
      const result = await service.recordCollection(req.user!.client_id, req.user!.id, id, input);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /courier/orders/:id/record-failed-collection
   *
   * Registra fallo definitivo de cobro:
   *   PAYMENT_COLLECTION_PENDING → RETURN_TO_ORIGIN
   *   CASH_COLLECTION_PENDING   → CASH_PAYMENT_REJECTED → RETURN_TO_ORIGIN
   */
  router.post('/orders/:id/record-failed-collection', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const result = await service.recordFailedCollection(req.user!.client_id, req.user!.id, id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // Error handler local
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.statusCode).json(sendHttpError(err));
      return;
    }
    res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno'));
  });

  return router;
}

export const courierCollectionRouter = createCourierCollectionRouter();
