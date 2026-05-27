import { Router, type Request, type Response, type NextFunction } from 'express';
import { presignedUrlSchema } from '@orkoruta/shared';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';

export function createUploadsRouter(): Router {
  const router = Router();

  router.use(requireAdminClient);
  router.use(requireIdempotencyKey);

  router.post('/presigned-url', async (req: Request, res: Response, next: NextFunction) => {
    try {
      presignedUrlSchema.parse(req.body);
      // File storage provider is TBD — return 501 until implemented
      res.status(501).json({
        code: 'NOT_IMPLEMENTED',
        message: 'Servicio de almacenamiento de archivos pendiente de configuración',
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const uploadsRouter = createUploadsRouter();
