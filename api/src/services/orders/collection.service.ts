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
import { withTenant } from '@orkoruta/db';
import { HttpError } from '../../lib/http_error.js';
import { assertTransition } from './state_machine.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

export const recordCollectionBodySchema = z.object({
  amount: z.number().positive('El monto debe ser mayor a cero'),
  currency: z.string().length(3).default('COP'),
  method: z.enum(['CASH', 'ELECTRONIC']),
  electronic_submethod: z.enum(['DATAFONO', 'QR', 'BANK_TRANSFER', 'PAYMENT_LINK']).optional(),
  external_txn_id: z.string().max(255).optional(),
  notes: z.string().max(500).optional(),
  /** URL de evidencia: el cliente sube la foto por su cuenta y envía la URL. */
  evidence_url: z.string().url().max(1000).optional(),
});

/**
 * Alias de compatibilidad para courier_orders.ts que importa este nombre.
 */
export const recordCollectionSchema = recordCollectionBodySchema;

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
  async recordCollection(clientId: number, courierId: number, orderId: number, input: RecordCollectionBody) {
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

      return {
        payment_id: Number(payment.id),
        order_id: orderId,
        payment_status: PaymentStatus.PAYMENT_COLLECTED,
        order_status: targetStatus,
        amount: validatedInput.amount,
        currency: validatedInput.currency,
        evidence_url: validatedInput.evidence_url ?? null,
        collected_at: payment.collected_at?.toISOString() ?? now.toISOString(),
      };
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
