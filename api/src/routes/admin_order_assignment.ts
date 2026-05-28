import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { toApiError } from '../lib/errors.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import {
  courierAssignmentService,
  assignCourierSchema,
} from '../services/orders/courier_assignment.service.js';
import { ZodError } from 'zod';

// ── Schemas ───────────────────────────────────────────────────────────────────

const orderIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

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

// ── Service type ──────────────────────────────────────────────────────────────

type CourierAssignmentService = typeof courierAssignmentService;

// ── Router factory ────────────────────────────────────────────────────────────

export function createAdminOrderAssignmentRouter(
  service: CourierAssignmentService = courierAssignmentService,
): Router {
  const router = Router();

  router.use(requireIdempotencyKey);
  router.use(requireAdminOrOperator);

  // GET /admin/orders/map — geolocated orders pending assignment
  router.get('/orders/map', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orders = await service.getOrdersForMap(req.user!.client_id);
      res.json({ data: orders });
    } catch (error) {
      next(error);
    }
  });

  // GET /admin/orders/:id/available-couriers
  router.get('/orders/:id/available-couriers', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const couriers = await service.getAvailableCouriers(req.user!.client_id);
      res.json({ data: couriers });
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/orders/:id/assign-courier — body: { courier_user_id }
  router.post('/orders/:id/assign-courier', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const { courier_user_id } = assignCourierSchema.parse(req.body);
      const result = await service.assignCourier(req.user!.client_id, id, courier_user_id, req.user!);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/orders/:id/unassign-courier
  router.post('/orders/:id/unassign-courier', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const result = await service.unassignCourier(req.user!.client_id, id, req.user!);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

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

export const adminOrderAssignmentRouter = createAdminOrderAssignmentRouter();
