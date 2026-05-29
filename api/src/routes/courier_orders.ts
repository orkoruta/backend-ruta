import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { courierOrdersService, courierOrdersQuerySchema, failedAttemptSchema } from '../services/orders/courier_orders.service.js';
import { collectionService, recordCollectionSchema } from '../services/orders/collection.service.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { toApiError } from '../lib/errors.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

export function createCourierOrdersRouter(): Router {
  const router = Router();

  router.use(requireCourier);

  // GET /courier/me — perfil del courier autenticado
  router.get('/me', (req: Request, res: Response) => {
    res.json({ user_id: req.user!.id, user_type: req.user!.user_type, client_id: req.user!.client_id });
  });

  // GET /courier/orders/assigned — lista de pedidos
  router.get('/orders/assigned', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = courierOrdersQuerySchema.parse(req.query);
      const result = await courierOrdersService.getCourierOrders(req.user!.client_id, req.user!.id, query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /courier/orders/:id — detalle de un pedido
  router.get('/orders/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId)) {
        res.status(400).json(toApiError('VALIDATION_ERROR', 'ID de pedido inválido'));
        return;
      }
      const order = await courierOrdersService.getCourierOrderById(req.user!.client_id, req.user!.id, orderId);
      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  // POST /courier/orders/:id/start-shipping
  router.post('/orders/:id/start-shipping', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId)) { res.status(400).json(toApiError('VALIDATION_ERROR', 'ID inválido')); return; }
      const order = await courierOrdersService.startShipping(req.user!.client_id, req.user!.id, orderId);
      res.json(order);
    } catch (error) { next(error); }
  });

  // POST /courier/orders/:id/mark-out-for-delivery
  router.post('/orders/:id/mark-out-for-delivery', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId)) { res.status(400).json(toApiError('VALIDATION_ERROR', 'ID inválido')); return; }
      const order = await courierOrdersService.markOutForDelivery(req.user!.client_id, req.user!.id, orderId);
      res.json(order);
    } catch (error) { next(error); }
  });

  // POST /courier/orders/:id/arrive
  router.post('/orders/:id/arrive', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId)) { res.status(400).json(toApiError('VALIDATION_ERROR', 'ID inválido')); return; }
      const order = await courierOrdersService.arrive(req.user!.client_id, req.user!.id, orderId);
      res.json(order);
    } catch (error) { next(error); }
  });

  // POST /courier/orders/:id/record-collection (multipart)
  router.post('/orders/:id/record-collection', requireIdempotencyKey, upload.single('evidence'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId)) { res.status(400).json(toApiError('VALIDATION_ERROR', 'ID inválido')); return; }
      const input = recordCollectionSchema.parse(req.body);
      const result = await collectionService.recordCollection(req.user!.client_id, req.user!.id, orderId, input, req.file);
      res.json(result);
    } catch (error) { next(error); }
  });

  // POST /courier/orders/:id/mark-delivered
  router.post('/orders/:id/mark-delivered', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId)) { res.status(400).json(toApiError('VALIDATION_ERROR', 'ID inválido')); return; }
      const order = await courierOrdersService.markDelivered(req.user!.client_id, req.user!.id, orderId);
      res.json(order);
    } catch (error) { next(error); }
  });

  // POST /courier/orders/:id/attempt-failed
  router.post('/orders/:id/attempt-failed', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId)) { res.status(400).json(toApiError('VALIDATION_ERROR', 'ID inválido')); return; }
      const input = failedAttemptSchema.parse(req.body);
      const order = await courierOrdersService.recordFailedAttempt(req.user!.client_id, req.user!.id, orderId, input);
      res.json(order);
    } catch (error) { next(error); }
  });

  // POST /courier/orders/:id/return-to-origin
  router.post('/orders/:id/return-to-origin', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId)) { res.status(400).json(toApiError('VALIDATION_ERROR', 'ID inválido')); return; }
      const order = await courierOrdersService.returnToOrigin(req.user!.client_id, req.user!.id, orderId);
      res.json(order);
    } catch (error) { next(error); }
  });

  // POST /courier/orders/:id/upload-evidence (stub Sprint 6)
  router.post('/orders/:id/upload-evidence', requireIdempotencyKey, upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'File storage pendiente de implementar en Sprint 6' });
    } catch (error) { next(error); }
  });

  return router;
}

export const courierOrdersRouter = createCourierOrdersRouter();
