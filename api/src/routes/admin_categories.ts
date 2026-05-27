import { Router, type Request, type Response, type NextFunction } from 'express';
import { createCategorySchema } from '@orkoruta/shared';
import {
  categoriesService,
  categoryListQuerySchema,
  updateCategorySchema,
  categoryIdParamsSchema,
} from '../services/categories.service.js';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';

type CategoriesService = typeof categoriesService;

function requestContext(req: Request) {
  return {
    user: req.user!,
    ip: req.ip,
    userAgent: req.header('user-agent'),
  };
}

function getClientId(req: Request): number {
  return req.user!.client_id;
}

export function createAdminCategoriesRouter(service: CategoriesService = categoriesService): Router {
  const router = Router();

  router.use(requireAdminClient);
  router.use(requireIdempotencyKey);

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = categoryListQuerySchema.parse(req.query);
      res.json(await service.list(getClientId(req), query));
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = createCategorySchema.parse(req.body);
      res.status(201).json(await service.create(getClientId(req), input, requestContext(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:category_id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { category_id } = categoryIdParamsSchema.parse(req.params);
      res.json(await service.getById(getClientId(req), category_id));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:category_id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { category_id } = categoryIdParamsSchema.parse(req.params);
      const input = updateCategorySchema.parse(req.body);
      res.json(await service.update(getClientId(req), category_id, input, requestContext(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:category_id/activate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { category_id } = categoryIdParamsSchema.parse(req.params);
      res.json(await service.activate(getClientId(req), category_id, requestContext(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:category_id/deactivate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { category_id } = categoryIdParamsSchema.parse(req.params);
      res.json(await service.deactivate(getClientId(req), category_id, requestContext(req)));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminCategoriesRouter = createAdminCategoriesRouter();
