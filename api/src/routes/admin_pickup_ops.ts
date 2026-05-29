/**
 * admin_pickup_ops.ts — 4.BACK-1
 *
 * Endpoints admin para el flujo PICKUP:
 *  POST /admin/orders/:id/verify-pickup-identity
 *  POST /admin/orders/:id/pickup-collection
 *  POST /admin/orders/:id/mark-pickup-delivered
 *
 * Accesibles por ADMIN_CLIENT y OPERATOR_CLIENT (y ADMIN_RUTA via Vista de Control).
 */

import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { toApiError } from '../lib/errors.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import {
  verifyBuyerIdentity,
  recordPickupCollection,
  markPickupDelivered,
} from '../services/orders/pickup_ops.service.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const orderIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const verifyPickupIdentityBodySchema = z.object({
  document_type: z.string().min(1, 'document_type es requerido'),
  document_number: z.string().min(1, 'document_number es requerido'),
});

const pickupCollectionBodySchema = z.object({
  amount: z.number().int().positive('El monto debe ser un entero positivo en COP'),
});

// ── Service type ──────────────────────────────────────────────────────────────

export interface PickupOpsService {
  verifyBuyerIdentity: typeof verifyBuyerIdentity;
  recordPickupCollection: typeof recordPickupCollection;
  markPickupDelivered: typeof markPickupDelivered;
}

const defaultService: PickupOpsService = {
  verifyBuyerIdentity,
  recordPickupCollection,
  markPickupDelivered,
};

// ── Auth guard ────────────────────────────────────────────────────────────────

function requireAdminOrOperatorClient(req: Request, res: Response, next: NextFunction): void {
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

// ── Router factory ────────────────────────────────────────────────────────────

export function createAdminPickupOpsRouter(service: PickupOpsService = defaultService): Router {
  const router = Router();

  router.use(requireIdempotencyKey);
  router.use(requireAdminOrOperatorClient);

  /**
   * POST /admin/orders/:id/verify-pickup-identity
   * Registra la verificación de identidad del comprador en el punto de recogida.
   */
  router.post(
    '/orders/:id/verify-pickup-identity',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = orderIdParamsSchema.parse(req.params);
        const body = verifyPickupIdentityBodySchema.parse(req.body);
        const result = await service.verifyBuyerIdentity(id, req.user!.client_id, req.user!, body);
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * POST /admin/orders/:id/pickup-collection
   * Registra cobro contra entrega realizado en el punto físico.
   */
  router.post(
    '/orders/:id/pickup-collection',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = orderIdParamsSchema.parse(req.params);
        const { amount } = pickupCollectionBodySchema.parse(req.body);
        const result = await service.recordPickupCollection(
          id,
          req.user!.client_id,
          req.user!,
          amount,
        );
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * POST /admin/orders/:id/mark-pickup-delivered
   * Transiciona el pedido de READY_FOR_PICKUP a DELIVERED.
   */
  router.post(
    '/orders/:id/mark-pickup-delivered',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = orderIdParamsSchema.parse(req.params);
        const result = await service.markPickupDelivered(id, req.user!.client_id, req.user!);
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  // Error handler for this router
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res
        .status(400)
        .json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
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
