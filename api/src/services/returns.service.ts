/**
 * returns.service.ts — Flujo 7: Devoluciones post-cierre (Fase 3, Bloque 3.2)
 *
 * Solo aplica cuando order_status = CLOSED y closure_reason = COMPLETED_SUCCESSFULLY.
 * Solo aplica para Cliente Full (client_type = 'FULL').
 *
 * State machine de returns.status:
 *
 *   RETURN_REQUESTED
 *     → RETURN_UNDER_REVIEW          (startReview)
 *       → RETURN_APPROVED            (approveReturn  → llama refundsService.initiateRefund)
 *         Via BUYER_SHIPS_VIA_COURIER:
 *           → CUSTOMER_RETURN_IN_TRANSIT  (markInTransit)
 *             → CUSTOMER_RETURN_RECEIVED  (markReceived)
 *             → CUSTOMER_RETURN_EXPIRED   (markExpired — job automático)
 *             → CUSTOMER_RETURN_LOST      (markLost)
 *         Via CLIENT_PICKS_UP:
 *           → PICKUP_SCHEDULED        (schedulePickup)
 *             → PICKUP_OUT_FOR_COLLECTION (markPickupOutForCollection)
 *               → PICKUP_COLLECTED    (markPickupCollected)
 *                 → CUSTOMER_RETURN_RECEIVED (markReceived)
 *             → PICKUP_FAILED         (markPickupFailed)
 *       → RETURN_REJECTED             (rejectReturn)
 *     → RETURN_CANCELLED              (cancelReturn — cualquier estado no terminal)
 */

import { z } from 'zod';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { ReturnStatus, ClosureReason } from '@orkoruta/shared';
import { HttpError } from '../lib/http_error.js';
import { logger } from '../lib/logger.js';
import { refundsService } from './refunds.service.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

// ── Schemas de entrada ────────────────────────────────────────────────────────

export const requestReturnBodySchema = z.object({
  reason: z.string().min(1).max(500),
  buyer_complaint: z.string().max(2000).optional(),
});

export const rejectReturnBodySchema = z.object({
  reason: z.string().min(1).max(500),
});

export const schedulePickupBodySchema = z.object({
  courier_id: z.number().int().positive(),
});

export const cancelReturnBodySchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

export const returnListQuerySchema = z.object({
  status: z.string().optional(),
  return_mechanism: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
});

export type RequestReturnBody = z.infer<typeof requestReturnBodySchema>;
export type RejectReturnBody = z.infer<typeof rejectReturnBodySchema>;
export type SchedulePickupBody = z.infer<typeof schedulePickupBodySchema>;
export type ReturnListQuery = z.infer<typeof returnListQuerySchema>;

// ── Terminales: estados donde no se pueden hacer más transiciones ────────────

const TERMINAL_STATUSES = new Set([
  ReturnStatus.CUSTOMER_RETURN_RECEIVED,
  ReturnStatus.CUSTOMER_RETURN_EXPIRED,
  ReturnStatus.CUSTOMER_RETURN_LOST,
  ReturnStatus.RETURN_REJECTED,
  ReturnStatus.RETURN_CANCELLED,
]);

// ── Serialización ─────────────────────────────────────────────────────────────

function serializeReturn(r: {
  id: bigint;
  client_id: bigint;
  order_id: bigint;
  buyer_id: bigint;
  status: string;
  return_mechanism: string | null;
  reason: string | null;
  buyer_complaint: string | null;
  pickup_courier_user_id: bigint | null;
  requested_at: Date;
  reviewed_at: Date | null;
  approved_at: Date | null;
  received_at: Date | null;
  closed_at: Date | null;
  evidence: unknown;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: Number(r.id),
    client_id: Number(r.client_id),
    order_id: Number(r.order_id),
    buyer_id: Number(r.buyer_id),
    status: r.status,
    return_mechanism: r.return_mechanism,
    reason: r.reason,
    buyer_complaint: r.buyer_complaint,
    pickup_courier_user_id: r.pickup_courier_user_id ? Number(r.pickup_courier_user_id) : null,
    requested_at: r.requested_at.toISOString(),
    reviewed_at: r.reviewed_at?.toISOString() ?? null,
    approved_at: r.approved_at?.toISOString() ?? null,
    received_at: r.received_at?.toISOString() ?? null,
    closed_at: r.closed_at?.toISOString() ?? null,
    evidence: r.evidence,
    metadata: r.metadata,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
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
      'Las devoluciones post-cierre no aplican para Clientes API',
    );
  }
}

// ── Helper interno: cargar devolución o lanzar 404 ───────────────────────────

async function loadReturn(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  clientId: number,
  returnId: number,
) {
  const ret = await tx.returns.findFirst({
    where: { id: BigInt(returnId), client_id: BigInt(clientId) },
  });
  if (!ret) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Devolución no encontrada');
  return ret;
}

// ── Helper: registrar auditoría ───────────────────────────────────────────────

async function audit(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  clientId: number,
  actorUserId: number | null,
  actorType: string,
  actorRole: string,
  action: string,
  returnId: bigint,
  metadata?: { [key: string]: string | number | boolean | null | undefined },
): Promise<void> {
  await tx.audit_events.create({
    data: {
      client_id: BigInt(clientId),
      actor_user_id: actorUserId ? BigInt(actorUserId) : null,
      actor_type: actorType,
      actor_role: actorRole,
      action,
      entity_type: 'return',
      entity_id: returnId,
      result: 'SUCCESS',
      ...(metadata !== undefined ? { metadata } : {}),
    },
  });
}

// ── Servicio ──────────────────────────────────────────────────────────────────

export const returnsService = {
  /**
   * El Comprador solicita una devolución post-cierre.
   * Requiere: order_status = CLOSED, closure_reason = COMPLETED_SUCCESSFULLY.
   * El pedido debe pertenecer al buyerId que hace la solicitud.
   */
  async requestReturn(
    clientId: number,
    orderId: number,
    buyerId: number,
    input: RequestReturnBody,
  ) {
    await assertFullClient(clientId);

    const ret = await withTenant(clientId, 'BUYER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        select: {
          id: true,
          client_id: true,
          buyer_id: true,
          order_status: true,
          closure_reason: true,
          return_mechanism: true,
        },
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      // Aislamiento: el pedido debe pertenecer al comprador
      if (Number(order.buyer_id) !== buyerId) {
        throw new HttpError(403, 'FORBIDDEN', 'El pedido no pertenece a este comprador');
      }

      if (order.order_status !== 'CLOSED') {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `El pedido tiene order_status=${order.order_status}; se requiere CLOSED para solicitar devolución`,
        );
      }

      if (order.closure_reason !== ClosureReason.COMPLETED_SUCCESSFULLY) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `El pedido fue cerrado con closure_reason=${order.closure_reason}; se requiere COMPLETED_SUCCESSFULLY`,
        );
      }

      // Verificar que no haya ya una devolución activa para este pedido
      const existing = await tx.returns.findFirst({
        where: { order_id: BigInt(orderId), client_id: BigInt(clientId) },
        select: { id: true, status: true },
      });
      if (existing) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Ya existe una devolución para este pedido');
      }

      const created = await tx.returns.create({
        data: {
          client_id: BigInt(clientId),
          order_id: BigInt(orderId),
          buyer_id: BigInt(buyerId),
          status: ReturnStatus.RETURN_REQUESTED,
          return_mechanism: order.return_mechanism ?? null,
          reason: input.reason,
          buyer_complaint: input.buyer_complaint ?? null,
        },
      });

      // Actualizar orders.return_status
      await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.RETURN_REQUESTED, updated_at: new Date() },
      });

      await audit(tx, clientId, buyerId, 'USER', 'BUYER', 'RETURN_REQUESTED', created.id, {
        order_id: orderId,
        reason: input.reason,
      });

      logger.info({ clientId, orderId, returnId: String(created.id), buyerId }, 'Return requested');
      return created;
    });

    return serializeReturn(ret);
  },

  /**
   * Admin inicia la revisión: RETURN_REQUESTED → RETURN_UNDER_REVIEW.
   */
  async startReview(clientId: number, returnId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);

    const ret = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadReturn(tx, clientId, returnId);

      if (existing.status !== ReturnStatus.RETURN_REQUESTED) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La devolución está en estado ${existing.status}; se esperaba RETURN_REQUESTED`,
        );
      }

      const updated = await tx.returns.update({
        where: { id_client_id: { id: BigInt(returnId), client_id: BigInt(clientId) } },
        data: { status: ReturnStatus.RETURN_UNDER_REVIEW, reviewed_at: new Date(), updated_at: new Date() },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.RETURN_UNDER_REVIEW, updated_at: new Date() },
      });

      await audit(tx, clientId, actor.id, 'USER', actor.user_type, 'RETURN_REVIEW_STARTED', existing.id, {
        return_id: returnId,
        order_id: Number(existing.order_id),
      });

      logger.info({ clientId, returnId, actorId: actor.id }, 'Return review started');
      return updated;
    });

    return serializeReturn(ret);
  },

  /**
   * Admin aprueba: RETURN_UNDER_REVIEW → RETURN_APPROVED.
   * Automáticamente inicia el reembolso (refundsService.initiateRefund).
   * La llamada al refund puede fallar si el pedido no está en estado REFUND_PENDING;
   * en ese caso la devolución avanza igualmente pero se loguea la advertencia.
   */
  async approveReturn(clientId: number, returnId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);

    const ret = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadReturn(tx, clientId, returnId);

      if (existing.status !== ReturnStatus.RETURN_UNDER_REVIEW) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La devolución está en estado ${existing.status}; se esperaba RETURN_UNDER_REVIEW`,
        );
      }

      const now = new Date();
      const updated = await tx.returns.update({
        where: { id_client_id: { id: BigInt(returnId), client_id: BigInt(clientId) } },
        data: { status: ReturnStatus.RETURN_APPROVED, approved_at: now, updated_at: now },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.RETURN_APPROVED, updated_at: now },
      });

      await audit(tx, clientId, actor.id, 'USER', actor.user_type, 'RETURN_APPROVED', existing.id, {
        return_id: returnId,
        order_id: Number(existing.order_id),
      });

      logger.info({ clientId, returnId, actorId: actor.id }, 'Return approved');
      return updated;
    });

    // Llamar refundsService.initiateRefund post-transacción
    // Se registra en audit_events dentro de initiateRefund
    // Si falla (p.ej. refund_status no es REFUND_PENDING), loguear sin revertir
    try {
      await refundsService.initiateRefund(
        clientId,
        Number(ret.order_id),
        { amount: 0, refund_modality: 'STORE_CREDIT' },
        actor,
      );
    } catch (err) {
      logger.warn(
        { clientId, returnId, orderId: Number(ret.order_id), err },
        'initiateRefund after approveReturn failed — devolución aprobada, revisar estado de reembolso manualmente',
      );
    }

    return serializeReturn(ret);
  },

  /**
   * Admin rechaza: RETURN_UNDER_REVIEW → RETURN_REJECTED.
   */
  async rejectReturn(clientId: number, returnId: number, reason: string, actor: AuthenticatedUser) {
    await assertFullClient(clientId);

    const ret = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadReturn(tx, clientId, returnId);

      if (existing.status !== ReturnStatus.RETURN_UNDER_REVIEW) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La devolución está en estado ${existing.status}; se esperaba RETURN_UNDER_REVIEW`,
        );
      }

      const updated = await tx.returns.update({
        where: { id_client_id: { id: BigInt(returnId), client_id: BigInt(clientId) } },
        data: {
          status: ReturnStatus.RETURN_REJECTED,
          metadata: { rejection_reason: reason },
          updated_at: new Date(),
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.RETURN_REJECTED, updated_at: new Date() },
      });

      await audit(tx, clientId, actor.id, 'USER', actor.user_type, 'RETURN_REJECTED', existing.id, {
        return_id: returnId,
        reason,
      });

      logger.info({ clientId, returnId, actorId: actor.id, reason }, 'Return rejected');
      return updated;
    });

    return serializeReturn(ret);
  },

  // ── BUYER_SHIPS_VIA_COURIER ──────────────────────────────────────────────────

  /**
   * RETURN_APPROVED → CUSTOMER_RETURN_IN_TRANSIT (mecánico: el comprador envía).
   */
  async markInTransit(clientId: number, returnId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);

    const ret = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadReturn(tx, clientId, returnId);

      if (existing.status !== ReturnStatus.RETURN_APPROVED) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La devolución está en estado ${existing.status}; se esperaba RETURN_APPROVED`,
        );
      }
      if (existing.return_mechanism !== 'BUYER_SHIPS_VIA_COURIER') {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          'markInTransit aplica solo para return_mechanism = BUYER_SHIPS_VIA_COURIER',
        );
      }

      const updated = await tx.returns.update({
        where: { id_client_id: { id: BigInt(returnId), client_id: BigInt(clientId) } },
        data: {
          status: ReturnStatus.CUSTOMER_RETURN_IN_TRANSIT,
          updated_at: new Date(),
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.CUSTOMER_RETURN_IN_TRANSIT, updated_at: new Date() },
      });

      await audit(tx, clientId, actor.id, 'USER', actor.user_type, 'RETURN_IN_TRANSIT', existing.id, {
        return_id: returnId,
      });

      logger.info({ clientId, returnId }, 'Return marked in transit');
      return updated;
    });

    return serializeReturn(ret);
  },

  /**
   * CUSTOMER_RETURN_IN_TRANSIT | PICKUP_COLLECTED → CUSTOMER_RETURN_RECEIVED.
   * Aplica tanto para BUYER_SHIPS_VIA_COURIER como para CLIENT_PICKS_UP.
   */
  async markReceived(clientId: number, returnId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);

    const ret = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadReturn(tx, clientId, returnId);

      const validPrevious = new Set([
        ReturnStatus.CUSTOMER_RETURN_IN_TRANSIT,
        ReturnStatus.PICKUP_COLLECTED,
      ]);

      if (!validPrevious.has(existing.status as ReturnStatus)) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La devolución está en estado ${existing.status}; se esperaba CUSTOMER_RETURN_IN_TRANSIT o PICKUP_COLLECTED`,
        );
      }

      const now = new Date();
      const updated = await tx.returns.update({
        where: { id_client_id: { id: BigInt(returnId), client_id: BigInt(clientId) } },
        data: {
          status: ReturnStatus.CUSTOMER_RETURN_RECEIVED,
          received_at: now,
          closed_at: now,
          updated_at: now,
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.CUSTOMER_RETURN_RECEIVED, updated_at: now },
      });

      await audit(tx, clientId, actor.id, 'USER', actor.user_type, 'RETURN_RECEIVED', existing.id, {
        return_id: returnId,
      });

      logger.info({ clientId, returnId }, 'Return received');
      return updated;
    });

    return serializeReturn(ret);
  },

  /**
   * Marca expirado (job automático): CUSTOMER_RETURN_IN_TRANSIT → CUSTOMER_RETURN_EXPIRED.
   */
  async markExpired(clientId: number, returnId: number) {
    await withTenant(clientId, 'ADMIN_RUTA', async (tx) => {
      const existing = await tx.returns.findFirst({
        where: { id: BigInt(returnId), client_id: BigInt(clientId) },
        select: { id: true, status: true, order_id: true },
      });
      if (!existing) return;
      if (existing.status !== ReturnStatus.CUSTOMER_RETURN_IN_TRANSIT) return;

      await tx.returns.update({
        where: { id_client_id: { id: BigInt(returnId), client_id: BigInt(clientId) } },
        data: {
          status: ReturnStatus.CUSTOMER_RETURN_EXPIRED,
          closed_at: new Date(),
          updated_at: new Date(),
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.CUSTOMER_RETURN_EXPIRED, updated_at: new Date() },
      });

      await audit(tx, clientId, null, 'SYSTEM', 'ADMIN_RUTA', 'RETURN_EXPIRED', existing.id, {
        return_id: returnId,
      });

      logger.info({ clientId, returnId }, 'Return marked expired (system job)');
    });
  },

  /**
   * Marca perdido: CUSTOMER_RETURN_IN_TRANSIT → CUSTOMER_RETURN_LOST.
   */
  async markLost(clientId: number, returnId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);

    const ret = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadReturn(tx, clientId, returnId);

      if (existing.status !== ReturnStatus.CUSTOMER_RETURN_IN_TRANSIT) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La devolución está en estado ${existing.status}; se esperaba CUSTOMER_RETURN_IN_TRANSIT`,
        );
      }

      const updated = await tx.returns.update({
        where: { id_client_id: { id: BigInt(returnId), client_id: BigInt(clientId) } },
        data: {
          status: ReturnStatus.CUSTOMER_RETURN_LOST,
          closed_at: new Date(),
          updated_at: new Date(),
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.CUSTOMER_RETURN_LOST, updated_at: new Date() },
      });

      await audit(tx, clientId, actor.id, 'USER', actor.user_type, 'RETURN_LOST', existing.id, {
        return_id: returnId,
      });

      logger.info({ clientId, returnId, actorId: actor.id }, 'Return marked lost');
      return updated;
    });

    return serializeReturn(ret);
  },

  // ── CLIENT_PICKS_UP ──────────────────────────────────────────────────────────

  /**
   * RETURN_APPROVED → PICKUP_SCHEDULED (un repartidor va a recoger).
   */
  async schedulePickup(clientId: number, returnId: number, courierId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);

    const ret = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadReturn(tx, clientId, returnId);

      if (existing.status !== ReturnStatus.RETURN_APPROVED) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La devolución está en estado ${existing.status}; se esperaba RETURN_APPROVED`,
        );
      }
      if (existing.return_mechanism !== 'CLIENT_PICKS_UP') {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          'schedulePickup aplica solo para return_mechanism = CLIENT_PICKS_UP',
        );
      }

      const updated = await tx.returns.update({
        where: { id_client_id: { id: BigInt(returnId), client_id: BigInt(clientId) } },
        data: {
          status: ReturnStatus.PICKUP_SCHEDULED,
          pickup_courier_user_id: BigInt(courierId),
          updated_at: new Date(),
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.PICKUP_SCHEDULED, updated_at: new Date() },
      });

      await audit(tx, clientId, actor.id, 'USER', actor.user_type, 'RETURN_PICKUP_SCHEDULED', existing.id, {
        return_id: returnId,
        courier_id: courierId,
      });

      logger.info({ clientId, returnId, courierId }, 'Return pickup scheduled');
      return updated;
    });

    return serializeReturn(ret);
  },

  /**
   * PICKUP_SCHEDULED → PICKUP_OUT_FOR_COLLECTION.
   */
  async markPickupOutForCollection(clientId: number, returnId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);

    const ret = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadReturn(tx, clientId, returnId);

      if (existing.status !== ReturnStatus.PICKUP_SCHEDULED) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La devolución está en estado ${existing.status}; se esperaba PICKUP_SCHEDULED`,
        );
      }

      const updated = await tx.returns.update({
        where: { id_client_id: { id: BigInt(returnId), client_id: BigInt(clientId) } },
        data: {
          status: ReturnStatus.PICKUP_OUT_FOR_COLLECTION,
          updated_at: new Date(),
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.PICKUP_OUT_FOR_COLLECTION, updated_at: new Date() },
      });

      await audit(tx, clientId, actor.id, 'USER', actor.user_type, 'RETURN_PICKUP_OUT_FOR_COLLECTION', existing.id, {
        return_id: returnId,
      });

      logger.info({ clientId, returnId }, 'Return pickup out for collection');
      return updated;
    });

    return serializeReturn(ret);
  },

  /**
   * PICKUP_OUT_FOR_COLLECTION → PICKUP_COLLECTED.
   */
  async markPickupCollected(clientId: number, returnId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);

    const ret = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadReturn(tx, clientId, returnId);

      if (existing.status !== ReturnStatus.PICKUP_OUT_FOR_COLLECTION) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La devolución está en estado ${existing.status}; se esperaba PICKUP_OUT_FOR_COLLECTION`,
        );
      }

      const updated = await tx.returns.update({
        where: { id_client_id: { id: BigInt(returnId), client_id: BigInt(clientId) } },
        data: {
          status: ReturnStatus.PICKUP_COLLECTED,
          updated_at: new Date(),
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.PICKUP_COLLECTED, updated_at: new Date() },
      });

      await audit(tx, clientId, actor.id, 'USER', actor.user_type, 'RETURN_PICKUP_COLLECTED', existing.id, {
        return_id: returnId,
      });

      logger.info({ clientId, returnId }, 'Return pickup collected');
      return updated;
    });

    return serializeReturn(ret);
  },

  /**
   * PICKUP_SCHEDULED | PICKUP_OUT_FOR_COLLECTION → PICKUP_FAILED.
   */
  async markPickupFailed(clientId: number, returnId: number, reason: string, actor: AuthenticatedUser) {
    await assertFullClient(clientId);

    const ret = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadReturn(tx, clientId, returnId);

      const validPrevious = new Set([
        ReturnStatus.PICKUP_SCHEDULED,
        ReturnStatus.PICKUP_OUT_FOR_COLLECTION,
      ]);

      if (!validPrevious.has(existing.status as ReturnStatus)) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La devolución está en estado ${existing.status}; se esperaba PICKUP_SCHEDULED o PICKUP_OUT_FOR_COLLECTION`,
        );
      }

      const updated = await tx.returns.update({
        where: { id_client_id: { id: BigInt(returnId), client_id: BigInt(clientId) } },
        data: {
          status: ReturnStatus.PICKUP_FAILED,
          metadata: { failure_reason: reason },
          updated_at: new Date(),
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.PICKUP_FAILED, updated_at: new Date() },
      });

      await audit(tx, clientId, actor.id, 'USER', actor.user_type, 'RETURN_PICKUP_FAILED', existing.id, {
        return_id: returnId,
        reason,
      });

      logger.info({ clientId, returnId, reason }, 'Return pickup failed');
      return updated;
    });

    return serializeReturn(ret);
  },

  /**
   * Cancela la devolución desde cualquier estado no-terminal.
   * Si existe un reembolso en estado PENDING para la misma orden, lo cancela
   * (lo marca con status FAILED para que no bloquee futuros intentos).
   */
  async cancelReturn(clientId: number, returnId: number, actor: AuthenticatedUser) {
    await assertFullClient(clientId);

    const ret = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await loadReturn(tx, clientId, returnId);

      if (TERMINAL_STATUSES.has(existing.status as ReturnStatus)) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La devolución está en estado terminal ${existing.status}; no se puede cancelar`,
        );
      }

      const now = new Date();
      const updated = await tx.returns.update({
        where: { id_client_id: { id: BigInt(returnId), client_id: BigInt(clientId) } },
        data: {
          status: ReturnStatus.RETURN_CANCELLED,
          closed_at: now,
          updated_at: now,
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
        data: { return_status: ReturnStatus.RETURN_CANCELLED, updated_at: now },
      });

      // Si hay un reembolso PENDING para este pedido, marcarlo como no requerido
      // (El sistema de reembolsos usa status='PENDING' para el estado inicial)
      const pendingRefund = await tx.refunds.findFirst({
        where: {
          order_id: existing.order_id,
          client_id: BigInt(clientId),
          status: 'PENDING',
        },
        select: { id: true },
      });

      if (pendingRefund) {
        await tx.refunds.update({
          where: { id_client_id: { id: pendingRefund.id, client_id: BigInt(clientId) } },
          data: {
            status: 'FAILED',
            reason: 'Devolución cancelada — reembolso no requerido',
            updated_at: now,
          },
        });

        // Limpiar refund_status de la orden
        await tx.orders.update({
          where: { id_client_id: { id: existing.order_id, client_id: BigInt(clientId) } },
          data: { refund_status: 'REFUND_NOT_REQUIRED', updated_at: now },
        });

        logger.info(
          { clientId, returnId, refundId: String(pendingRefund.id) },
          'Pending refund marked as not required due to return cancellation',
        );
      }

      await audit(tx, clientId, actor.id, 'USER', actor.user_type, 'RETURN_CANCELLED', existing.id, {
        return_id: returnId,
        previous_status: existing.status,
        refund_cancelled: !!pendingRefund,
      });

      logger.info({ clientId, returnId, actorId: actor.id }, 'Return cancelled');
      return updated;
    });

    return serializeReturn(ret);
  },

  // ── Consultas ─────────────────────────────────────────────────────────────────

  async getReturn(clientId: number, returnId: number) {
    const ret = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.returns.findFirst({
        where: { id: BigInt(returnId), client_id: BigInt(clientId) },
      }),
    );
    if (!ret) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Devolución no encontrada');
    return serializeReturn(ret);
  },

  /**
   * Obtiene la devolución de un pedido específico para el comprador.
   */
  async getReturnForOrder(clientId: number, orderId: number, buyerId: number) {
    const order = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      tx.orders.findFirst({
        where: { id: BigInt(orderId), client_id: BigInt(clientId), buyer_id: BigInt(buyerId) },
        select: { id: true, return_status: true },
      }),
    );
    if (!order) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

    const ret = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      tx.returns.findFirst({
        where: { order_id: BigInt(orderId), client_id: BigInt(clientId), buyer_id: BigInt(buyerId) },
        orderBy: { created_at: 'desc' },
      }),
    );

    return {
      return_status: order.return_status,
      return: ret ? serializeReturn(ret) : null,
    };
  },

  async listReturns(clientId: number, query: ReturnListQuery) {
    const skip = (query.page - 1) * query.page_size;
    const where = {
      client_id: BigInt(clientId),
      ...(query.status ? { status: query.status } : {}),
      ...(query.return_mechanism ? { return_mechanism: query.return_mechanism } : {}),
    };

    const [items, total] = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      Promise.all([
        tx.returns.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip,
          take: query.page_size,
        }),
        tx.returns.count({ where }),
      ]),
    );

    return {
      data: items.map(serializeReturn),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },
};
