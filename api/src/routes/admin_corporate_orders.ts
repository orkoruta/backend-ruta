/**
 * admin_corporate_orders.ts — Rutas admin para pedidos corporativos (Fase 3, Bloque 5.2)
 *
 * Endpoints:
 *   POST /admin/orders/corporate             — crear nuevo pedido corporativo (DRAFT)
 *   POST /admin/orders/corporate/recurring   — crear corporativo recurrente (DRAFT + plantilla)
 *   POST /admin/orders/corporate/repeat-last — repetir último corporativo del comprador
 *
 * Actores: ADMIN_CLIENT, OPERATOR_CLIENT, ADMIN_RUTA.
 * Solo Cliente Full. Cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { toApiError } from '../lib/errors.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import {
  corporateOrdersService,
  createCorporateOrderSchema,
  createCorporateOrderRecurringSchema,
} from '../services/corporate_orders.service.js';
import { z } from 'zod';

// ── Auth guard ────────────────────────────────────────────────────────────────

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

// ── Schemas ───────────────────────────────────────────────────────────────────

const repeatLastBodySchema = z.object({
  buyer_id: z.number().int().positive(),
});

// ── Router factory ────────────────────────────────────────────────────────────

type CorporateOrdersService = typeof corporateOrdersService;

export function createAdminCorporateOrdersRouter(
  svc: CorporateOrdersService = corporateOrdersService,
): Router {
  const router = Router();

  router.use(requireAdminOrOperator);

  /**
   * POST /admin/orders/corporate
   * Crea un pedido corporativo en DRAFT.
   */
  router.post(
    '/corporate',
    requireIdempotencyKey,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const input = createCorporateOrderSchema.parse(req.body);
        const order = await svc.createCorporateOrder(req.user!.client_id, input, req.user!);
        res.status(201).json(order);
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * POST /admin/orders/corporate/recurring
   * Crea un pedido corporativo recurrente: DRAFT + plantilla de recurrencia.
   */
  router.post(
    '/corporate/recurring',
    requireIdempotencyKey,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const input = createCorporateOrderRecurringSchema.parse(req.body);
        const result = await svc.createCorporateOrderRecurring(req.user!.client_id, input, req.user!);
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * POST /admin/orders/corporate/repeat-last
   * Repite el último pedido CORPORATE del comprador indicado.
   * Body: { buyer_id }
   */
  router.post(
    '/corporate/repeat-last',
    requireIdempotencyKey,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { buyer_id } = repeatLastBodySchema.parse(req.body);
        const order = await svc.repeatLastCorporateOrder(req.user!.client_id, buyer_id, req.user!);
        res.status(201).json(order);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export const adminCorporateOrdersRouter = createAdminCorporateOrdersRouter();
