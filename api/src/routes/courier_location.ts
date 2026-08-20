import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  courierLocationService,
  courierLocationSchema,
  notTrackable,
} from '../services/orders/courier_location.service.js';
import { toApiError } from '../lib/errors.js';

/**
 * Seguimiento del repartidor en el mapa.
 *
 * POST /courier/location            — el repartidor reporta dónde está
 * GET  /buyer/orders/:id/courier-location — el comprador consulta la de su pedido
 *
 * El reporte **no** exige `X-Idempotency-Key`, a diferencia del resto de
 * mutaciones: es un latido que llega cada pocos segundos y cuyo efecto es
 * sobrescribir un valor, no crear nada. Reintentarlo es inofensivo y guardar
 * una clave por latido llenaría `idempotency_keys` sin ganar nada.
 */

function requireCourier(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }
  if (req.user.user_type !== 'COURIER') {
    res.status(403).json(toApiError('FORBIDDEN', 'Solo repartidores pueden reportar ubicación'));
    return;
  }
  next();
}

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

export function createCourierLocationRouter(service = courierLocationService): Router {
  const router = Router();

  router.post('/location', requireCourier, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = courierLocationSchema.parse(req.body ?? {});
      const result = await service.reportLocation(req.user!.client_id, req.user!.id, input);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function createBuyerTrackingRouter(service = courierLocationService): Router {
  const router = Router();

  router.get(
    '/:id/courier-location',
    requireBuyer,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orderId = Number(req.params.id);
        if (!Number.isInteger(orderId) || orderId <= 0) throw notTrackable();

        const location = await service.getLocationForBuyer(
          req.user!.client_id,
          orderId,
          req.user!.id,
        );
        // `null` cubre varios casos (pedido ajeno, fuera de reparto, sin
        // posición). Se responden todos igual a propósito: distinguirlos
        // permitiría sondear pedidos de otros compradores.
        if (!location) throw notTrackable();

        res.json(location);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export const courierLocationRouter = createCourierLocationRouter();
export const buyerTrackingRouter = createBuyerTrackingRouter();
