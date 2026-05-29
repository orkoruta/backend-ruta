import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  pickupPointsService,
  pickupPointListQuerySchema,
  createPickupPointSchema,
  updatePickupPointSchema,
  pickupPointIdParamsSchema,
} from '../services/pickup_points.service.js';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';

type PickupPointsService = typeof pickupPointsService;

function requestContext(req: Request) {
  return { user: req.user!, ip: req.ip, userAgent: req.header('user-agent') };
}

export function createAdminPickupPointsRouter(service: PickupPointsService = pickupPointsService): Router {
  const router = Router();

  // All admin pickup-points routes require at minimum ADMIN_CLIENT role
  router.use(requireAdminClient);
  router.use(requireIdempotencyKey);

  // GET / — list
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = pickupPointListQuerySchema.parse(req.query);
      res.json(await service.list(req.user!.client_id, query));
    } catch (error) { next(error); }
  });

  // POST / — create
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = createPickupPointSchema.parse(req.body);
      res.status(201).json(await service.create(req.user!.client_id, input, requestContext(req)));
    } catch (error) { next(error); }
  });

  // GET /:id — detail
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = pickupPointIdParamsSchema.parse(req.params);
      res.json(await service.getById(req.user!.client_id, id));
    } catch (error) { next(error); }
  });

  // PATCH /:id — update
  router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = pickupPointIdParamsSchema.parse(req.params);
      const input = updatePickupPointSchema.parse(req.body);
      res.json(await service.update(req.user!.client_id, id, input, requestContext(req)));
    } catch (error) { next(error); }
  });

  // POST /:id/activate
  router.post('/:id/activate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = pickupPointIdParamsSchema.parse(req.params);
      res.json(await service.activate(req.user!.client_id, id, requestContext(req)));
    } catch (error) { next(error); }
  });

  // POST /:id/deactivate
  router.post('/:id/deactivate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = pickupPointIdParamsSchema.parse(req.params);
      res.json(await service.deactivate(req.user!.client_id, id, requestContext(req)));
    } catch (error) { next(error); }
  });

  return router;
}

export const adminPickupPointsRouter = createAdminPickupPointsRouter();
