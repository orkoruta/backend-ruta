/**
 * api_client_orders.ts — F2.3.BACK-4
 *
 * Endpoints REST para el Cliente API (autenticación por API key, NO JWT).
 *
 * POST   /api/orders           — crear pedido (scope: orders:write)
 * GET    /api/orders           — listar pedidos del cliente (scope: orders:read)
 * GET    /api/orders/:id       — detalle + state_history (scope: orders:read)
 * POST   /api/orders/:id/cancel — cancelar pedido (scope: orders:write)
 *
 * IMPORTANTE: Este router se monta ANTES de app.use(authenticate) en app.ts
 * porque usa API key, no JWT.
 */

import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { createApiOrderSchema, apiOrderListQuerySchema, OrderStatus } from '@orkoruta/shared';
import { apiKeyAuth } from '../middleware/api_key_auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { createApiClientOrder } from '../services/orders/orders.service.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import { assertTransition } from '../services/orders/state_machine.js';
import { logger } from '../lib/logger.js';
import { processWebhookEvent } from '../services/webhooks_outgoing.service.js';
import { getMaintenanceBoss } from '../jobs/maintenance_boss.js';

// ── Schemas ────────────────────────────────────────────────────────────────────

const orderIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

const orderInclude = {
  order_items: {
    select: {
      id: true,
      product_id: true,
      product_name: true,
      sku: true,
      quantity: true,
      unit_price: true,
      subtotal: true,
    },
  },
} as const;

const orderIncludeWithHistory = {
  order_items: {
    select: {
      id: true,
      product_id: true,
      product_name: true,
      sku: true,
      quantity: true,
      unit_price: true,
      subtotal: true,
    },
  },
  order_state_history: {
    orderBy: { id: 'asc' as const },
    select: {
      id: true,
      state_dimension: true,
      previous_value: true,
      new_value: true,
      changed_by_actor_type: true,
      metadata: true,
      occurred_at: true,
    },
  },
} as const;

function serializeOrder(o: {
  id: bigint;
  client_id: bigint;
  buyer_id: bigint;
  courier_user_id: bigint | null;
  order_status: string;
  payment_status: string;
  delivery_type: string;
  delivery_carrier_type: string | null;
  payment_method: string;
  payment_method_submethod: string | null;
  buyer_type: string;
  closure_reason: string | null;
  subtotal: unknown;
  tax: unknown;
  shipping_fee: unknown;
  discount: unknown;
  total: unknown;
  currency: string;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  delivered_at: Date | null;
  closed_at: Date | null;
  order_items: {
    id: bigint;
    product_id: bigint | null;
    product_name: string;
    sku: string | null;
    quantity: number;
    unit_price: unknown;
    subtotal: unknown;
  }[];
  order_state_history?: {
    id: bigint;
    state_dimension: string;
    previous_value: string | null;
    new_value: string;
    changed_by_actor_type: string | null;
    metadata: unknown;
    occurred_at: Date;
  }[];
}) {
  return {
    id: Number(o.id),
    client_id: Number(o.client_id),
    order_status: o.order_status,
    payment_status: o.payment_status,
    delivery_type: o.delivery_type,
    delivery_carrier_type: o.delivery_carrier_type,
    payment_method: o.payment_method,
    payment_method_submethod: o.payment_method_submethod,
    buyer_type: o.buyer_type,
    closure_reason: o.closure_reason,
    subtotal: Number(o.subtotal),
    tax: Number(o.tax),
    shipping_fee: Number(o.shipping_fee),
    discount: Number(o.discount),
    total: Number(o.total),
    currency: o.currency,
    items: o.order_items.map((item) => ({
      id: Number(item.id),
      product_id: item.product_id ? Number(item.product_id) : null,
      product_name: item.product_name,
      sku: item.sku,
      quantity: item.quantity,
      unit_price: Number(item.unit_price),
      subtotal: Number(item.subtotal),
    })),
    created_at: o.created_at.toISOString(),
    updated_at: o.updated_at.toISOString(),
    submitted_at: o.submitted_at?.toISOString() ?? null,
    delivered_at: o.delivered_at?.toISOString() ?? null,
    closed_at: o.closed_at?.toISOString() ?? null,
    ...(o.order_state_history
      ? {
          state_history: o.order_state_history.map((h) => ({
            id: Number(h.id),
            state_dimension: h.state_dimension,
            previous_value: h.previous_value,
            new_value: h.new_value,
            changed_by_actor_type: h.changed_by_actor_type ?? null,
            metadata: h.metadata,
            timestamp: h.occurred_at.toISOString(),
          })),
        }
      : {}),
  };
}

// Estados desde los que un Cliente API puede cancelar (pre-logística)
const API_CLIENT_CANCEL_ALLOWED: Set<string> = new Set([
  OrderStatus.PREPARING,
  OrderStatus.AWAITING_COURIER_ASSIGNMENT,
  OrderStatus.READY_TO_SHIP,
  OrderStatus.READY_FOR_PICKUP,
]);

// ── Router ────────────────────────────────────────────────────────────────────

export const apiClientOrdersRouter: Router = Router();

// POST /api/orders — crear pedido (orders:write)
apiClientOrdersRouter.post(
  '/orders',
  apiKeyAuth('orders:write'),
  requireIdempotencyKey,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const input = createApiOrderSchema.parse(req.body);
      const clientId = BigInt(req.user!.client_id);
      const apiKeyId = req.user!.apiKeyId!;
      // createdByUserId: usar id del "usuario sistema" del cliente API.
      // El middleware pone id=0 (sentinel) para API_CLIENT; usamos como buyer_id.
      const createdByUserId = BigInt(req.user!.id === 0 ? req.user!.client_id : req.user!.id);

      const order = await createApiClientOrder(clientId, input, apiKeyId, createdByUserId);

      logger.info(
        { clientId: String(clientId), orderId: order.id },
        'api_client_orders: POST /api/orders - pedido creado',
      );

      res.status(201).json(order);
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/orders — listar pedidos del cliente (orders:read)
apiClientOrdersRouter.get(
  '/orders',
  apiKeyAuth('orders:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = apiOrderListQuerySchema.parse(req.query);
      const clientId = req.user!.client_id;

      const skip = (query.page - 1) * query.page_size;

      const where = {
        order_origin: 'API' as const,
        ...(query.status ? { order_status: query.status } : {}),
        ...(query.from || query.to
          ? {
              created_at: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      };

      const [items, total] = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
        Promise.all([
          tx.orders.findMany({
            where,
            include: orderInclude,
            orderBy: { created_at: 'desc' },
            skip,
            take: query.page_size,
          }),
          tx.orders.count({ where }),
        ]),
      );

      res.json({
        data: items.map(serializeOrder),
        pagination: { page: query.page, page_size: query.page_size, total },
      });
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/orders/:id — detalle + state_history (orders:read)
apiClientOrdersRouter.get(
  '/orders/:id',
  apiKeyAuth('orders:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const clientId = req.user!.client_id;

      const order = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
        tx.orders.findUnique({
          where: { id_client_id: { id: BigInt(id), client_id: BigInt(clientId) } },
          include: orderIncludeWithHistory,
        }),
      );

      // Tenant isolation: si no existe o no es de este cliente → 404
      if (!order) {
        res.status(404).json(toApiError('RESOURCE_NOT_FOUND', 'Pedido no encontrado'));
        return;
      }

      // Extra check: solo pedidos API del mismo cliente
      if (order.order_origin !== 'API') {
        res.status(404).json(toApiError('RESOURCE_NOT_FOUND', 'Pedido no encontrado'));
        return;
      }

      res.json(serializeOrder(order));
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/orders/:id/cancel — cancelar pedido (orders:write)
apiClientOrdersRouter.post(
  '/orders/:id/cancel',
  apiKeyAuth('orders:write'),
  requireIdempotencyKey,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = orderIdParamsSchema.parse(req.params);
      const clientId = req.user!.client_id;

      const order = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
        const existing = await tx.orders.findUnique({
          where: { id_client_id: { id: BigInt(id), client_id: BigInt(clientId) } },
          include: orderInclude,
        });

        if (!existing) {
          throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
        }

        // Tenant isolation: solo pedidos API
        if (existing.order_origin !== 'API') {
          throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
        }

        if (!API_CLIENT_CANCEL_ALLOWED.has(existing.order_status)) {
          throw new HttpError(
            422,
            'INVALID_STATE_TRANSITION',
            `No se puede cancelar un pedido en estado ${existing.order_status}`,
          );
        }

        // Transicionar a CANCELLED_BY_SYSTEM (actor API_CLIENT) y luego a CLOSED
        assertTransition(
          existing.order_status as OrderStatus,
          OrderStatus.CANCELLED_BY_ADMIN,
          'ADMIN_CLIENT',
        );

        await tx.orders.update({
          where: { id_client_id: { id: BigInt(id), client_id: BigInt(clientId) } },
          data: { order_status: OrderStatus.CANCELLED_BY_ADMIN, updated_at: new Date() },
        });

        const updated = await tx.orders.update({
          where: { id_client_id: { id: BigInt(id), client_id: BigInt(clientId) } },
          data: {
            order_status: OrderStatus.CLOSED,
            closure_reason: 'CANCELLED_BY_ADMIN',
            closed_at: new Date(),
            updated_at: new Date(),
          },
          include: orderInclude,
        });

        return updated;
      });

      logger.info(
        { clientId, orderId: id },
        'api_client_orders: POST /api/orders/:id/cancel - pedido cancelado',
      );

      // F2.BACK-6 — ORDER_CANCELLED webhook
      const boss = getMaintenanceBoss();
      if (boss) {
        const webhookPayload = {
          event_type: 'ORDER_CANCELLED',
          client_id: clientId,
          order_id: id,
          timestamp: new Date().toISOString(),
          data: {
            order_status: OrderStatus.CLOSED,
            closure_reason: 'CANCELLED_BY_ADMIN',
            delivery_type: order.delivery_type,
          },
        };
        setImmediate(() => {
          processWebhookEvent('ORDER_CANCELLED', webhookPayload, clientId, boss).catch((err: unknown) => {
            logger.warn({ err, clientId, orderId: id }, 'api_client_orders: error emitiendo ORDER_CANCELLED webhook');
          });
        });
      }

      res.json(serializeOrder(order));
    } catch (error) {
      next(error);
    }
  },
);

// ── Error handler local ───────────────────────────────────────────────────────

apiClientOrdersRouter.use((err: Error, _req: Request, res: Response, next: NextFunction): void => {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json(sendHttpError(err));
    return;
  }
  next(err);
});
