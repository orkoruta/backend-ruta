import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  buyersService,
  buyerListQuerySchema,
  createBuyerSchema,
  updateBuyerSchema,
  buyerIdParamsSchema,
} from '../services/buyers.service.js';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';

type BuyersService = typeof buyersService;

function requestContext(req: Request) {
  return { user: req.user!, ip: req.ip, userAgent: req.header('user-agent') };
}

export function createAdminBuyersRouter(service: BuyersService = buyersService): Router {
  const router = Router();

  router.use(requireAdminClient);
  router.use(requireIdempotencyKey);

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = buyerListQuerySchema.parse(req.query);
      res.json(await service.list(req.user!.client_id, query));
    } catch (error) { next(error); }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = createBuyerSchema.parse(req.body);
      res.status(201).json(await service.create(req.user!.client_id, input, requestContext(req)));
    } catch (error) { next(error); }
  });

  router.get('/:buyer_user_id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { buyer_user_id } = buyerIdParamsSchema.parse(req.params);
      res.json(await service.getById(req.user!.client_id, buyer_user_id));
    } catch (error) { next(error); }
  });

  router.patch('/:buyer_user_id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { buyer_user_id } = buyerIdParamsSchema.parse(req.params);
      const input = updateBuyerSchema.parse(req.body);
      res.json(await service.update(req.user!.client_id, buyer_user_id, input, requestContext(req)));
    } catch (error) { next(error); }
  });

  router.post('/:buyer_user_id/activate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { buyer_user_id } = buyerIdParamsSchema.parse(req.params);
      res.json(await service.activate(req.user!.client_id, buyer_user_id, requestContext(req)));
    } catch (error) { next(error); }
  });

  router.post('/:buyer_user_id/deactivate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { buyer_user_id } = buyerIdParamsSchema.parse(req.params);
      res.json(await service.deactivate(req.user!.client_id, buyer_user_id, requestContext(req)));
    } catch (error) { next(error); }
  });

  return router;
}

export const adminBuyersRouter = createAdminBuyersRouter();
