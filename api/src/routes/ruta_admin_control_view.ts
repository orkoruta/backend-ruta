import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { controlViewService } from '../services/control_view.service.js';
import { requireAdminRuta } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { toApiError } from '../lib/errors.js';

type ControlViewService = typeof controlViewService;

const enterControlViewSchema = z.object({
  target_client_id: z.number().int().positive(),
  master_password: z.string().min(1),
  reason: z.string().max(500).optional(),
});

function requestContext(req: Request) {
  return {
    ip: req.ip,
    userAgent: req.header('user-agent'),
  };
}

/**
 * requireAdminRutaAny — allows ADMIN_RUTA in both normal mode (client_id=0)
 * and impersonation mode (client_id=targetClientId). Used for exit which needs
 * to work with the impersonating token.
 */
function requireAdminRutaAny(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }
  if (req.user.user_type !== 'ADMIN_RUTA') {
    res.status(403).json(toApiError('FORBIDDEN', 'Requiere rol ADMIN_RUTA'));
    return;
  }
  next();
}

export function createControlViewRouter(service: ControlViewService = controlViewService): Router {
  const router = Router();

  // POST /ruta-admin/control-view/enter
  // Requires: ADMIN_RUTA (non-impersonating, client_id=0) + master password
  router.post('/enter', requireAdminRuta, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = enterControlViewSchema.parse(req.body);
      const result = await service.enterControlView(
        req.user!,
        {
          targetClientId: input.target_client_id,
          masterPassword: input.master_password,
          reason: input.reason,
        },
        requestContext(req)
      );

      res.json({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        target_client: result.targetClient,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /ruta-admin/control-view/exit
  // Requires: ADMIN_RUTA (any mode, including impersonating) + idempotency key
  router.post('/exit', requireAdminRutaAny, requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await service.exitControlView(req.user!, requestContext(req));
      res.status(200).json({ message: 'Vista de Control cerrada correctamente' });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const controlViewRouter = createControlViewRouter();
