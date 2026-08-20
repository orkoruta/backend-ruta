import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import {
  paymentConfigService,
  wompiConfigSchema,
  nequiConfigSchema,
} from '../services/payment_config.service.js';

/**
 * Config de los medios de pago, autogestionada por el ADMIN_CLIENT.
 *
 * GET  /admin/payment-providers/wompi  — estado (secretos enmascarados)
 * PUT  /admin/payment-providers/wompi  — crear/actualizar credenciales
 * GET  /admin/payment-providers/nequi  — link de pago de Nequi Negocios
 * PUT  /admin/payment-providers/nequi  — crear/actualizar el link
 *
 * El link de Nequi no se enmascara: es una URL pensada para compartirse.
 */
export function createAdminPaymentConfigRouter(service = paymentConfigService): Router {
  const router = Router();

  router.use(requireAdminClient);

  router.get('/wompi', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await service.getWompiConfig(req.user!.client_id));
    } catch (error) {
      next(error);
    }
  });

  router.put(
    '/wompi',
    requireIdempotencyKey,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const input = wompiConfigSchema.parse(req.body);
        res.json(await service.upsertWompiConfig(req.user!.client_id, input));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/nequi', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await service.getNequiConfig(req.user!.client_id));
    } catch (error) {
      next(error);
    }
  });

  router.put(
    '/nequi',
    requireIdempotencyKey,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const input = nequiConfigSchema.parse(req.body);
        res.json(await service.upsertNequiConfig(req.user!.client_id, input));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export const adminPaymentConfigRouter = createAdminPaymentConfigRouter();
