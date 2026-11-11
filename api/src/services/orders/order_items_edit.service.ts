/**
 * Editar los productos de un pedido ya creado (agregar o quitar cajas,
 * cambiar cantidades, líneas libres).
 *
 * Lo pidió Avocado: un cliente llama para sumar una caja o cambiar el combo y
 * el pedido ya estaba registrado; la única salida era cancelarlo y crearlo de
 * nuevo, perdiendo repartidor, día de entrega e historial.
 *
 * Reglas:
 *  - Solo antes de que el pedido salga a reparto (`EDITABLE_STATUSES`).
 *  - Solo si todavía no se pagó: con un pago en línea hecho o un cobro
 *    registrado, cambiar el total descuadraría el pago.
 *  - Un producto que ya estaba conserva el precio acordado; uno nuevo toma el
 *    precio vigente del catálogo; las líneas libres traen el suyo.
 *  - No cambia el estado del pedido (no pasa por el state machine): es una
 *    corrección de datos. Queda auditada con el antes y el después.
 */

import { withTenant } from '@orkoruta/db';
import { OrderStatus, type UpdateOrderItemsInput } from '@orkoruta/shared';
import { HttpError } from '../../lib/http_error.js';
import { logger } from '../../lib/logger.js';
import type { AuthenticatedUser } from '../../middleware/auth.js';

export const EDITABLE_STATUSES: ReadonlySet<string> = new Set([
  OrderStatus.MANUAL_REVIEW,
  OrderStatus.VALIDATION_APPROVED,
  OrderStatus.SELLER_CONFIRMED,
  OrderStatus.PREPARING,
  OrderStatus.AWAITING_COURIER_ASSIGNMENT,
  OrderStatus.COURIER_ASSIGNED,
  OrderStatus.READY_TO_SHIP,
  OrderStatus.SHIPMENT_HOLD,
  OrderStatus.READY_FOR_PICKUP,
]);

/** Estados de pago en los que aún no hay dinero de por medio. */
export const EDITABLE_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  'PAYMENT_NOT_STARTED',
  'PENDING_COLLECTION',
]);

function money(value: unknown): number {
  return Number(value);
}

export const orderItemsEditService = {
  async updateItems(
    clientId: number,
    orderId: number,
    actor: AuthenticatedUser,
    input: UpdateOrderItemsInput,
  ) {
    const key = { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } };

    const result = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const order = await tx.orders.findUnique({ where: key, include: { order_items: true } });
      if (!order) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');

      if (!EDITABLE_STATUSES.has(order.order_status)) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          'Los productos solo se pueden cambiar antes de que el pedido salga a reparto',
          { order_status: order.order_status },
        );
      }
      if (!EDITABLE_PAYMENT_STATUSES.has(order.payment_status)) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          'Este pedido ya tiene un pago en curso o registrado: cambiar el total lo descuadraría',
          { payment_status: order.payment_status },
        );
      }

      // Precio acordado de los productos que ya estaban en el pedido.
      const agreedPrice = new Map<string, number>();
      for (const item of order.order_items) {
        if (item.product_id !== null) agreedPrice.set(item.product_id.toString(), money(item.unit_price));
      }

      const productIds = [
        ...new Set(input.items.filter((i) => i.product_id !== undefined).map((i) => i.product_id!)),
      ];
      const products = productIds.length
        ? await tx.products.findMany({
            where: { client_id: BigInt(clientId), id: { in: productIds.map((id) => BigInt(id)) } },
            select: { id: true, name: true, sku: true, unit_price: true, status: true },
          })
        : [];
      const productById = new Map(products.map((p) => [Number(p.id), p]));

      let subtotal = 0;
      const newItems = input.items.map((item) => {
        if (item.product_id !== undefined) {
          const product = productById.get(item.product_id);
          if (!product) {
            throw new HttpError(422, 'VALIDATION_ERROR', 'Uno de los productos no existe');
          }
          const kept = agreedPrice.get(String(item.product_id));
          // Un producto nuevo tiene que estar activo; uno que ya estaba se
          // conserva aunque luego lo hayan retirado del catálogo.
          if (kept === undefined && product.status !== 'ACTIVE') {
            throw new HttpError(422, 'VALIDATION_ERROR', `«${product.name}» no está activo en el catálogo`);
          }
          const unitPrice = kept ?? money(product.unit_price);
          const lineSubtotal = unitPrice * item.quantity;
          subtotal += lineSubtotal;
          return {
            client_id: BigInt(clientId),
            order_id: order.id,
            product_id: product.id,
            product_name: product.name,
            sku: product.sku ?? null,
            quantity: item.quantity,
            unit_price: unitPrice,
            subtotal: lineSubtotal,
          };
        }
        const unitPrice = item.unit_price!;
        const lineSubtotal = unitPrice * item.quantity;
        subtotal += lineSubtotal;
        return {
          client_id: BigInt(clientId),
          order_id: order.id,
          product_id: null,
          product_name: item.description!,
          sku: null,
          quantity: item.quantity,
          unit_price: unitPrice,
          subtotal: lineSubtotal,
          metadata: { custom_line: true },
        };
      });

      // El resto de componentes del total (envío, impuestos, descuento) se respeta.
      const total =
        subtotal + money(order.shipping_fee) + money(order.tax) - money(order.discount);

      const updated = await tx.orders.updateMany({
        where: { id: order.id, client_id: BigInt(clientId), version: order.version },
        data: { subtotal, total, updated_at: new Date(), version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new HttpError(
          409,
          'OPTIMISTIC_LOCK_FAILED',
          'El pedido cambió mientras lo editabas. Recarga e inténtalo de nuevo.',
        );
      }

      await tx.order_items.deleteMany({ where: { order_id: order.id, client_id: BigInt(clientId) } });
      for (const item of newItems) {
        await tx.order_items.create({ data: item });
      }

      const before = order.order_items.map((i) => ({
        product_name: i.product_name,
        quantity: i.quantity,
        unit_price: money(i.unit_price),
      }));
      const after = newItems.map((i) => ({
        product_name: i.product_name,
        quantity: i.quantity,
        unit_price: i.unit_price,
      }));

      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actor.id),
          actor_type: 'USER',
          actor_role: actor.user_type,
          action: 'ORDER_ITEMS_UPDATED',
          entity_type: 'order',
          entity_id: order.id,
          result: 'SUCCESS',
          metadata: {
            reason: input.reason ?? null,
            total_before: money(order.total),
            total_after: total,
            items_before: before,
            items_after: after,
          },
        },
      });

      return { totalBefore: money(order.total), totalAfter: total, itemCount: newItems.length };
    });

    logger.info(
      { clientId, orderId, actorId: actor.id, ...result },
      'Order items updated by client staff',
    );

    return result;
  },
};
