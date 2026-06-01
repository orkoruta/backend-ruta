/**
 * webhook_sender.job.ts — 6.INFRA-3
 *
 * Worker pg-boss para el job 'send_webhook'.
 * Realiza el POST HTTP a la URL destino y registra el resultado
 * en webhook_deliveries (append-only).
 *
 * Reintentos: retryLimit=5, retryBackoff=true (configurado en el productor).
 * Timeout HTTP: 10 segundos.
 * Status: DELIVERED si HTTP 2xx, FAILED si error o timeout.
 */

import type { PgBoss, Job } from 'pg-boss';
import { withTenant } from '@orkoruta/db';
import { logger } from '../lib/logger.js';
import { SEND_WEBHOOK_JOB, type SendWebhookJobData } from '../services/webhooks_outgoing.service.js';

const HTTP_TIMEOUT_MS = 10_000;

export async function registerWebhookSenderJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(SEND_WEBHOOK_JOB);
  await boss.work<SendWebhookJobData>(SEND_WEBHOOK_JOB, async (jobs: Job<SendWebhookJobData>[]) => {
    for (const job of jobs) {
      await processWebhookSend(job.data);
    }
  });
  logger.info({ job: SEND_WEBHOOK_JOB }, 'Job registered');
}

export async function processWebhookSend(data: SendWebhookJobData): Promise<void> {
  const { subscriptionId, url, eventType, payload, clientId } = data;
  const eventId = crypto.randomUUID();
  const now = new Date();

  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let status: 'DELIVERED' | 'FAILED' = 'FAILED';
  let deliveredAt: Date | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    let response: Response | null = null;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: eventType, event_id: eventId, payload }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    responseStatus = response.status;

    try {
      responseBody = await response.text();
    } catch {
      responseBody = null;
    }

    if (response.ok) {
      status = 'DELIVERED';
      deliveredAt = now;
      logger.info({ clientId, subscriptionId, eventType, responseStatus }, 'Webhook delivered');
    } else {
      logger.warn({ clientId, subscriptionId, eventType, responseStatus }, 'Webhook delivery failed (non-2xx)');
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    logger.warn(
      { clientId, subscriptionId, eventType, err: isAbort ? 'timeout' : String(err) },
      'Webhook delivery error',
    );
  }

  // INSERT into webhook_deliveries (append-only)
  await withTenant(clientId, 'ADMIN_CLIENT', (tx) =>
    tx.webhook_deliveries.create({
      data: {
        client_id: BigInt(clientId),
        subscription_id: BigInt(subscriptionId),
        event_type: eventType,
        event_id: eventId,
        payload: payload as object,
        attempt_number: 1,
        response_status: responseStatus,
        response_body: responseBody,
        delivered_at: deliveredAt,
        failed_permanently: false,
        created_at: now,
      },
    }),
  );
}
