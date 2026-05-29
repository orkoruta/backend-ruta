import { z } from 'zod';
import { ZodError } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { courierOpsService, attemptFailedSchema } from '../services/orders/courier_ops.service.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { toApiError } from '../lib/errors.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireCourier(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }
  if (req.user.user_type !== 'COURIER') {
    res.status(403).json(toApiError('FORBIDDEN', 'Solo repartidores pueden acceder a este recurso'));
    return;
  }
  next();
}

// ── Param schemas ─────────────────────────────────────────────────────────────

const orderIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ── Service type ──────────────────────────────────────────────────────────────

type CourierOpsService = typeof courierOpsService;

// ── Router factory ────────────────────────────────────────────────────────────

export function createCourierOrdersRouter(service: CourierOpsService = courierOpsService): Router {
  const router = Router();

  router.use(requireCourier);
  router.use(requireIdempotencyKey);

  // GET /courier/orders/assigned
  router.get("/orders/assigned", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.listAssignedOrders(req.user!.client_id, req.user!.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /courier/orders/:id
  router.get("/orders/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const order = await service.getOrderById(req.user!.client_id, id, req.user!.id);
      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  // POST /courier/orders/:id/start-shipping
  router.post("/orders/:id/start-shipping", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const order = await service.startShipping(req.user!.client_id, id, req.user!.id);
      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  // POST /courier/orders/:id/mark-out-for-delivery
  router.post("/orders/:id/mark-out-for-delivery", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const order = await service.markOutForDelivery(req.user!.client_id, id, req.user!.id);
      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  // POST /courier/orders/:id/arrive
  router.post("/orders/:id/arrive", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const order = await service.arrive(req.user!.client_id, id, req.user!.id);
      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  // POST /courier/orders/:id/mark-delivered
  router.post("/orders/:id/mark-delivered", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const order = await service.markDelivered(req.user!.client_id, id, req.user!.id);
      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  // POST /courier/orders/:id/attempt-failed
  router.post("/orders/:id/attempt-failed", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const { reason, notes } = attemptFailedSchema.parse(req.body);
      const order = await service.attemptFailed(req.user!.client_id, id, req.user!.id, reason, notes);
      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const courierOrdersRouter = createCourierOrdersRouter();

// ── Error handler (for test app usage) ───────────────────────────────────────

export function courierErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.statusCode).json(sendHttpError(err));
    return;
  }
  res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno'));
}
