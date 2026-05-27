import { Router, type Request, type Response, type NextFunction } from 'express';
import { createClientSchema, clientIdParamsSchema } from '@orkoruta/shared';
import {
  clientsService,
  clientListQuerySchema,
  updateClientSchema,
} from '../services/clients.service.js';
import { requireAdminRuta } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';

type ClientsService = typeof clientsService;

function requestContext(req: Request) {
  return {
    user: req.user!,
    ip: req.ip,
    userAgent: req.header('user-agent'),
  };
}

export function createRutaAdminClientsRouter(service: ClientsService = clientsService): Router {
  const router = Router();

  router.use(requireAdminRuta);
  router.use(requireIdempotencyKey);

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = clientListQuerySchema.parse(req.query);
      res.json(await service.list(query));
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = createClientSchema.parse(req.body);
      const client = await service.create(input, requestContext(req));
      res.status(201).json(client);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:client_id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { client_id } = clientIdParamsSchema.parse(req.params);
      res.json(await service.getById(client_id));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:client_id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { client_id } = clientIdParamsSchema.parse(req.params);
      const input = updateClientSchema.parse(req.body);
      res.json(await service.update(client_id, input, requestContext(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:client_id/activate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { client_id } = clientIdParamsSchema.parse(req.params);
      res.json(await service.activate(client_id, requestContext(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:client_id/deactivate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { client_id } = clientIdParamsSchema.parse(req.params);
      res.json(await service.deactivate(client_id, requestContext(req)));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:client_id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { client_id } = clientIdParamsSchema.parse(req.params);
      await service.purge(client_id, requestContext(req));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const rutaAdminClientsRouter = createRutaAdminClientsRouter();
