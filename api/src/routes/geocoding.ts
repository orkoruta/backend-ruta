import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { toApiError } from '../lib/errors.js';
import { geocodingService } from '../services/geocoding.service.js';

const geocodeQuerySchema = z.object({
  address: z.string().trim().min(3, 'La dirección es demasiado corta').max(300),
  region: z.string().length(2).optional(),
});

/**
 * Cada consulta a Google cuesta, así que se exige sesión: nunca queda abierto a
 * internet. Además del personal del Cliente, el COMPRADOR puede geocodificar su
 * propia dirección de entrega en el checkout — sin esto el mapa del storefront
 * no ubica lo que el comprador escribe. El costo se acota con el debounce del
 * frontend y la caché de 24 h del servicio.
 */
const GEOCODE_ROLES = new Set(['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'BUYER']);

function requireGeocodeAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }
  if (!GEOCODE_ROLES.has(req.user.user_type)) {
    res.status(403).json(toApiError('FORBIDDEN', 'Acceso restringido'));
    return;
  }
  next();
}

/**
 * GET /geocode?address=...
 *
 * Proxy de la Geocoding API de Google. Existe para que la clave viva en el
 * servidor: Google solo acota las claves de web service por IP, así que en el
 * navegador sería inacotable.
 */
export function createGeocodingRouter(service = geocodingService): Router {
  const router = Router();

  router.get('/', requireGeocodeAccess, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address, region } = geocodeQuerySchema.parse(req.query);
      const result = await service.geocode(address, region);
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
