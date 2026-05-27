import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  couriersService,
  courierListQuerySchema,
  updateCourierSchema,
  courierIdParamsSchema,
} from '../services/couriers.service.js';
import { createCourierSchema } from '@orkoruta/shared';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';

type CouriersService = typeof couriersService;

function requestContext(req: Request) {
  return { user: req.user!, ip: req.ip, userAgent: req.header('user-agent') };
}

export function createAdminCouriersRouter(service: CouriersService = couriersService): Router {
  const router = Router();

  router.use(requireAdminClient);
  router.use(requireIdempotencyKey);

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = courierListQuerySchema.parse(req.query);
      res.json(await service.list(req.user!.client_id, query));
    } catch (error) { next(error); }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = createCourierSchema.parse(req.body);
      res.status(201).json(await service.create(req.user!.client_id, input, requestContext(req)));
    } catch (error) { next(error); }
  });

  router.get('/:courier_user_id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { courier_user_id } = courierIdParamsSchema.parse(req.params);
      res.json(await service.getById(req.user!.client_id, courier_user_id));
    } catch (error) { next(error); }
  });

  router.patch('/:courier_user_id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { courier_user_id } = courierIdParamsSchema.parse(req.params);
      const input = updateCourierSchema.parse(req.body);
      res.json(await service.update(req.user!.client_id, courier_user_id, input, requestContext(req)));
    } catch (error) { next(error); }
  });

  router.post('/:courier_user_id/activate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { courier_user_id } = courierIdParamsSchema.parse(req.params);
      res.json(await service.activate(req.user!.client_id, courier_user_id, requestContext(req)));
    } catch (error) { next(error); }
  });

  router.post('/:courier_user_id/deactivate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { courier_user_id } = courierIdParamsSchema.parse(req.params);
      res.json(await service.deactivate(req.user!.client_id, courier_user_id, requestContext(req)));
    } catch (error) { next(error); }
  });

  return router;
}

export const adminCouriersRouter = createAdminCouriersRouter();
