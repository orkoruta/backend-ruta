import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { prisma, withTenant, withTenantReadOnly } from '@orkoruta/db';
import { wompiWebhookEventSchema, PaymentStatus } from '@orkoruta/shared';
import { toApiError } from '../lib/errors.js';
import { WompiClient } from '../lib/wompi_client.js';

const pathParamsSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  provider_id: z.coerce.bigint().positive(),
});

function mapWompiStatus(wompiStatus: string): string {
  switch (wompiStatus) {
    case 'APPROVED':
      return PaymentStatus.PAID;
    case 'DECLINED':
    case 'VOIDED':
      return PaymentStatus.PAYMENT_FAILED_RETRYABLE;
    case 'ERROR':
    default:
      return PaymentStatus.PAYMENT_REJECTED_FINAL;
  }
}

export function createWebhooksRouter(): Router {
  const router = Router();

  router.post(
    '/wompi/:client_id/:provider_id',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { client_id, provider_id } = pathParamsSchema.parse(req.params);

        const rawBody: string = Buffer.isBuffer(req.body)
          ? req.body.toString('utf8')
          : typeof req.body === 'string'
            ? req.body
            : JSON.stringify(req.body);

        const signatureHeader = req.header('X-Event-Checksum') ?? '';

        const provider = await withTenantReadOnly(client_id, 'ADMIN_RUTA', (tx) =>
          tx.client_payment_providers.findUnique({
            where: { id_client_id: { id: provider_id, client_id: BigInt(client_id) } },
            select: { id: true, webhook_secret: true, status: true },
          })
        );

        if (!provider || provider.status !== 'ACTIVE') {
          res.status(404).json(toApiError('RESOURCE_NOT_FOUND', 'Proveedor de pago no encontrado'));
          return;
        }

        const wompi = new WompiClient({
          publicKey: '',
          privateKey: '',
          webhookSecret: provider.webhook_secret ?? '',
          sandbox: process.env.NODE_ENV !== 'production',
        });

        if (!wompi.verifySignature(rawBody, signatureHeader)) {
          res.status(400).json(toApiError('WEBHOOK_SIGNATURE_INVALID', 'Firma del webhook inválida'));
          return;
        }

        let parsedPayload: z.infer<typeof wompiWebhookEventSchema>;
        try {
          parsedPayload = wompiWebhookEventSchema.parse(JSON.parse(rawBody));
        } catch {
          res.status(400).json(toApiError('VALIDATION_ERROR', 'Payload del webhook inválido'));
          return;
        }

        const { transaction } = parsedPayload.data;
        const providerEventId = transaction.id;

        const existing = await prisma.external_webhook_events.findUnique({
          where: {
            payment_provider_id_provider_event_id: {
              payment_provider_id: provider_id,
              provider_event_id: providerEventId,
            },
          },
          select: { id: true },
        });

        if (existing) {
          res.json({ received: true });
          return;
        }

        const reference = transaction.reference;

        const order = reference
          ? await withTenantReadOnly(client_id, 'ADMIN_RUTA', (tx) =>
              tx.orders.findFirst({
                where: { client_id: BigInt(client_id), external_payment_reference: reference },
                select: { id: true, client_id: true, payment_status: true },
              })
            )
          : null;

        const newPaymentStatus = mapWompiStatus(transaction.status);

        await withTenant(client_id, 'ADMIN_RUTA', async (tx) => {
          await tx.external_webhook_events.create({
            data: {
              client_id: BigInt(client_id),
              payment_provider_id: provider_id,
              provider_event_id: providerEventId,
              payload: JSON.parse(rawBody) as object,
              signature_valid: true,
              processing_result: newPaymentStatus,
              related_order_id: order?.id ?? null,
              processed_at: new Date(),
            },
          });

          if (order) {
            await tx.orders.update({
              where: { id_client_id: { id: order.id, client_id: order.client_id } },
              data: { payment_status: newPaymentStatus },
            });

            if (transaction.status === 'APPROVED') {
              await tx.payments.updateMany({
                where: {
                  client_id: order.client_id,
                  order_id: order.id,
                  status: 'PENDING',
                  external_payment_reference: reference,
                },
                data: {
                  status: 'CONFIRMED',
                  external_transaction_id: providerEventId,
                  technical_confirmation_at: new Date(),
                },
              });
            }
          }
        });

        res.json({ received: true });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export const webhooksRouter = createWebhooksRouter();
