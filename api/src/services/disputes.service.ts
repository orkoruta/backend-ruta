/**
 * disputes.service.ts — Bloque 15: Disputas post-entrega (Fase 3, Bloque 3.3)
 *
 * Aplica solo a Cliente Full (client_type = 'FULL').
 * Cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE.
 *
 * State machine de disputes.status:
 *   DISPUTED
 *     → DISPUTE_UNDER_REVIEW        (startReview)
 *       → DISPUTE_RESOLVED_NO_ACTION      (resolveNoAction)
 *       → DISPUTE_RESOLVED_WITH_RETURN    (resolveWithReturn → returnsService.requestReturn)
 *       → DISPUTE_RESOLVED_WITH_REFUND    (resolveWithRefund → refundsService.initiateRefund)
 *
 * Se sincroniza con orders.dispute_status (mismos valores de string).
 *
 * Precondición para abrir disputa: order_status IN (DELIVERED, CONFIRMED_BY_CUSTOMER,
 * CONFIRMED_BY_SYSTEM) — estados post-entrega.
 */

import { z } from 'zod';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from '../lib/http_error.js';
import { logger } from '../lib/logger.js';
import { refundsService } from './refunds.service.js';
import { returnsService } from './returns.service.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

// ── Estados de disputa (los 5 estados requeridos por el Bloque 15) ─────────────

export const DISPUTE_STATUS = {
  DISPUTED: 'DISPUTED',
  DISPUTE_UNDER_REVIEW: 'DISPUTE_UNDER_REVIEW',
  DISPUTE_RESOLVED_NO_ACTION: 'DISPUTE_RESOLVED_NO_ACTION',
  DISPUTE_RESOLVED_WITH_RETURN: 'DISPUTE_RESOLVED_WITH_RETURN',
  DISPUTE_RESOLVED_WITH_REFUND: 'DISPUTE_RESOLVED_WITH_REFUND',
} as const;

export type DisputeStatusValue = (typeof DISPUTE_STATUS)[keyof typeof DISPUTE_STATUS];

// Estados de pedido válidos para abrir una disputa (post-entrega)
const VALID_ORDER_STATUSES_FOR_DISPUTE = new Set([
  'DELIVERED',
  'CONFIRMED_BY_CUSTOMER',
  'CONFIRMED_BY_SYSTEM',
]);

// ── Schemas de entrada ────────────────────────────────────────────────────────

export const openDisputeBodySchema = z.object({
  reason: z.string().min(1).max(1000),
  evidence: z.record(z.string(), z.string()).optional(),
});

export const resolveDisputeBodySchema = z.object({
  action: z.enum(['NO_ACTION', 'WITH_RETURN', 'WITH_REFUND']),
  resolution: z.string().min(1).max(2000),
  amount: z.number().positive().optional(),
});

export const disputeListQuerySchema = z.object({
  status: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
});

export type OpenDisputeBody = z.infer<typeof openDisputeBodySchema>;
export type ResolveDisputeBody = z.infer<typeof resolveDisputeBodySchema>;
export type DisputeListQuery = z.infer<typeof disputeListQuerySchema>;

// ── Serialización ─────────────────────────────────────────────────────────────

function serializeDispute(d: {
  id: bigint;
  client_id: bigint;
  order_id: bigint;
  buyer_id: bigint;
  status: string;
  reason: string | null;
  resolution: string | null;
  resolution_action: string | null;
  resolved_by_user_id: bigint | null;
  resolved_at: Date | null;
  evidence: unknown;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: Number(d.id),
    client_id: Number(d.client_id),
    order_id: Number(d.order_id),
    buyer_id: Number(d.buyer_id),
    status: d.status,
    reason: d.reason,
    resolution: d.resolution,
    resolution_action: d.resolution_action,
    resolved_by_user_id: d.resolved_by_user_id ? Number(d.resolved_by_user_id) : null,
    resolved_at: d.resolved_at?.toISOString() ?? null,
    evidence: d.evidence,
    created_at: d.created_at.toISOString(),
    updated_at: d.updated_at.toISOString(),
  };
}

// ── Guard: Cliente Full ───────────────────────────────────────────────────────

async function assertFullClient(clientId: number): Promise<void> {
  const client = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.clients.findUnique({
      where: { id: BigInt(clientId) },
      select: { client_type: true },
    }),
  );
  if (!client || client.client_type === 'API') {
    throw new HttpError(
      422,
      'LOGISTICS_ONLY_FEATURE_UNAVAILABLE',
      'Las disputas no aplican para Clientes API',
    );
  }
}

// ── Helper: cargar disputa o lanzar 404 ──────────────────────────────────────

async function loadDispute(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  clientId: number,
  disputeId: number,
) {
  const dispute = await tx.disputes.findFirst({
    where: { id: BigInt(disputeId), client_id: BigInt(clientId) },
  });
  if (!dispute) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Disputa no encontrada');
  return dispute;
}

// ── Helper: auditoría ────────────────────────────────────────────────────────

async function audit(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  clientId: number,
  actorUserId: number | null,
  actorType: string,
  actorRole: string,
  action: string,
  disputeId: bigint,
  metadata?: Record<string, string | number | boolean | null | undefined>,
): Promise<void> {
  await tx.audit_events.create({
    data: {
      client_id: BigInt(clientId),
      actor_user_id: actorUserId ? BigInt(actorUserId) : null,
      actor_type: actorType,
      actor_role: actorRole,
      action,
      entity_type: 'dispute',
      entity_id: disputeId,
      result: 'SUCCESS',
      ...(metadata !== undefined ? { metadata } : {}),
    },
  });
}

// ── Servicio ──────────────────────────────────────────────────────────────────

export const disputesService = {
  /**
   * El Comprador abre una disputa post-entrega.
   * Requiere que el pedido esté en estado DELIVERED, CONFIRMED_BY_CUSTOMER o CONFIRMED_BY_SYSTEM.
   * Solo se puede tener una disputa activa por pedido.
   */
  async openDispute(
    clientId: number,
    orderId: number,
    buyerId: number,
    input: OpenDisputeBody,
  ) {
    await assertFullClient(clientId);

    const dispute = await withTenant(clientId, 'BUYER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        select: {
          id: true,
          client_id: true,
          buyer_id: true,
          order_status: true,
          dispute_status: true,
        },
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      // Aislamiento: el pedido debe pertenecer al comprador
      if (Number(order.buyer_id) !== buyerId) {
        throw new HttpError(403, 'FORBIDDEN', 'El pedido no pertenece a este comprador');
      }

      // Validar que el pedido esté en un estado post-entrega
      if (!VALID_ORDER_STATUSES_FOR_DISPUTE.has(order.order_status)) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `El pedido tiene order_status=${order.order_status}; se requiere DELIVERED, CONFIRMED_BY_CUSTOMER o CONFIRMED_BY_SYSTEM para abrir disputa`,
        );
      }

      // Verificar que no exista ya una disputa activa para este pedido
      const existing = await tx.disputes.findFirst({
        where: { order_id: BigInt(orderId), client_id: BigInt(clientId) },
        select: { id: true, status: true },
      });
      if (existing) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Ya existe una disputa para este pedido');
      }

      const created = await tx.disputes.create({
        data: {
          client_id: BigInt(clientId),
          order_id: BigInt(orderId),
          buyer_id: BigInt(buyerId),
          status: DISPUTE_STATUS.DISPUTED,
          reason: input.reason,
          ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
        },
      });

      // Actualizar orders.dispute_status
      await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { dispute_status: DISPUTE_STATUS.DISPUTED, updated_at: new Date() },
      });

      await audit(tx, clientId, buyerId, 'USER', 'BUYER', 'DISPUTE_OPENED', created.id, {
        order_id: orderId,
        reason: input.reason,
      });

      logger.info({ clientId, orderId, disputeId: String(created.id), buyerId }, 'Dispute opened');
      return created;
    });

    return serializeDispute(dispute);
  },

  /**
   * Admin inicia la revisión: DISPUTED → DISPUTE_UNDER_REVIEW.
   */
  async startReview(clientId: number, disputeId: number, actorUserId: number) {
    await assertFullClient(clientId);

    const dispute = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadDispute(tx, clientId, disputeId);

      if (existing.status !== DISPUTE_STATUS.DISPUTED) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La disputa está en estado ${existing.status}; se esperaba DISPUTED`,
        );
      }

      const updated = await tx.disputes.update({
        where: { id_client_id: { id: BigInt(disputeId), client_id: BigInt(clientId) } },
        data: { status: DISPUTE_STATUS.DISPUTE_UNDER_REVIEW, updated_at: new Date() },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { dispute_status: DISPUTE_STATUS.DISPUTE_UNDER_REVIEW, updated_at: new Date() },
      });

      await audit(tx, clientId, actorUserId, 'USER', 'ADMIN_CLIENT', 'DISPUTE_REVIEW_STARTED', existing.id, {
        dispute_id: disputeId,
        order_id: Number(existing.order_id),
      });

      logger.info({ clientId, disputeId, actorUserId }, 'Dispute review started');
      return updated;
    });

    return serializeDispute(dispute);
  },

  /**
   * Admin resuelve sin acción: DISPUTE_UNDER_REVIEW → DISPUTE_RESOLVED_NO_ACTION.
   * NO dispara refund ni return.
   */
  async resolveNoAction(
    clientId: number,
    disputeId: number,
    resolution: string,
    actorUserId: number,
  ) {
    await assertFullClient(clientId);

    const dispute = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadDispute(tx, clientId, disputeId);

      if (existing.status !== DISPUTE_STATUS.DISPUTE_UNDER_REVIEW) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La disputa está en estado ${existing.status}; se esperaba DISPUTE_UNDER_REVIEW`,
        );
      }

      const now = new Date();
      const updated = await tx.disputes.update({
        where: { id_client_id: { id: BigInt(disputeId), client_id: BigInt(clientId) } },
        data: {
          status: DISPUTE_STATUS.DISPUTE_RESOLVED_NO_ACTION,
          resolution,
          resolution_action: 'NO_ACTION',
          resolved_by_user_id: BigInt(actorUserId),
          resolved_at: now,
          updated_at: now,
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { dispute_status: DISPUTE_STATUS.DISPUTE_RESOLVED_NO_ACTION, updated_at: now },
      });

      await audit(tx, clientId, actorUserId, 'USER', 'ADMIN_CLIENT', 'DISPUTE_RESOLVED_NO_ACTION', existing.id, {
        dispute_id: disputeId,
        order_id: Number(existing.order_id),
        resolution,
      });

      logger.info({ clientId, disputeId, actorUserId }, 'Dispute resolved with no action');
      return updated;
    });

    return serializeDispute(dispute);
  },

  /**
   * Admin resuelve con devolución: DISPUTE_UNDER_REVIEW → DISPUTE_RESOLVED_WITH_RETURN.
   * Llama automáticamente returnsService.requestReturn().
   */
  async resolveWithReturn(
    clientId: number,
    disputeId: number,
    resolution: string,
    actorUserId: number,
  ) {
    await assertFullClient(clientId);

    const dispute = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadDispute(tx, clientId, disputeId);

      if (existing.status !== DISPUTE_STATUS.DISPUTE_UNDER_REVIEW) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La disputa está en estado ${existing.status}; se esperaba DISPUTE_UNDER_REVIEW`,
        );
      }

      const now = new Date();
      const updated = await tx.disputes.update({
        where: { id_client_id: { id: BigInt(disputeId), client_id: BigInt(clientId) } },
        data: {
          status: DISPUTE_STATUS.DISPUTE_RESOLVED_WITH_RETURN,
          resolution,
          resolution_action: 'WITH_RETURN',
          resolved_by_user_id: BigInt(actorUserId),
          resolved_at: now,
          updated_at: now,
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { dispute_status: DISPUTE_STATUS.DISPUTE_RESOLVED_WITH_RETURN, updated_at: now },
      });

      await audit(tx, clientId, actorUserId, 'USER', 'ADMIN_CLIENT', 'DISPUTE_RESOLVED_WITH_RETURN', existing.id, {
        dispute_id: disputeId,
        order_id: Number(existing.order_id),
        resolution,
      });

      logger.info({ clientId, disputeId, actorUserId }, 'Dispute resolved with return');
      return updated;
    });

    // Crear devolución automáticamente (post-transacción)
    // Si falla (p.ej. ya existe una devolución), loguear sin revertir
    try {
      const disputeData = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
        tx.disputes.findFirst({
          where: { id: BigInt(disputeId), client_id: BigInt(clientId) },
          select: { buyer_id: true, order_id: true },
        }),
      );

      if (disputeData) {
        await returnsService.requestReturn(
          clientId,
          Number(disputeData.order_id),
          Number(disputeData.buyer_id),
          { reason: `Disputa #${disputeId} resuelta con devolución: ${resolution}` },
        );
      }
    } catch (err) {
      logger.warn(
        { clientId, disputeId, orderId: Number(dispute.order_id), err },
        'requestReturn after resolveWithReturn failed — disputa resuelta, revisar devolución manualmente',
      );
    }

    return serializeDispute(dispute);
  },

  /**
   * Admin resuelve con reembolso: DISPUTE_UNDER_REVIEW → DISPUTE_RESOLVED_WITH_REFUND.
   * Llama automáticamente refundsService.initiateRefund().
   */
  async resolveWithRefund(
    clientId: number,
    disputeId: number,
    input: { amount: number; resolution: string },
    actorUserId: number,
  ) {
    await assertFullClient(clientId);

    // Actor stub para refundsService.initiateRefund (necesita AuthenticatedUser)
    const actorStub: AuthenticatedUser = {
      id: actorUserId,
      client_id: clientId,
      user_type: 'ADMIN_CLIENT',
      session_id: 0,
    };

    const dispute = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadDispute(tx, clientId, disputeId);

      if (existing.status !== DISPUTE_STATUS.DISPUTE_UNDER_REVIEW) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La disputa está en estado ${existing.status}; se esperaba DISPUTE_UNDER_REVIEW`,
        );
      }

      const now = new Date();
      const updated = await tx.disputes.update({
        where: { id_client_id: { id: BigInt(disputeId), client_id: BigInt(clientId) } },
        data: {
          status: DISPUTE_STATUS.DISPUTE_RESOLVED_WITH_REFUND,
          resolution: input.resolution,
          resolution_action: 'WITH_REFUND',
          resolved_by_user_id: BigInt(actorUserId),
          resolved_at: now,
          updated_at: now,
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { dispute_status: DISPUTE_STATUS.DISPUTE_RESOLVED_WITH_REFUND, updated_at: now },
      });

      await audit(tx, clientId, actorUserId, 'USER', 'ADMIN_CLIENT', 'DISPUTE_RESOLVED_WITH_REFUND', existing.id, {
        dispute_id: disputeId,
        order_id: Number(existing.order_id),
        resolution: input.resolution,
        amount: input.amount,
      });

      logger.info({ clientId, disputeId, actorUserId, amount: input.amount }, 'Dispute resolved with refund');
      return updated;
    });

    // Iniciar reembolso automáticamente (post-transacción)
    // Si falla (p.ej. pedido no está en REFUND_PENDING), loguear sin revertir
    try {
      await refundsService.initiateRefund(
        clientId,
        Number(dispute.order_id),
        {
          amount: input.amount,
          refund_modality: 'STORE_CREDIT',
          reason: `Disputa #${disputeId} resuelta con reembolso: ${input.resolution}`,
        },
        actorStub,
      );
    } catch (err) {
      logger.warn(
        { clientId, disputeId, orderId: Number(dispute.order_id), err },
        'initiateRefund after resolveWithRefund failed — disputa resuelta, revisar reembolso manualmente',
      );
    }

    return serializeDispute(dispute);
  },

  /**
   * Obtiene el detalle de una disputa.
   */
  async getDispute(clientId: number, disputeId: number) {
    const dispute = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.disputes.findFirst({
        where: { id: BigInt(disputeId), client_id: BigInt(clientId) },
      }),
    );
    if (!dispute) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Disputa no encontrada');
    return serializeDispute(dispute);
  },

  /**
   * Obtiene la disputa de un pedido para el comprador.
   */
  async getDisputeForOrder(clientId: number, orderId: number, buyerId: number) {
    const order = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      tx.orders.findFirst({
        where: { id: BigInt(orderId), client_id: BigInt(clientId), buyer_id: BigInt(buyerId) },
        select: { id: true, dispute_status: true },
      }),
    );
    if (!order) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

    const dispute = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      tx.disputes.findFirst({
        where: { order_id: BigInt(orderId), client_id: BigInt(clientId), buyer_id: BigInt(buyerId) },
        orderBy: { created_at: 'desc' },
      }),
    );

    return {
      dispute_status: order.dispute_status,
      dispute: dispute ? serializeDispute(dispute) : null,
    };
  },

  /**
   * Lista disputas con filtros (para el admin).
   */
  async listDisputes(clientId: number, query: DisputeListQuery) {
    const skip = (query.page - 1) * query.page_size;
    const where = {
      client_id: BigInt(clientId),
      ...(query.status ? { status: query.status } : {}),
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
        tx.disputes.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip,
          take: query.page_size,
        }),
        tx.disputes.count({ where }),
      ]),
    );

    return {
      data: items.map(serializeDispute),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },
};
