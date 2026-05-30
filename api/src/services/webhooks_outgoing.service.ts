/**
 * webhooks_outgoing.service.ts — 6.INFRA-3
 *
 * Servicio para gestionar el despacho de webhooks salientes.
 * - processWebhookEvent: consulta suscripciones activas y encola jobs send_webhook
 * - retryWebhookDelivery: re-encola un job send_webhook para una entrega existente
 *
 * webhook_deliveries es append-only — solo INSERT, nunca UPDATE/DELETE.
 */

import type { PgBoss } from 'pg-boss';
import { withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from '../lib/http_error.js';
import { logger } from '../middleware/logger.js';

export const SEND_WEBHOOK_JOB = 'send_webhook';

export interface SendWebhookJobData {
  subscriptionId: number;
  url: string;
  eventType: string;
  payload: object;
  clientId: number;
}

// ── processWebhookEvent ────────────────────────────────────────────────────────

/**
 * Consulta las suscripciones activas del tenant para el eventType dado
 * y encola un job 'send_webhook' por cada una.
 */
export async function processWebhookEvent(
  eventType: string,
  payload: object,
  clientId: number,
  boss: PgBoss,
): Promise<void> {
  const subscriptions = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
    tx.webhook_subscriptions.findMany({
      where: {
        client_id: BigInt(clientId),
        status: 'ACTIVE',
        events: { has: eventType },
      },
      select: { id: true, url: true },
    }),
  );

  if (subscriptions.length === 0) {
    logger.debug({ clientId, eventType }, 'No active webhook subscriptions for event');
    return;
  }

  for (const sub of subscriptions) {
    const jobData: SendWebhookJobData = {
      subscriptionId: Number(sub.id),
      url: sub.url,
      eventType,
      payload,
      clientId,
    };

    await boss.send(SEND_WEBHOOK_JOB, jobData, {
      retryLimit: 5,
      retryBackoff: true,
    });

    logger.info(
      { clientId, subscriptionId: Number(sub.id), eventType },
      'Webhook job enqueued',
    );
  }
}

// ── retryWebhookDelivery ───────────────────────────────────────────────────────

/**
 * Re-encola un job send_webhook para una entrega existente identificada por deliveryId.
 * Busca la entrega y la suscripción asociada para obtener la URL destino.
 */
export async function retryWebhookDelivery(
  deliveryId: number,
  clientId: number,
  boss: PgBoss,
): Promise<void> {
  const delivery = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
    tx.webhook_deliveries.findFirst({
      where: {
        id: BigInt(deliveryId),
        client_id: BigInt(clientId),
      },
      include: {
        webhook_subscriptions: {
          select: { url: true },
        },
      },
    }),
  );

  if (!delivery) {
    throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Entrega de webhook no encontrada');
  }

  const jobData: SendWebhookJobData = {
    subscriptionId: Number(delivery.subscription_id),
    url: delivery.webhook_subscriptions.url,
    eventType: delivery.event_type,
    payload: delivery.payload as object,
    clientId,
  };

  await boss.send(SEND_WEBHOOK_JOB, jobData, {
    retryLimit: 5,
    retryBackoff: true,
  });

  logger.info(
    { clientId, deliveryId, subscriptionId: Number(delivery.subscription_id) },
    'Webhook delivery retry enqueued',
  );
}
