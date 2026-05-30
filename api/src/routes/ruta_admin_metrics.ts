import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAdminRuta } from '../middleware/auth.js';
import { globalMetricsService } from '../services/global_metrics.service.js';

type GlobalMetricsService = typeof globalMetricsService;

export function createRutaAdminMetricsRouter(service: GlobalMetricsService = globalMetricsService): Router {
  const router = Router();

  router.use(requireAdminRuta);

  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const metrics = await service.getGlobalMetrics();
      res.json(metrics);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const rutaAdminMetricsRouter = createRutaAdminMetricsRouter();
