/**
 * admin_webhooks.ts — 6.INFRA-3
 *
 * Endpoints para gestión del historial de webhook_deliveries.
 *
 * GET  /admin/webhook-deliveries          — lista entregas del tenant (filtrable)
 * POST /admin/webhook-deliveries/:id/retry — reintenta una entrega
 */

import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { withTenantReadOnly } from '@orkoruta/db';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { toApiError } from '../lib/errors.js';
import { HttpError } from '../lib/http_error.js';
import { retryWebhookDelivery } from '../services/webhooks_outgoing.service.js';
import { getMaintenanceBoss } from '../jobs/maintenance_boss.js';
import { dateFilterSchema, startOfBogotaDay, endOfBogotaDayExclusive } from '@orkoruta/shared';

// ── Schemas ───────────────────────────────────────────────────────────────────

const deliveryListQuerySchema = z.object({
  status: z.enum(['DELIVERED', 'FAILED']).optional(),
  from: dateFilterSchema.optional(),
  to: dateFilterSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const deliveryIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ── Serializer ────────────────────────────────────────────────────────────────

function serializeDelivery(d: {
  id: bigint;
  client_id: bigint;
  subscription_id: bigint;
  event_type: string;
  event_id: string;
  payload: unknown;
  attempt_number: number;
  response_status: number | null;
  response_body: string | null;
  delivered_at: Date | null;
  next_retry_at: Date | null;
  failed_permanently: boolean;
  created_at: Date;
  webhook_subscriptions: { url: string };
}) {
  const status = d.delivered_at ? 'DELIVERED' : 'FAILED';
  return {
    id: Number(d.id),
    client_id: Number(d.client_id),
    subscription_id: Number(d.subscription_id),
    subscription_url: d.webhook_subscriptions.url,
    event_type: d.event_type,
    event_id: d.event_id,
    payload: d.payload,
    attempt_number: d.attempt_number,
    status,
    response_status: d.response_status,
    response_body: d.response_body,
    delivered_at: d.delivered_at?.toISOString() ?? null,
    next_retry_at: d.next_retry_at?.toISOString() ?? null,
    failed_permanently: d.failed_permanently,
    created_at: d.created_at.toISOString(),
  };
}

// ── Router factory ────────────────────────────────────────────────────────────

export function createAdminWebhooksRouter(): Router {
  const router = Router();

  // GET /admin/webhook-deliveries
  router.get(
    '/webhook-deliveries',
    requireAdminClient,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { status, from, to, limit } = deliveryListQuerySchema.parse(req.query);
        const clientId = req.user!.client_id;

        const deliveries = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
          tx.webhook_deliveries.findMany({
            where: {
              client_id: BigInt(clientId),
              ...(status === 'DELIVERED' ? { delivered_at: { not: null } } : {}),
              ...(status === 'FAILED' ? { delivered_at: null } : {}),
              ...(from || to
                ? {
                    created_at: {
                      ...(from ? { gte: startOfBogotaDay(from) } : {}),
                      ...(to ? { lt: endOfBogotaDayExclusive(to) } : {}),
                    },
                  }
                : {}),
            },
            include: {
              webhook_subscriptions: { select: { url: true } },
            },
            orderBy: { created_at: 'desc' },
            take: limit,
          }),
        );

        res.json(deliveries.map(serializeDelivery));
      } catch (error) {
        next(error);
      }
    },
  );

  // POST /admin/webhook-deliveries/:id/retry
  router.post(
    '/webhook-deliveries/:id/retry',
    requireIdempotencyKey,
    requireAdminClient,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = deliveryIdParamsSchema.parse(req.params);
        const clientId = req.user!.client_id;

        const boss = getMaintenanceBoss();
        if (!boss) {
          throw new HttpError(503, 'RESOURCE_NOT_FOUND', 'El sistema de jobs no está disponible');
        }
        await retryWebhookDelivery(id, clientId, boss);

        res.status(202).json({ message: 'Reintento de webhook encolado correctamente' });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
