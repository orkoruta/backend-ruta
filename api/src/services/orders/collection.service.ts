/**
 * collection.service.ts
 *
 * Servicio para cobro contra entrega (COD — Cash/Electronic On Delivery).
 *
 * REGLA 4.1 — Principio financiero:
 *   RUTA NO custodia ni transfiere dinero. El repartidor registra el cobro
 *   como evidencia operativa para que el Cliente realice su conciliación.
 *   El dinero recolectado pertenece operativamente al Cliente.
 */

import { z } from 'zod';
import { OrderStatus, PaymentStatus, PaymentMethod } from '@orkoruta/shared';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from '../../lib/http_error.js';
import { assertTransition } from './state_machine.js';
import { logger } from '../../lib/logger.js';
import { processWebhookEvent } from '../webhooks_outgoing.service.js';
import { getMaintenanceBoss } from '../../jobs/maintenance_boss.js';
import {
  recordCollectionSchema,
  isDataImageUri,
  MAX_EVIDENCE_DATA_URI_LENGTH,
} from '@orkoruta/shared';

/*
 * El esquema del cobro y sus validadores viven en `@orkoruta/shared`: la copia
 * publicada allí **no tenía `evidence_url`**, así que quien la usara mandaba el
 * cobro sin la foto del recibo. Ahora hay una sola definición.
 *
 * `recordCollectionBodySchema` se conserva como alias porque varias rutas lo
 * importan con ese nombre.
 */
export const recordCollectionBodySchema = recordCollectionSchema;
export { recordCollectionSchema, isDataImageUri, MAX_EVIDENCE_DATA_URI_LENGTH };

// ── Webhook helper ────────────────────────────────────────────────────────────

function emitWebhook(
  clientId: number,
  orderId: number,
  eventType: string,
  data: Record<string, unknown>,
): void {
  const boss = getMaintenanceBoss();
  if (!boss) return;

  const payload = {
    event_type: eventType,
    client_id: clientId,
    order_id: orderId,
    timestamp: new Date().toISOString(),
    data,
  };

  setImmediate(() => {
    processWebhookEvent(eventType, payload, clientId, boss).catch((err: unknown) => {
      logger.warn({ err, clientId, orderId, eventType }, 'collection: error emitiendo webhook');
    });
  });
}


// ── Schemas ───────────────────────────────────────────────────────────────────



export type RecordCollectionBody = z.infer<typeof recordCollectionBodySchema>;

// ── Allowed states ────────────────────────────────────────────────────────────

const ELECTRONIC_COLLECTION_STATES = new Set([OrderStatus.PAYMENT_COLLECTION_PENDING]);
const CASH_COLLECTION_STATES = new Set([OrderStatus.CASH_COLLECTION_PENDING]);
const INITIATE_COLLECTION_STATES = new Set([OrderStatus.ARRIVED_AT_CUSTOMER]);

// ── Service ───────────────────────────────────────────────────────────────────

export const collectionService = {
  /**
   * Transiciona ARRIVED_AT_CUSTOMER al estado de cobro correspondiente:
   *   - ELECTRONIC_ON_DELIVERY → PAYMENT_COLLECTION_PENDING
   *   - CASH_ON_DELIVERY       → CASH_COLLECTION_PENDING
   *
   * Usa optimistic lock con `version`.
   *
   * @param clientId  ID del tenant
   * @param courierId ID del courier autenticado
   * @param orderId   ID del pedido
   */
  async initiateCollection(clientId: number, courierId: number, orderId: number) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        select: {
          id: true,
          client_id: true,
          courier_user_id: true,
          order_status: true,
          payment_status: true,
          payment_method: true,
          version: true,
        },
      });

      if (!order) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      if (!INITIATE_COLLECTION_STATES.has(order.order_status as OrderStatus)) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `No se puede iniciar cobro desde el estado ${order.order_status}`,
          { current: order.order_status },
        );
      }

      let targetStatus: OrderStatus;
      if (order.payment_method === PaymentMethod.ELECTRONIC_ON_DELIVERY) {
        targetStatus = OrderStatus.PAYMENT_COLLECTION_PENDING;
      } else if (order.payment_method === PaymentMethod.CASH_ON_DELIVERY) {
        targetStatus = OrderStatus.CASH_COLLECTION_PENDING;
      } else {
        throw new HttpError(422, 'INVALID_STATE_TRANSITION', 'Este pedido no requiere cobro contra entrega', {
          payment_method: order.payment_method,
        });
      }

      assertTransition(order.order_status as OrderStatus, targetStatus, 'COURIER', {
        paymentStatus: order.payment_status,
      });

      const updated = await tx.orders.updateMany({
        where: { id: BigInt(orderId), client_id: BigInt(clientId), version: order.version },
        data: { order_status: targetStatus, updated_at: new Date(), version: { increment: 1 } },
      });

      if (updated.count === 0) {
        throw new HttpError(409, 'OPTIMISTIC_LOCK_FAILED', 'El pedido fue modificado concurrentemente. Reintenta la operación.');
      }

      return { order_id: orderId, order_status: targetStatus, payment_method: order.payment_method };
    });
  },

  /**
   * Registra un cobro exitoso contra entrega.
   *
   * Acepta pedidos en:
   * - PAYMENT_COLLECTION_PENDING (cobro electrónico)
   * - CASH_COLLECTION_PENDING (cobro efectivo)
   * - ARRIVED_AT_CUSTOMER con CASH_ON_DELIVERY (flujo simplificado)
   *
   * Crea registro en `payments` con status='CONFIRMED'.
   * NOTA (regla 4.1): RUTA solo registra evidencia. No transfiere ni custodia dinero.
   *
   * @param clientId  ID del tenant
   * @param courierId ID del courier autenticado
   * @param orderId   ID del pedido
   * @param input     Datos del cobro
   */
  async recordCollection(clientId: number, courierId: number, orderId: number, input: RecordCollectionBody, _evidenceFile?: Express.Multer.File) {
    const validatedInput = recordCollectionBodySchema.parse(input);

    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        select: {
          id: true,
          client_id: true,
          courier_user_id: true,
          order_status: true,
          payment_status: true,
          payment_method: true,
          version: true,
        },
      });

      if (!order) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      const currentStatus = order.order_status as OrderStatus;

      // Validate payment method and state, determine target status
      let targetStatus: OrderStatus;

      if (ELECTRONIC_COLLECTION_STATES.has(currentStatus)) {
        // PAYMENT_COLLECTION_PENDING → PAYMENT_COLLECTED_ELECTRONIC
        assertTransition(currentStatus, OrderStatus.PAYMENT_COLLECTED_ELECTRONIC, 'COURIER');
        targetStatus = OrderStatus.PAYMENT_COLLECTED_ELECTRONIC;
      } else if (CASH_COLLECTION_STATES.has(currentStatus)) {
        // CASH_COLLECTION_PENDING → PAYMENT_COLLECTED_CASH
        assertTransition(currentStatus, OrderStatus.PAYMENT_COLLECTED_CASH, 'COURIER');
        targetStatus = OrderStatus.PAYMENT_COLLECTED_CASH;
      } else if (
        currentStatus === OrderStatus.ARRIVED_AT_CUSTOMER &&
        (order.payment_method === PaymentMethod.CASH_ON_DELIVERY ||
          order.payment_method === PaymentMethod.ELECTRONIC_ON_DELIVERY)
      ) {
        // Simplified path: directly from ARRIVED_AT_CUSTOMER (transitions through collection pending state)
        targetStatus =
          validatedInput.method === 'CASH'
            ? OrderStatus.PAYMENT_COLLECTED_CASH
            : OrderStatus.PAYMENT_COLLECTED_ELECTRONIC;
      } else if (currentStatus === OrderStatus.ARRIVED_AT_CUSTOMER) {
        // Non-COD payment method → cannot collect
        throw new HttpError(422, 'INVALID_STATE_TRANSITION', 'Este pedido no requiere cobro contra entrega', {
          payment_method: order.payment_method,
        });
      } else {
        throw new HttpError(422, 'INVALID_STATE_TRANSITION', `No se puede registrar cobro en estado ${currentStatus}`, {
          current: currentStatus,
        });
      }

      // Construir evidencia (sin custodiar dinero — regla 4.1)
      const evidenceObj: Record<string, string> = {};
      if (validatedInput.evidence_url) evidenceObj['url'] = validatedInput.evidence_url;
      if (validatedInput.notes) evidenceObj['notes'] = validatedInput.notes;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const collectionEvidence: any = Object.keys(evidenceObj).length > 0 ? evidenceObj : undefined;

      const now = new Date();
      const payment = await tx.payments.create({
        data: {
          client_id: BigInt(clientId),
          order_id: BigInt(orderId),
          payment_method: order.payment_method,
          payment_method_submethod: validatedInput.electronic_submethod ?? null,
          amount: validatedInput.amount,
          currency: validatedInput.currency,
          status: 'CONFIRMED',
          external_transaction_id: validatedInput.external_txn_id ?? null,
          collected_by_courier_user_id: BigInt(courierId),
          collected_at: now,
          collection_evidence: collectionEvidence,
        },
        select: { id: true, amount: true, currency: true, status: true, collected_at: true },
      });

      await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: {
          payment_status: PaymentStatus.PAYMENT_COLLECTED,
          order_status: targetStatus,
          updated_at: now,
          version: { increment: 1 },
        },
      });

      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(courierId),
          actor_type: 'USER',
          actor_role: 'COURIER',
          action: 'record_collection',
          entity_type: 'order',
          entity_id: BigInt(orderId),
          metadata: {
            payment_id: Number(payment.id),
            amount: validatedInput.amount,
            currency: validatedInput.currency,
            method: validatedInput.method,
            order_status_before: currentStatus,
            order_status_after: targetStatus,
          },
          result: 'SUCCESS',
        },
      });

      const collectionResult = {
        payment_id: Number(payment.id),
        order_id: orderId,
        payment_status: PaymentStatus.PAYMENT_COLLECTED,
        order_status: targetStatus,
        amount: validatedInput.amount,
        currency: validatedInput.currency,
        // La foto embebida no se devuelve: el cliente ya la tiene y repetirla
        // duplicaría un megabyte en la respuesta. Las URLs sí se echan de vuelta.
        evidence_url: isDataImageUri(validatedInput.evidence_url ?? '')
          ? null
          : (validatedInput.evidence_url ?? null),
        /** Indica que sí quedó evidencia aunque no se devuelva su contenido. */
        has_evidence: Boolean(validatedInput.evidence_url),
        collected_at: payment.collected_at?.toISOString() ?? now.toISOString(),
      };

      // F2.BACK-6 — PAYMENT_COLLECTED webhook
      emitWebhook(clientId, orderId, 'PAYMENT_COLLECTED', {
        payment_status: PaymentStatus.PAYMENT_COLLECTED,
        order_status: targetStatus,
        payment_method: order.payment_method,
        amount: validatedInput.amount,
        currency: validatedInput.currency,
      });

      return collectionResult;
    });
  },

  /**
   * Registra un cobro fallido (definitivo).
   *
   * - Desde PAYMENT_COLLECTION_PENDING → RETURN_TO_ORIGIN
   * - Desde CASH_COLLECTION_PENDING   → CASH_PAYMENT_REJECTED → RETURN_TO_ORIGIN
   *
   * Actualiza payment_status = PAYMENT_NOT_COLLECTED.
   * Usa optimistic lock con `version`.
   *
   * @param clientId  ID del tenant
   * @param courierId ID del courier autenticado
   * @param orderId   ID del pedido
   */
  /**
   * Devuelve la evidencia del cobro de un pedido: la foto del recibo tal como
   * se guardó (data URI o URL), más el contexto del cobro.
   *
   * Va en su propio endpoint y no dentro del detalle del pedido a propósito: la
   * foto embebida pesa cientos de kB y cargarla en cada consulta del pedido
   * penalizaría a todas las pantallas que ni la muestran.
   *
   * @param courierUserId Si viene, se exige que el pedido esté asignado a ese
   *                      repartidor. El admin del Cliente lo omite.
   */
  async getCollectionEvidence(clientId: number, orderId: number, courierUserId?: number) {
    return withTenantReadOnly(clientId, courierUserId ? 'COURIER' : 'ADMIN_CLIENT', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        select: { id: true, courier_user_id: true },
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (
        courierUserId !== undefined &&
        (order.courier_user_id === null || Number(order.courier_user_id) !== courierUserId)
      ) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      // Un pedido puede tener varios pagos (reintentos de cobro). Se filtra en
      // memoria porque la evidencia vive dentro de un JSONB: son pocas filas y
      // así no hace falta una condición sobre el contenido del JSON.
      const payments = await tx.payments.findMany({
        where: { client_id: BigInt(clientId), order_id: BigInt(orderId) },
        orderBy: { collected_at: 'desc' },
        select: {
          id: true,
          amount: true,
          currency: true,
          payment_method: true,
          payment_method_submethod: true,
          collected_at: true,
          collection_evidence: true,
        },
      });

      type StoredEvidence = {
        url?: string;
        notes?: string;
        /** Fecha en que el job de purga borró la foto por vencimiento. */
        purged_at?: string;
        had_evidence?: boolean;
      } | null;

      const rows = payments.map((p) => ({
        payment: p,
        evidence: (p.collection_evidence ?? null) as StoredEvidence,
      }));

      const found = rows.find((row) => Boolean(row.evidence?.url));

      if (!found) {
        // La foto pudo existir y haber vencido. Decir "no tiene evidencia"
        // sería mentir: hubo respaldo, solo que ya se purgó. Se distingue con
        // un código propio para que la UI pueda explicarlo.
        const purged = rows.find((row) => row.evidence?.had_evidence);
        if (purged) {
          throw new HttpError(
            410,
            'EVIDENCE_EXPIRED',
            'La foto del recibo venció y fue eliminada',
            { purged_at: purged.evidence?.purged_at ?? null },
          );
        }
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Este pedido no tiene evidencia de cobro');
      }

      const { payment, evidence } = found;

      return {
        payment_id: Number(payment.id),
        order_id: orderId,
        /** Data URI (`data:image/…;base64,…`) o URL http(s), según cómo se guardó. */
        evidence_url: evidence!.url!,
        notes: evidence?.notes ?? null,
        amount: Number(payment.amount),
        currency: payment.currency,
        payment_method: payment.payment_method,
        payment_method_submethod: payment.payment_method_submethod,
        collected_at: payment.collected_at?.toISOString() ?? null,
      };
    });
  },

  async recordFailedCollection(clientId: number, courierId: number, orderId: number) {
    return withTenant(clientId, 'COURIER', async (tx) => {
      const order = await tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        select: {
          id: true,
          client_id: true,
          courier_user_id: true,
          order_status: true,
          payment_status: true,
          payment_method: true,
          version: true,
        },
      });

      if (!order) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      const currentStatus = order.order_status as OrderStatus;
      const now = new Date();

      if (ELECTRONIC_COLLECTION_STATES.has(currentStatus)) {
        // PAYMENT_COLLECTION_PENDING → RETURN_TO_ORIGIN
        assertTransition(currentStatus, OrderStatus.RETURN_TO_ORIGIN, 'COURIER');

        const updated = await tx.orders.updateMany({
          where: { id: BigInt(orderId), client_id: BigInt(clientId), version: order.version },
          data: {
            payment_status: PaymentStatus.PAYMENT_NOT_COLLECTED,
            order_status: OrderStatus.RETURN_TO_ORIGIN,
            updated_at: now,
            version: { increment: 1 },
          },
        });

        if (updated.count === 0) {
          throw new HttpError(409, 'OPTIMISTIC_LOCK_FAILED', 'El pedido fue modificado concurrentemente. Reintenta la operación.');
        }

        await tx.audit_events.create({
          data: {
            client_id: BigInt(clientId),
            actor_user_id: BigInt(courierId),
            actor_type: 'USER',
            actor_role: 'COURIER',
            action: 'record_failed_collection',
            entity_type: 'order',
            entity_id: BigInt(orderId),
            metadata: {
              payment_method: order.payment_method,
              order_status_before: currentStatus,
              order_status_after: OrderStatus.RETURN_TO_ORIGIN,
            },
            result: 'SUCCESS',
          },
        });

        // F2.BACK-6 — ORDER_RETURN_TO_ORIGIN webhook (electronic failed collection)
        emitWebhook(clientId, orderId, 'ORDER_RETURN_TO_ORIGIN', {
          order_status: OrderStatus.RETURN_TO_ORIGIN,
          payment_status: PaymentStatus.PAYMENT_NOT_COLLECTED,
          payment_method: order.payment_method,
        });

        return {
          order_id: orderId,
          payment_status: PaymentStatus.PAYMENT_NOT_COLLECTED,
          order_status: OrderStatus.RETURN_TO_ORIGIN,
        };
      } else if (CASH_COLLECTION_STATES.has(currentStatus)) {
        // CASH_COLLECTION_PENDING → CASH_PAYMENT_REJECTED → RETURN_TO_ORIGIN
        assertTransition(currentStatus, OrderStatus.CASH_PAYMENT_REJECTED, 'COURIER');

        const step1 = await tx.orders.updateMany({
          where: { id: BigInt(orderId), client_id: BigInt(clientId), version: order.version },
          data: {
            payment_status: PaymentStatus.PAYMENT_NOT_COLLECTED,
            order_status: OrderStatus.CASH_PAYMENT_REJECTED,
            updated_at: now,
            version: { increment: 1 },
          },
        });

        if (step1.count === 0) {
          throw new HttpError(409, 'OPTIMISTIC_LOCK_FAILED', 'El pedido fue modificado concurrentemente. Reintenta la operación.');
        }

        assertTransition(OrderStatus.CASH_PAYMENT_REJECTED, OrderStatus.RETURN_TO_ORIGIN, 'COURIER');

        await tx.orders.updateMany({
          where: { id: BigInt(orderId), client_id: BigInt(clientId) },
          data: { order_status: OrderStatus.RETURN_TO_ORIGIN, updated_at: now, version: { increment: 1 } },
        });

        await tx.audit_events.create({
          data: {
            client_id: BigInt(clientId),
            actor_user_id: BigInt(courierId),
            actor_type: 'USER',
            actor_role: 'COURIER',
            action: 'record_failed_collection',
            entity_type: 'order',
            entity_id: BigInt(orderId),
            metadata: {
              payment_method: order.payment_method,
              order_status_before: currentStatus,
              order_status_after: OrderStatus.RETURN_TO_ORIGIN,
            },
            result: 'SUCCESS',
          },
        });

        // F2.BACK-6 — ORDER_RETURN_TO_ORIGIN webhook (cash failed collection)
        emitWebhook(clientId, orderId, 'ORDER_RETURN_TO_ORIGIN', {
          order_status: OrderStatus.RETURN_TO_ORIGIN,
          payment_status: PaymentStatus.PAYMENT_NOT_COLLECTED,
          payment_method: order.payment_method,
        });

        return {
          order_id: orderId,
          payment_status: PaymentStatus.PAYMENT_NOT_COLLECTED,
          order_status: OrderStatus.RETURN_TO_ORIGIN,
        };
      } else {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `No se puede registrar cobro fallido desde el estado ${currentStatus}`,
          { current: currentStatus },
        );
      }
    });
  },
};
