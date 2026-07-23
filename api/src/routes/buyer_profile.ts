import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { toApiError } from '../lib/errors.js';
import { HttpError } from '../lib/http_error.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';

/**
 * Perfil del comprador autenticado. El contrato ya listaba `GET /buyer/me` pero
 * no estaba implementado; el storefront lo necesita para saludar por nombre y
 * saber si hay sesión sin depender de datos guardados en el navegador.
 *
 * `is_guest` marca las sesiones de invitado (comprador sin cuenta, creado por
 * `POST /auth/guest`), que se distinguen por su `external_buyer_id` con prefijo
 * `guest-`. El storefront lo usa para ocultarle "Mis pedidos" y la recurrencia.
 */

const updateProfileSchema = z.object({
  full_name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().min(1).max(50).optional(),
});

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

function isGuest(externalBuyerId: string | null): boolean {
  return Boolean(externalBuyerId && externalBuyerId.startsWith('guest-'));
}

export function createBuyerProfileRouter(): Router {
  const router = Router();

  router.use(requireBuyer);

  // GET /buyer/me — perfil del comprador autenticado
  router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientId = req.user!.client_id;
      const userId = req.user!.id;

      const user = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
        tx.users.findUnique({
          where: { id_client_id: { id: BigInt(userId), client_id: BigInt(clientId) } },
          select: { id: true, full_name: true, email: true, phone: true, external_buyer_id: true },
        }),
      );

      if (!user) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Comprador no encontrado');
      }

      res.json({
        id: Number(user.id),
        full_name: user.full_name,
        email: user.email,
        phone: user.phone,
        is_guest: isGuest(user.external_buyer_id),
      });
    } catch (error) {
      next(error);
    }
  });

  // PATCH /buyer/me — actualizar nombre y teléfono. El invitado lo usa para
  // registrar su contacto al hacer el pedido (no tiene una cuenta con esos datos).
  router.patch('/me', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientId = req.user!.client_id;
      const userId = req.user!.id;
      const input = updateProfileSchema.parse(req.body);

      const user = await withTenant(clientId, 'BUYER', (tx) =>
        tx.users.update({
          where: { id_client_id: { id: BigInt(userId), client_id: BigInt(clientId) } },
          data: {
            ...(input.full_name !== undefined ? { full_name: input.full_name } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            updated_at: new Date(),
          },
          select: { id: true, full_name: true, email: true, phone: true, external_buyer_id: true },
        }),
      );

      res.json({
        id: Number(user.id),
        full_name: user.full_name,
        email: user.email,
        phone: user.phone,
        is_guest: isGuest(user.external_buyer_id),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const buyerProfileRouter = createBuyerProfileRouter();
