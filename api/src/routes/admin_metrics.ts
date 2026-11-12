import { Router, type Request, type Response, type NextFunction } from 'express';
import { toApiError } from '../lib/errors.js';
import { metricsService } from '../services/metrics.service.js';
import {
  operationsDashboardService,
  operationsDashboardQuerySchema,
} from '../services/operations_dashboard.service.js';

type MetricsService = Pick<typeof metricsService, 'getClientMetrics'>;
type OperationsDashboardService = Pick<typeof operationsDashboardService, 'getOperations'>;

/**
 * El dashboard del Cliente lo ven ADMIN_CLIENT y OPERATOR_CLIENT (matriz de
 * permisos §15); ADMIN_RUTA entra por Vista de Control.
 */
function requireClientStaff(req: Request, res: Response, next: NextFunction): void {
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

export function createAdminMetricsRouter(
  service: MetricsService = metricsService,
  dashboard: OperationsDashboardService = operationsDashboardService,
): Router {
  const router = Router();

  router.use(requireClientStaff);

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientId = req.user!.client_id;
      const metrics = await service.getClientMetrics(clientId);
      res.json(metrics);
    } catch (error) {
      next(error);
    }
  });

  // GET /admin/metrics/operations — por entregar y entregados en un rango.
  router.get('/operations', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = operationsDashboardQuerySchema.parse(req.query);
      res.json(await dashboard.getOperations(req.user!.client_id, query));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminMetricsRouter = createAdminMetricsRouter();
