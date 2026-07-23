import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { paymentConfigService, wompiConfigSchema } from '../services/payment_config.service.js';

/**
 * Config de la pasarela Wompi, autogestionada por el ADMIN_CLIENT.
 *
 * GET  /admin/payment-providers/wompi  — estado (secretos enmascarados)
 * PUT  /admin/payment-providers/wompi  — crear/actualizar credenciales
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

  return router;
}

export const adminPaymentConfigRouter = createAdminPaymentConfigRouter();
