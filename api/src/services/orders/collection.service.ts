import { PaymentStatus } from '@orkoruta/shared';
import { recordCollectionSchema } from '@orkoruta/shared';
import type { RecordCollectionInput } from '@orkoruta/shared';
import { withTenant } from '@orkoruta/db';
import { HttpError } from '../../lib/http_error.js';

// Payment methods that require COD collection before delivery
const COD_PAYMENT_METHODS = new Set(['CASH_ON_DELIVERY', 'ELECTRONIC_ON_DELIVERY']);

// States that allow a courier to register COD collection
const COD_COLLECTION_ALLOWED_STATUSES = new Set([
  'ARRIVED_AT_CUSTOMER',
  'PAYMENT_COLLECTION_PENDING',
  'CASH_COLLECTION_PENDING',
]);

export { recordCollectionSchema };
export type { RecordCollectionInput };

export const collectionService = {
  /**
   * POST /courier/orders/:id/record-collection
   *
   * Registers a COD collection by the courier. Evidence upload is a stub for
   * Sprint 6 (file storage not yet implemented). Stores a placeholder URL and
   * updates payment_status to PAYMENT_COLLECTED in the same tenant transaction.
   */
  async recordCollection(
    clientId: number,
    courierId: number,
    orderId: number,
    input: RecordCollectionInput,
    evidenceFile?: Express.Multer.File,
  ) {
    // Validate input first (outside the transaction to fail fast)
    const validatedInput = recordCollectionSchema.parse(input);

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
          total: true,
          currency: true,
        },
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      // Verify courier owns this order
      if (order.courier_user_id === null || Number(order.courier_user_id) !== courierId) {
        throw new HttpError(403, 'FORBIDDEN', 'Este pedido no está asignado a ti');
      }

      // Verify order has a COD payment method
      if (!COD_PAYMENT_METHODS.has(order.payment_method)) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          'Este pedido no requiere cobro contra entrega',
        );
      }

      // Verify order is in a state that allows collection
      if (!COD_COLLECTION_ALLOWED_STATUSES.has(order.order_status)) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `No se puede registrar cobro en estado ${order.order_status}`,
        );
      }

      // Sprint 6 stub: evidence URL placeholder until file storage is implemented
      const timestamp = Date.now();
      const evidenceUrl = evidenceFile
        ? `pending-upload/${orderId}/${timestamp}`
        : null;

      void evidenceFile; // consumed above

      // Determine new order status based on payment method
      const newOrderStatus =
        validatedInput.method === 'CASH'
          ? 'PAYMENT_COLLECTED_CASH'
          : 'PAYMENT_COLLECTED_ELECTRONIC';

      // Create payment record for the collection
      const payment = await tx.payments.create({
        data: {
          client_id: BigInt(clientId),
          order_id: BigInt(orderId),
          payment_method: order.payment_method,
          payment_method_submethod: validatedInput.electronic_submethod ?? null,
          amount: validatedInput.amount,
          currency: validatedInput.currency,
          status: 'COLLECTED',
          external_transaction_id: validatedInput.external_txn_id ?? null,
          collected_by_courier_user_id: BigInt(courierId),
          collected_at: new Date(),
          collection_evidence: evidenceUrl
            ? { url: evidenceUrl, notes: validatedInput.notes ?? null }
            : validatedInput.notes
              ? { notes: validatedInput.notes }
              : undefined,
        },
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          collected_at: true,
        },
      });

      // Update order payment status and order status
      await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: {
          payment_status: PaymentStatus.PAYMENT_COLLECTED,
          order_status: newOrderStatus,
          updated_at: new Date(),
        },
      });

      // Audit the collection event (append-only)
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
            order_status_before: order.order_status,
            order_status_after: newOrderStatus,
          },
          result: 'SUCCESS',
        },
      });

      return {
        payment_id: Number(payment.id),
        order_id: orderId,
        payment_status: PaymentStatus.PAYMENT_COLLECTED,
        order_status: newOrderStatus,
        amount: validatedInput.amount,
        currency: validatedInput.currency,
        evidence_url: evidenceUrl,
        collected_at: payment.collected_at?.toISOString() ?? new Date().toISOString(),
      };
    });
  },
};
