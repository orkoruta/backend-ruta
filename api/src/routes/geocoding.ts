import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { toApiError } from '../lib/errors.js';
import { geocodingService } from '../services/geocoding.service.js';

const geocodeQuerySchema = z.object({
  address: z.string().trim().min(3, 'La dirección es demasiado corta').max(300),
  region: z.string().length(2).optional(),
});

/** Solo el personal del Cliente puede geocodificar: cada consulta cuesta dinero. */
function requireStaff(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }
  const { user_type } = req.user;
  if (user_type !== 'ADMIN_CLIENT' && user_type !== 'OPERATOR_CLIENT' && user_type !== 'ADMIN_RUTA') {
    res.status(403).json(toApiError('FORBIDDEN', 'Acceso restringido al personal del Cliente'));
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

  router.get('/', requireStaff, async (req: Request, res: Response, next: NextFunction) => {
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
