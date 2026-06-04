/**
 * refunds.service.ts — Flujo 4: Reembolso completo (Fase 3, Bloque 3.1)
 *
 * REGLA 4.1 — Principio financiero:
 *   RUTA NO ejecuta movimientos de dinero. Solo registra estados.
 *   El Cliente (o su proveedor de pagos) ejecuta el reembolso real.
 *
 * Aplica solo a Cliente Full. Cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE.
 *
 * state machine de refunds.status:
 *   PENDING → PROCESSING → PROVIDER_REQUESTED → REFUNDED / PARTIALLY_REFUNDED / FAILED
 *
 * Se sincroniza con orders.refund_status:
 *   REFUND_PENDING → REFUND_PROCESSING → REFUND_PROVIDER_REQUESTED → REFUNDED / PARTIALLY_REFUNDED / REFUND_FAILED
 */

import { z } from 'zod';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { RefundStatus } from '@orkoruta/shared';
import { HttpError } from '../lib/http_error.js';
import { logger } from '../lib/logger.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

// ── Schemas de entrada ────────────────────────────────────────────────────────

export const initiateRefundBodySchema = z.object({
  amount: z.number().positive('El monto debe ser mayor a cero'),
  refund_modality: z.enum(['STORE_CREDIT', 'BANK_REFUND']),
  reason: z.string().min(1).max(500).optional(),
});

export const markRefundExecutedBodySchema = z.object({
  outcome: z.enum(['REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED']),
  amount_executed: z.number().positive().optional(),
  external_provider_refund_id: z.string().max(255).optional(),
  evidence: z.string().max(2000).optional(),
});

export const refundListQuerySchema = z.object({
  status: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
});

export type InitiateRefundBody = z.infer<typeof initiateRefundBodySchema>;
export type MarkRefundExecutedBody = z.infer<typeof markRefundExecutedBodySchema>;
export type RefundListQuery = z.infer<typeof refundListQuerySchema>;

// ── Orden de estados del reembolso ────────────────────────────────────────────

// Desde refunds.status → el orders.refund_status correspondiente
const REFUND_STATUS_MAP: Record<string, string> = {
  PENDING: RefundStatus.REFUND_PENDING,
  PROCESSING: RefundStatus.REFUND_PROCESSING,
  PROVIDER_REQUESTED: RefundStatus.REFUND_PROVIDER_REQUESTED,
  REFUNDED: RefundStatus.REFUNDED,
  PARTIALLY_REFUNDED: RefundStatus.PARTIALLY_REFUNDED,
  FAILED: RefundStatus.REFUND_FAILED,
};

// ── Serialización ─────────────────────────────────────────────────────────────

function serializeRefund(r: {
  id: bigint;
  client_id: bigint;
  order_id: bigint;
  payment_id: bigint | null;
  refund_modality: string;
  amount: { toNumber(): number } | number | string;
  currency: string;
  status: string;
  executed_by_user_id: bigint | null;
  executed_at: Date | null;
  external_provider_refund_id: string | null;
  evidence: unknown;
  reason: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: Number(r.id),
    client_id: Number(r.client_id),
    order_id: Number(r.order_id),
    payment_id: r.payment_id ? Number(r.payment_id) : null,
    refund_modality: r.refund_modality,
    amount: typeof r.amount === 'object' && 'toNumber' in (r.amount as object)
      ? (r.amount as { toNumber(): number }).toNumber()
      : Number(r.amount),
    currency: r.currency,
    status: r.status,
    executed_by_user_id: r.executed_by_user_id ? Number(r.executed_by_user_id) : null,
    executed_at: r.executed_at?.toISOString() ?? null,
    external_provider_refund_id: r.external_provider_refund_id,
    evidence: r.evidence,
    reason: r.reason,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

// ── Guard de Cliente Full ─────────────────────────────────────────────────────

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
      'Los reembolsos no aplican para Clientes API',
    );
  }
}

// ── Servicio ──────────────────────────────────────────────────────────────────

export const refundsService = {
  /**
   * Inicia el reembolso explícitamente (admin elige monto y modalidad).
   * El pedido debe estar con refund_status = REFUND_PENDING (ya cerrado y PAID).
   */
  async initiateRefund(
    clientId: number,
    orderId: number,
    input: InitiateRefundBody,
    actor: AuthenticatedUser,
  ) {
    await assertFullClient(clientId);

    const refund = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        select: {
          id: true, client_id: true, payment_status: true, refund_status: true,
          payment_method: true,
        },
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.payment_status !== 'PAID') {
        throw new HttpError(422, 'INVALID_STATE_TRANSITION', 'Solo se puede reembolsar un pedido pagado (PAID)');
      }

      if (order.refund_status !== RefundStatus.REFUND_PENDING) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `El pedido tiene refund_status=${order.refund_status}; se esperaba REFUND_PENDING`,
        );
      }

      // Verificar que no exista ya un refund activo para este pedido
      const existing = await tx.refunds.findFirst({
        where: { order_id: order.id, client_id: BigInt(clientId) },
        select: { id: true, status: true },
      });
      if (existing && existing.status !== 'FAILED') {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Ya existe un reembolso activo para este pedido');
      }

      // Obtener payment_id del pago más reciente PAID de este pedido
      const payment = await tx.payments.findFirst({
        where: { order_id: order.id, client_id: BigInt(clientId), status: 'PAID' },
        select: { id: true },
        orderBy: { created_at: 'desc' },
      });

      const created = await tx.refunds.create({
        data: {
          client_id: BigInt(clientId),
          order_id: order.id,
          payment_id: payment?.id ?? null,
          refund_modality: input.refund_modality,
          amount: input.amount,
          currency: 'COP',
          status: 'PENDING',
          reason: input.reason ?? null,
        },
      });

      // Actualizar orders.refund_modality
      await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { refund_modality: input.refund_modality, updated_at: new Date() },
      });

      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actor.id),
          actor_type: 'USER',
          actor_role: actor.user_type,
          action: 'REFUND_INITIATED',
          entity_type: 'refund',
          entity_id: created.id,
          result: 'SUCCESS',
          metadata: {
            order_id: orderId,
            amount: input.amount,
            refund_modality: input.refund_modality,
          },
        },
      });

      logger.info({ clientId, orderId, refundId: String(created.id), modality: input.refund_modality }, 'Refund initiated');
      return created;
    });

    return serializeRefund(refund);
  },

  /**
   * Procesa el reembolso: PENDING → PROCESSING.
   * Bifurca por refund_modality para informar al admin el siguiente paso.
   */
  async processRefund(
    clientId: number,
    refundId: number,
    actor: AuthenticatedUser,
  ) {
    await assertFullClient(clientId);

    const refund = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.refunds.findFirst({
        where: { id: BigInt(refundId), client_id: BigInt(clientId) },
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Reembolso no encontrado');
      }

      if (existing.status !== 'PENDING') {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `El reembolso está en estado ${existing.status}; se esperaba PENDING`,
        );
      }

      const updated = await tx.refunds.update({
        where: { id_client_id: { id: BigInt(refundId), client_id: BigInt(clientId) } },
        data: { status: 'PROCESSING', updated_at: new Date() },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { refund_status: RefundStatus.REFUND_PROCESSING, updated_at: new Date() },
      });

      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actor.id),
          actor_type: 'USER',
          actor_role: actor.user_type,
          action: 'REFUND_PROCESSING_STARTED',
          entity_type: 'refund',
          entity_id: BigInt(refundId),
          result: 'SUCCESS',
          metadata: { refund_modality: existing.refund_modality },
        },
      });

      logger.info(
        { clientId, refundId, modality: existing.refund_modality },
        'Refund moved to PROCESSING',
      );
      return updated;
    });

    return serializeRefund(refund);
  },

  /**
   * Solicita el reembolso al proveedor externo (Wompi, etc.).
   * Solo aplica para BANK_REFUND + payment online.
   * PROCESSING → PROVIDER_REQUESTED.
   */
  async requestProviderRefund(
    clientId: number,
    refundId: number,
    actor: AuthenticatedUser,
  ) {
    await assertFullClient(clientId);

    const refund = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.refunds.findFirst({
        where: { id: BigInt(refundId), client_id: BigInt(clientId) },
        include: {
          orders: { select: { payment_method: true, payment_method_submethod: true } },
        },
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Reembolso no encontrado');
      }

      if (existing.status !== 'PROCESSING') {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `El reembolso está en estado ${existing.status}; se esperaba PROCESSING`,
        );
      }

      if (existing.refund_modality !== 'BANK_REFUND') {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          'requestProviderRefund solo aplica para modalidad BANK_REFUND',
        );
      }

      const paymentMethod = existing.orders?.payment_method;
      const submethod = existing.orders?.payment_method_submethod;

      const requiresProvider =
        paymentMethod === 'ONLINE_AT_ORDER' ||
        (paymentMethod === 'ELECTRONIC_ON_DELIVERY' &&
          (submethod === 'DATAFONO' || submethod === 'QR' || submethod === 'PAYMENT_LINK'));

      if (!requiresProvider) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          'El método de pago original no requiere solicitud al proveedor (usar mark-executed para reembolso interno)',
        );
      }

      const updated = await tx.refunds.update({
        where: { id_client_id: { id: BigInt(refundId), client_id: BigInt(clientId) } },
        data: { status: 'PROVIDER_REQUESTED', updated_at: new Date() },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { refund_status: RefundStatus.REFUND_PROVIDER_REQUESTED, updated_at: new Date() },
      });

      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actor.id),
          actor_type: 'USER',
          actor_role: actor.user_type,
          action: 'REFUND_PROVIDER_REQUESTED',
          entity_type: 'refund',
          entity_id: BigInt(refundId),
          result: 'SUCCESS',
          metadata: { payment_method: paymentMethod, submethod },
        },
      });

      logger.info({ clientId, refundId, paymentMethod }, 'Refund provider request recorded');
      return updated;
    });

    return serializeRefund(refund);
  },

  /**
   * Marca el reembolso como ejecutado (por el cliente o por confirmación del proveedor).
   * Aplica desde PROCESSING (reembolso interno) o PROVIDER_REQUESTED (proveedor).
   * Resultado: REFUNDED | PARTIALLY_REFUNDED | FAILED.
   */
  async markRefundExecuted(
    clientId: number,
    refundId: number,
    input: MarkRefundExecutedBody,
    actor: AuthenticatedUser,
  ) {
    await assertFullClient(clientId);

    const refund = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.refunds.findFirst({
        where: { id: BigInt(refundId), client_id: BigInt(clientId) },
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Reembolso no encontrado');
      }

      if (existing.status !== 'PROCESSING' && existing.status !== 'PROVIDER_REQUESTED') {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `El reembolso está en estado ${existing.status}; se esperaba PROCESSING o PROVIDER_REQUESTED`,
        );
      }

      const newRefundStatus = input.outcome; // REFUNDED | PARTIALLY_REFUNDED | FAILED
      const newOrderRefundStatus = REFUND_STATUS_MAP[newRefundStatus] as string;
      const now = new Date();

      const updated = await tx.refunds.update({
        where: { id_client_id: { id: BigInt(refundId), client_id: BigInt(clientId) } },
        data: {
          status: newRefundStatus,
          executed_by_user_id: input.outcome !== 'FAILED' ? BigInt(actor.id) : null,
          executed_at: input.outcome !== 'FAILED' ? now : null,
          external_provider_refund_id: input.external_provider_refund_id ?? null,
          evidence: input.evidence ? { notes: input.evidence } : undefined,
          updated_at: now,
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { refund_status: newOrderRefundStatus, updated_at: now },
      });

      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actor.id),
          actor_type: 'USER',
          actor_role: actor.user_type,
          action: `REFUND_MARKED_${input.outcome}`,
          entity_type: 'refund',
          entity_id: BigInt(refundId),
          result: 'SUCCESS',
          metadata: {
            outcome: input.outcome,
            amount_executed: input.amount_executed,
            external_id: input.external_provider_refund_id,
          },
        },
      });

      logger.info({ clientId, refundId, outcome: input.outcome }, 'Refund marked executed');
      return updated;
    });

    return serializeRefund(refund);
  },

  /**
   * Procesa un webhook entrante del proveedor de pagos que confirma el reembolso.
   * Solo actualiza el estado; la deduplicación la maneja el caller (webhooks.ts).
   */
  async handleProviderRefundWebhook(
    clientId: number,
    refundId: number,
    outcome: 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'FAILED',
    externalRefundId?: string,
  ): Promise<void> {
    const newOrderRefundStatus = REFUND_STATUS_MAP[outcome] as string;
    const now = new Date();

    await withTenant(clientId, 'ADMIN_RUTA', async (tx) => {
      const existing = await tx.refunds.findFirst({
        where: { id: BigInt(refundId), client_id: BigInt(clientId) },
        select: { id: true, status: true, order_id: true },
      });

      if (!existing) return;
      if (existing.status !== 'PROVIDER_REQUESTED') return;

      await tx.refunds.update({
        where: { id_client_id: { id: BigInt(refundId), client_id: BigInt(clientId) } },
        data: {
          status: outcome,
          external_provider_refund_id: externalRefundId ?? null,
          executed_at: outcome !== 'FAILED' ? now : null,
          updated_at: now,
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { refund_status: newOrderRefundStatus, updated_at: now },
      });

      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: null,
          actor_type: 'SYSTEM',
          actor_role: 'ADMIN_RUTA',
          action: `REFUND_WEBHOOK_${outcome}`,
          entity_type: 'refund',
          entity_id: BigInt(refundId),
          result: 'SUCCESS',
          metadata: { outcome, external_id: externalRefundId },
        },
      });
    });

    logger.info({ clientId, refundId, outcome }, 'Provider refund webhook processed');
  },

  async getRefund(clientId: number, refundId: number) {
    const refund = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.refunds.findFirst({
        where: { id: BigInt(refundId), client_id: BigInt(clientId) },
      }),
    );
    if (!refund) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Reembolso no encontrado');
    return serializeRefund(refund);
  },

  /**
   * Retorna el estado de reembolso del pedido y el detalle del reembolso si existe.
   * Usado por el Comprador para ver el estado de su reembolso en "Mis pedidos".
   */
  async getRefundForOrder(clientId: number, orderId: number) {
    const order = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      tx.orders.findFirst({
        where: { id: BigInt(orderId), client_id: BigInt(clientId) },
        select: { refund_status: true, refund_modality: true, payment_method: true },
      }),
    );
    if (!order) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

    if (order.refund_status === 'REFUND_NOT_REQUIRED') {
      return { refund_status: order.refund_status, refund: null };
    }

    const refund = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      tx.refunds.findFirst({
        where: { order_id: BigInt(orderId), client_id: BigInt(clientId) },
        orderBy: { created_at: 'desc' },
      }),
    );

    return {
      refund_status: order.refund_status,
      refund_modality: order.refund_modality,
      refund: refund ? serializeRefund(refund) : null,
    };
  },

  async listRefunds(clientId: number, query: RefundListQuery) {
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
        tx.refunds.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip,
          take: query.page_size,
        }),
        tx.refunds.count({ where }),
      ]),
    );

    return {
      data: items.map(serializeRefund),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },
};

// ── Helper exportado para usar en otros servicios ─────────────────────────────

/**
 * Marca orders.refund_status = REFUND_PENDING si el pedido fue pagado.
 * Llamar dentro de un bloque withTenant existente cuando el pedido se cierra.
 *
 * No crea el registro en refunds — eso lo hace el admin explícitamente
 * después con initiateRefund.
 */
export async function setRefundPendingIfPaid(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  orderId: bigint,
  clientId: bigint,
  paymentStatus: string,
): Promise<void> {
  if (paymentStatus !== 'PAID') return;
  await tx.orders.update({
    where: { id_client_id: { id: orderId, client_id: clientId } },
    data: { refund_status: RefundStatus.REFUND_PENDING, updated_at: new Date() },
  });
}
