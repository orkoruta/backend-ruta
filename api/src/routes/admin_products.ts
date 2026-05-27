import { Router, type Request, type Response, type NextFunction } from 'express';
import { createProductSchema } from '@orkoruta/shared';
import {
  productsService,
  productListQuerySchema,
  updateProductSchema,
  productIdParamsSchema,
} from '../services/products.service.js';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';

type ProductsService = typeof productsService;

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

export function createAdminProductsRouter(service: ProductsService = productsService): Router {
  const router = Router();

  router.use(requireAdminClient);
  router.use(requireIdempotencyKey);

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = productListQuerySchema.parse(req.query);
      res.json(await service.list(getClientId(req), query));
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = createProductSchema.parse(req.body);
      res.status(201).json(await service.create(getClientId(req), input, requestContext(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:product_id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { product_id } = productIdParamsSchema.parse(req.params);
      res.json(await service.getById(getClientId(req), product_id));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:product_id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { product_id } = productIdParamsSchema.parse(req.params);
      const input = updateProductSchema.parse(req.body);
      res.json(await service.update(getClientId(req), product_id, input, requestContext(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:product_id/activate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { product_id } = productIdParamsSchema.parse(req.params);
      res.json(await service.activate(getClientId(req), product_id, requestContext(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:product_id/deactivate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { product_id } = productIdParamsSchema.parse(req.params);
      res.json(await service.deactivate(getClientId(req), product_id, requestContext(req)));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminProductsRouter = createAdminProductsRouter();
