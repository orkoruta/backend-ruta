import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { initiatePaymentSchema } from '@orkoruta/shared';
import { paymentsService } from '../services/payments.service.js';
import { requireAuth } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
// F2.BACK-5: assertClientIsFull no aplica a rutas BUYER — un BUYER solo existe en cliente FULL

const orderIdParamsSchema = z.object({
  id: z.coerce.bigint().positive(),
});

type PaymentsService = typeof paymentsService;

export function createBuyerPaymentRouter(service: PaymentsService = paymentsService): Router {
  const router = Router({ mergeParams: true });

  router.use(requireAuth);

  router.post(
    '/orders/:id/initiate-payment',
    requireIdempotencyKey,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (req.user!.user_type !== 'BUYER') {
          res.status(403).json({ code: 'FORBIDDEN', message: 'Solo los compradores pueden iniciar pagos' });
          return;
        }

        const { id } = orderIdParamsSchema.parse(req.params);
        const input = initiatePaymentSchema.parse(req.body);

        const result = await service.initiatePayment(id, req.user!, input.redirect_url);
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export const buyerPaymentRouter = createBuyerPaymentRouter();
