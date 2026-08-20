import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import {
  deliveryEmailService,
  deliveryEmailConfigSchema,
} from '../services/notifications/delivery_email.service.js';

/**
 * Avisos al comprador, autogestionados por el ADMIN_CLIENT.
 *
 * GET  /admin/notifications/delivery-email — remitente, asunto y mensaje
 * PUT  /admin/notifications/delivery-email — guardar
 *
 * La configuración vive en `client_parameters`, no en una tabla nueva: es
 * config por tenant y ese es el mecanismo del proyecto para eso.
 */
export function createAdminNotificationsRouter(service = deliveryEmailService): Router {
  const router = Router();

  router.use(requireAdminClient);

  router.get('/delivery-email', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await service.getConfig(req.user!.client_id));
    } catch (error) {
      next(error);
    }
  });

  router.put(
    '/delivery-email',
    requireIdempotencyKey,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const input = deliveryEmailConfigSchema.parse(req.body);
        res.json(await service.saveConfig(req.user!.client_id, input));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export const adminNotificationsRouter = createAdminNotificationsRouter();
