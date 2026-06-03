import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  ordersService,
  createOrderSchema,
  confirmOrderSchema,
  cancelOrderSchema,
  requestCancelSchema,
  orderListQuerySchema,
} from '../services/orders/orders.service.js';
import { refundsService } from '../services/refunds.service.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { toApiError } from '../lib/errors.js';
// F2.BACK-5: assertClientIsFull no aplica a rutas BUYER — un BUYER solo existe en cliente FULL

type OrdersService = typeof ordersService;

function requireBuyer(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }
  if (req.user.user_type !== 'BUYER') {
    res.status(403).json(toApiError('FORBIDDEN', 'Solo compradores pueden acceder a este recurso'));
    return;
  }
  next();
}

export function createBuyerOrdersRouter(service: OrdersService = ordersService): Router {
  const router = Router();

  router.use(requireBuyer);
  router.use(requireIdempotencyKey);

  // POST /buyer/orders — Crear pedido DRAFT con items
  // F2.BACK-5: Solo para Cliente Full; Cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = createOrderSchema.parse(req.body);
      const order = await service.create(req.user!.client_id, req.user!, input);
      res.status(201).json(order);
    } catch (error) {
      next(error);
    }
  });

  // GET /buyer/orders — Listar mis pedidos
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = orderListQuerySchema.parse(req.query);
      const result = await service.list(req.user!.client_id, req.user!, query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /buyer/orders/:id — Detalle del pedido
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId) || orderId <= 0) {
        res.status(400).json(toApiError('VALIDATION_ERROR', 'ID de pedido inválido'));
        return;
      }
      const order = await service.getById(req.user!.client_id, orderId, req.user!);
      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  // PATCH /buyer/orders/:id/confirm — Confirmar pedido (DRAFT → ORDER_SUBMITTED)
  router.patch('/:id/confirm', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId) || orderId <= 0) {
        res.status(400).json(toApiError('VALIDATION_ERROR', 'ID de pedido inválido'));
        return;
      }
      const input = confirmOrderSchema.parse(req.body);
      const order = await service.confirm(req.user!.client_id, orderId, req.user!, input);
      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  // POST /buyer/orders/:id/cancel — Cancelar pedido (estados pre-despacho)
  router.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId) || orderId <= 0) {
        res.status(400).json(toApiError('VALIDATION_ERROR', 'ID de pedido inválido'));
        return;
      }
      const input = cancelOrderSchema.parse(req.body);
      const order = await service.cancel(req.user!.client_id, orderId, req.user!, input);
      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  // POST /buyer/orders/:id/request-cancel — Solicitar cancelación post-despacho
  router.post('/:id/request-cancel', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId) || orderId <= 0) {
        res.status(400).json(toApiError('VALIDATION_ERROR', 'ID de pedido inválido'));
        return;
      }
      const input = requestCancelSchema.parse(req.body);
      const order = await service.requestCancel(req.user!.client_id, orderId, req.user!, input);
      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  // POST /buyer/orders/:id/confirm-receipt — Confirmar recepción (DELIVERED → CLOSED)
  router.post('/:id/confirm-receipt', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId) || orderId <= 0) {
        res.status(400).json(toApiError('VALIDATION_ERROR', 'ID de pedido inválido'));
        return;
      }
      const order = await service.confirmReceipt(req.user!.client_id, orderId, req.user!);
      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  // GET /buyer/orders/:id/refund — Estado del reembolso del pedido (Fase 3, Bloque 3.1)
  router.get('/:id/refund', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId) || orderId <= 0) {
        res.status(400).json(toApiError('VALIDATION_ERROR', 'ID de pedido inválido'));
        return;
      }
      // Verificar que el pedido pertenece al comprador
      const order = await service.getById(req.user!.client_id, orderId, req.user!);
      if (!order) {
        res.status(404).json(toApiError('RESOURCE_NOT_FOUND', 'Pedido no encontrado'));
        return;
      }
      // Retornar el refund_status del pedido y el detalle del reembolso si existe
      const result = await refundsService.getRefundForOrder(req.user!.client_id, orderId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const buyerOrdersRouter = createBuyerOrdersRouter();
