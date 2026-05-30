import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAdminClient } from '../middleware/auth.js';
import { metricsService } from '../services/metrics.service.js';

type MetricsService = typeof metricsService;

export function createAdminMetricsRouter(service: MetricsService = metricsService): Router {
  const router = Router();

  router.use(requireAdminClient);

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientId = req.user!.client_id;
      const metrics = await service.getClientMetrics(clientId);
      res.json(metrics);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminMetricsRouter = createAdminMetricsRouter();
