import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { prisma, withTenant, withTenantReadOnly } from '@orkoruta/db';
import { wompiWebhookEventSchema, PaymentStatus } from '@orkoruta/shared';
import { toApiError } from '../lib/errors.js';
import { WompiClient } from '../lib/wompi_client.js';
import { refundsService } from '../services/refunds.service.js';
import { logger } from '../lib/logger.js';

const pathParamsSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  provider_id: z.coerce.bigint().positive(),
});

// Schema especulativo para webhooks de reembolso de Wompi (Fase 3, F3.B1.2.BACK-2)
// Wompi Colombia puede no tener API de reembolso; este schema se activa si la tienen.
export const wompiRefundWebhookEventSchema = z.object({
  event: z.enum(['refund.updated', 'refund_confirmed', 'refund_failed']),
  data: z.object({
    refund: z.object({
      id: z.string(),
      status: z.enum(['APPROVED', 'DECLINED', 'ERROR']),
      transaction_id: z.string(),
      amount_in_cents: z.number().int().positive(),
    }),
  }),
  timestamp: z.number().int().positive().optional(),
  environment: z.enum(['test', 'production']).optional(),
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

function mapWompiRefundStatus(wompiStatus: string): 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'FAILED' {
  switch (wompiStatus) {
    case 'APPROVED':
      return 'REFUNDED';
    default:
      return 'FAILED';
  }
}

const REFUND_EVENT_TYPES = new Set(['refund.updated', 'refund_confirmed', 'refund_failed']);

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

        // Detectar tipo de evento antes de parsear el schema completo
        let eventType: string;
        let parsedRaw: unknown;
        try {
          parsedRaw = JSON.parse(rawBody);
          eventType = (parsedRaw as { event?: string }).event ?? '';
        } catch {
          res.status(400).json(toApiError('VALIDATION_ERROR', 'Payload del webhook inválido'));
          return;
        }

        // ── Rama: evento de reembolso ──────────────────────────────────────────
        if (REFUND_EVENT_TYPES.has(eventType)) {
          let refundPayload: z.infer<typeof wompiRefundWebhookEventSchema>;
          try {
            refundPayload = wompiRefundWebhookEventSchema.parse(parsedRaw);
          } catch {
            res.status(400).json(toApiError('VALIDATION_ERROR', 'Payload del webhook de reembolso inválido'));
            return;
          }

          const { refund } = refundPayload.data;
          const providerEventId = `refund_${refund.id}`;

          // Deduplicación
          const existingRefundEvent = await prisma.external_webhook_events.findUnique({
            where: {
              payment_provider_id_provider_event_id: {
                payment_provider_id: provider_id,
                provider_event_id: providerEventId,
              },
            },
            select: { id: true },
          });

          if (existingRefundEvent) {
            res.json({ received: true });
            return;
          }

          // Buscar el pago original por transaction_id → order → refund record
          const payment = await withTenantReadOnly(client_id, 'ADMIN_RUTA', (tx) =>
            tx.payments.findFirst({
              where: {
                client_id: BigInt(client_id),
                external_transaction_id: refund.transaction_id,
              },
              select: { id: true, order_id: true },
            })
          );

          const refundRecord = payment
            ? await withTenantReadOnly(client_id, 'ADMIN_RUTA', (tx) =>
                tx.refunds.findFirst({
                  where: {
                    client_id: BigInt(client_id),
                    order_id: payment.order_id,
                    status: 'PROVIDER_REQUESTED',
                  },
                  select: { id: true },
                })
              )
            : null;

          const outcome = mapWompiRefundStatus(refund.status);

          await withTenant(client_id, 'ADMIN_RUTA', async (tx) => {
            await tx.external_webhook_events.create({
              data: {
                client_id: BigInt(client_id),
                payment_provider_id: provider_id,
                provider_event_id: providerEventId,
                payload: parsedRaw as object,
                signature_valid: true,
                processing_result: `REFUND_${outcome}`,
                related_order_id: payment?.order_id ?? null,
                processed_at: new Date(),
              },
            });
          });

          if (refundRecord) {
            await refundsService.handleProviderRefundWebhook(
              client_id,
              Number(refundRecord.id),
              outcome,
              refund.id,
            );
          } else {
            logger.warn(
              { clientId: client_id, wompiRefundId: refund.id, transactionId: refund.transaction_id },
              'Wompi refund webhook: no matching refund record in PROVIDER_REQUESTED state',
            );
          }

          res.json({ received: true });
          return;
        }

        // ── Rama: evento de pago (lógica existente) ───────────────────────────
        let parsedPayload: z.infer<typeof wompiWebhookEventSchema>;
        try {
          parsedPayload = wompiWebhookEventSchema.parse(parsedRaw);
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
