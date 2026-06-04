/**
 * corporate_orders.service.ts — Flujo 6: Pedidos corporativos (Fase 3, Bloque 5.2)
 *
 * Aplica solo a Cliente Full. Cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE.
 *
 * Actores autorizados: ADMIN_CLIENT, OPERATOR_CLIENT, ADMIN_RUTA.
 *
 * Funciones:
 *   createCorporateOrder           — crea DRAFT con buyer_type=CORPORATE, order_origin=CORPORATE_MANUAL
 *   createCorporateOrderRecurring  — igual que anterior, luego marca como recurrente
 *   repeatLastCorporateOrder       — clona el último pedido CORPORATE del comprador en nuevo DRAFT
 *
 * Nota sobre buyer_id: el campo es NOT NULL en la BD.
 *   - Si se provee buyer_id, se usa como FK normal.
 *   - Si no se provee (contacto ad-hoc), el contacto queda en delivery_instructions
 *     como JSON y se requiere buyer_id para la escritura en BD (lanzar 422 si falta).
 *
 * Aislamiento multi-tenant: todo query filtra por client_id.
 */

import { z } from 'zod';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { RecurrencePeriodicity } from '@orkoruta/shared';
import { HttpError } from '../lib/http_error.js';
import { logger } from '../lib/logger.js';
import { recurrenceService } from './recurrence.service.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

// ── Schemas locales ───────────────────────────────────────────────────────────

const corporateContactSchema = z.object({
  name: z.string().min(1, 'El nombre del contacto es requerido'),
  email: z.string().email().optional(),
  phone: z.string().optional(),
});

export const createCorporateOrderSchema = z.object({
  buyer_id: z.number().int().positive().optional(),
  corporate_contact: corporateContactSchema,
  items: z.array(
    z.object({
      product_id: z.number().int().positive(),
      quantity: z.number().int().positive(),
    }),
  ).min(1, 'Se requiere al menos un ítem'),
  delivery_type: z.enum(['SHIP', 'PICKUP']),
  payment_method: z.enum(['ONLINE_AT_ORDER', 'ELECTRONIC_ON_DELIVERY', 'CASH_ON_DELIVERY']),
  payment_method_submethod: z.enum(['DATAFONO', 'BANK_TRANSFER', 'PAYMENT_LINK', 'QR']).optional(),
  notes: z.string().optional(),
});

export const createCorporateOrderRecurringSchema = createCorporateOrderSchema.extend({
  recurrence_periodicity: z.nativeEnum(RecurrencePeriodicity, {
    required_error: 'recurrence_periodicity es requerido para pedidos recurrentes',
  }),
  custom_interval_days: z.number().int().positive().optional(),
}).refine(
  (data) =>
    data.recurrence_periodicity !== RecurrencePeriodicity.CUSTOM_INTERVAL ||
    data.custom_interval_days !== undefined,
  {
    message: 'custom_interval_days es requerido cuando periodicity es CUSTOM_INTERVAL',
    path: ['custom_interval_days'],
  },
);

export type CreateCorporateOrderInput = z.infer<typeof createCorporateOrderSchema>;
export type CreateCorporateOrderRecurringInput = z.infer<typeof createCorporateOrderRecurringSchema>;

// ── Guard de rol admin/operador ───────────────────────────────────────────────

function assertAdminOrOperator(actor: AuthenticatedUser): void {
  const { user_type } = actor;
  if (
    user_type !== 'ADMIN_CLIENT' &&
    user_type !== 'OPERATOR_CLIENT' &&
    user_type !== 'ADMIN_RUTA'
  ) {
    throw new HttpError(403, 'FORBIDDEN', 'Solo ADMIN_CLIENT u OPERATOR_CLIENT pueden crear pedidos corporativos');
  }
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
      'Los pedidos corporativos no aplican para Clientes API',
    );
  }
}

// ── Serialización ─────────────────────────────────────────────────────────────

function serializeOrder(o: {
  id: bigint;
  client_id: bigint;
  buyer_id: bigint;
  order_status: string;
  order_origin: string;
  buyer_type: string;
  payment_method: string;
  payment_method_submethod: string | null;
  delivery_type: string;
  delivery_carrier_type: string | null;
  delivery_instructions: string | null;
  subtotal: unknown;
  total: unknown;
  currency: string;
  created_at: Date;
  updated_at: Date;
  order_items: {
    id: bigint;
    product_id: bigint | null;
    product_name: string;
    sku: string | null;
    quantity: number;
    unit_price: unknown;
    subtotal: unknown;
  }[];
}) {
  // Intentar parsear el contacto corporativo guardado en delivery_instructions
  let metadata: Record<string, unknown> | null = null;
  if (o.delivery_instructions) {
    try {
      const parsed = JSON.parse(o.delivery_instructions) as unknown;
      if (parsed && typeof parsed === 'object' && 'corporate_contact' in parsed) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // delivery_instructions es texto libre, no JSON
    }
  }

  return {
    id: Number(o.id),
    client_id: Number(o.client_id),
    buyer_id: Number(o.buyer_id),
    order_status: o.order_status,
    order_origin: o.order_origin,
    buyer_type: o.buyer_type,
    payment_method: o.payment_method,
    payment_method_submethod: o.payment_method_submethod,
    delivery_type: o.delivery_type,
    delivery_carrier_type: o.delivery_carrier_type,
    subtotal: Number(o.subtotal),
    total: Number(o.total),
    currency: o.currency,
    metadata,
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
  };
}

const corporateOrderInclude = {
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

// ── Servicio ──────────────────────────────────────────────────────────────────

export const corporateOrdersService = {
  /**
   * Crea un pedido corporativo en estado DRAFT.
   *
   * buyer_id es obligatorio para la FK en BD. El contacto corporativo
   * se almacena serializado en delivery_instructions como JSON.
   * Si buyer_id no se provee, la operación lanza 422.
   */
  async createCorporateOrder(
    clientId: number,
    input: CreateCorporateOrderInput,
    actor: AuthenticatedUser,
  ) {
    assertAdminOrOperator(actor);
    await assertFullClient(clientId);

    if (!input.buyer_id) {
      throw new HttpError(
        422,
        'VALIDATION_ERROR',
        'buyer_id es requerido para crear un pedido corporativo (la BD no permite compradores nulos)',
      );
    }

    const order = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      // Verificar que todos los productos existen y están activos
      const productIds = input.items.map((i) => BigInt(i.product_id));
      const products = await tx.products.findMany({
        where: {
          id: { in: productIds },
          status: 'ACTIVE',
        },
        select: { id: true, unit_price: true, name: true, sku: true },
      });

      if (products.length !== productIds.length) {
        throw new HttpError(422, 'VALIDATION_ERROR', 'Uno o más productos no existen o están inactivos');
      }

      const productMap = new Map(products.map((p) => [Number(p.id), p]));

      // Calcular subtotal
      let subtotal = 0;
      const items = input.items.map((item) => {
        const product = productMap.get(item.product_id)!;
        const unitPrice = Number(product.unit_price);
        const lineSubtotal = unitPrice * item.quantity;
        subtotal += lineSubtotal;
        return {
          product_name: product.name,
          sku: product.sku ?? null,
          quantity: item.quantity,
          unit_price: unitPrice,
          subtotal: lineSubtotal,
        };
      });

      // Serializar contacto corporativo en delivery_instructions
      const deliveryInstructions = JSON.stringify({
        corporate_contact: input.corporate_contact,
        created_by_actor_id: actor.id,
        created_by_actor_type: actor.user_type,
        notes: input.notes ?? null,
      });

      const created = await tx.orders.create({
        data: {
          client_id: BigInt(clientId),
          buyer_id: BigInt(input.buyer_id!),
          order_origin: 'CORPORATE_MANUAL',
          order_status: 'DRAFT',
          payment_status: 'PAYMENT_NOT_STARTED',
          refund_status: 'REFUND_NOT_REQUIRED',
          delivery_type: input.delivery_type,
          payment_method: input.payment_method,
          payment_method_submethod: input.payment_method_submethod ?? null,
          buyer_type: 'CORPORATE',
          subtotal,
          total: subtotal,
          currency: 'COP',
          delivery_instructions: deliveryInstructions,
          order_items: { create: items },
        },
        include: {
          ...corporateOrderInclude,
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
        },
      });

      // Auditar creación
      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actor.id),
          actor_type: 'USER',
          actor_role: actor.user_type,
          action: 'CORPORATE_ORDER_CREATED',
          entity_type: 'order',
          entity_id: created.id,
          result: 'SUCCESS',
          metadata: {
            buyer_id: input.buyer_id,
            corporate_contact_name: input.corporate_contact.name,
            item_count: input.items.length,
            subtotal,
          },
        },
      });

      logger.info(
        {
          clientId,
          orderId: String(created.id),
          actorId: actor.id,
          actorType: actor.user_type,
          buyerId: input.buyer_id,
        },
        'Corporate order created in DRAFT',
      );

      return created;
    });

    return serializeOrder(order);
  },

  /**
   * Crea un pedido corporativo recurrente: primero crea el DRAFT con
   * buyer_type=CORPORATE, luego llama markOrderAsRecurring para crear
   * la plantilla de recurrencia.
   */
  async createCorporateOrderRecurring(
    clientId: number,
    input: CreateCorporateOrderRecurringInput,
    actor: AuthenticatedUser,
  ) {
    assertAdminOrOperator(actor);
    await assertFullClient(clientId);

    if (!input.buyer_id) {
      throw new HttpError(
        422,
        'VALIDATION_ERROR',
        'buyer_id es requerido para crear un pedido corporativo recurrente',
      );
    }

    // Crear el DRAFT corporativo
    const order = await this.createCorporateOrder(clientId, input, actor);

    // Marcar como recurrente
    const template = await recurrenceService.markOrderAsRecurring(
      clientId,
      order.id,
      input.buyer_id,
      {
        recurrence_periodicity: input.recurrence_periodicity,
        custom_interval_days: input.custom_interval_days,
      },
    );

    logger.info(
      {
        clientId,
        orderId: order.id,
        templateId: template.id,
        actorId: actor.id,
        periodicity: input.recurrence_periodicity,
      },
      'Corporate recurring order created',
    );

    return { order, recurrence_template: template };
  },

  /**
   * Repite el último pedido CORPORATE del comprador en ese cliente.
   * Clona ítems en nuevo DRAFT con buyer_type=CORPORATE, order_origin=CORPORATE_MANUAL.
   */
  async repeatLastCorporateOrder(
    clientId: number,
    buyerId: number,
    actor: AuthenticatedUser,
  ) {
    assertAdminOrOperator(actor);
    await assertFullClient(clientId);

    const newOrder = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      // Obtener el último pedido CORPORATE del comprador
      const lastOrder = await tx.orders.findFirst({
        where: {
          client_id: BigInt(clientId),
          buyer_id: BigInt(buyerId),
          buyer_type: 'CORPORATE',
        },
        orderBy: { created_at: 'desc' },
        include: {
          order_items: true,
        },
      });

      if (!lastOrder) {
        throw new HttpError(
          404,
          'RESOURCE_NOT_FOUND',
          'No se encontraron pedidos corporativos anteriores para este comprador',
        );
      }

      if (!lastOrder.order_items || lastOrder.order_items.length === 0) {
        throw new HttpError(422, 'VALIDATION_ERROR', 'El último pedido corporativo no tiene ítems para repetir');
      }

      // Calcular totales
      let subtotal = 0;
      for (const item of lastOrder.order_items) {
        const qty = item.quantity;
        const unitPrice =
          typeof item.unit_price === 'object' && item.unit_price !== null && 'toNumber' in item.unit_price
            ? (item.unit_price as { toNumber(): number }).toNumber()
            : Number(item.unit_price);
        subtotal += qty * unitPrice;
      }

      // Preservar el contacto corporativo original si existe en delivery_instructions
      const repeatNotes = JSON.stringify({
        source_order_id: Number(lastOrder.id),
        repeated_by_actor_id: actor.id,
        repeated_by_actor_type: actor.user_type,
        original_instructions: lastOrder.delivery_instructions,
      });

      const created = await tx.orders.create({
        data: {
          client_id: BigInt(clientId),
          buyer_id: BigInt(buyerId),
          order_origin: 'CORPORATE_MANUAL',
          order_status: 'DRAFT',
          payment_status: 'PAYMENT_NOT_STARTED',
          refund_status: 'REFUND_NOT_REQUIRED',
          delivery_type: lastOrder.delivery_type,
          delivery_carrier_type: lastOrder.delivery_carrier_type ?? null,
          payment_method: lastOrder.payment_method,
          payment_method_submethod: lastOrder.payment_method_submethod ?? null,
          delivery_address_line: lastOrder.delivery_address_line ?? null,
          delivery_address_city: lastOrder.delivery_address_city ?? null,
          delivery_address_state: lastOrder.delivery_address_state ?? null,
          delivery_address_country: lastOrder.delivery_address_country ?? null,
          delivery_address_postal_code: lastOrder.delivery_address_postal_code ?? null,
          delivery_address_latitude: lastOrder.delivery_address_latitude ?? null,
          delivery_address_longitude: lastOrder.delivery_address_longitude ?? null,
          delivery_instructions: repeatNotes,
          pickup_point_id: lastOrder.pickup_point_id ?? null,
          buyer_type: 'CORPORATE',
          subtotal,
          total: subtotal,
          currency: lastOrder.currency,
        },
        include: {
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
        },
      });

      // Clonar ítems
      for (const item of lastOrder.order_items) {
        const unitPrice =
          typeof item.unit_price === 'object' && item.unit_price !== null && 'toNumber' in item.unit_price
            ? (item.unit_price as { toNumber(): number }).toNumber()
            : Number(item.unit_price);
        const itemSubtotal = item.quantity * unitPrice;

        await tx.order_items.create({
          data: {
            client_id: BigInt(clientId),
            order_id: created.id,
            product_id: item.product_id ?? null,
            product_name: item.product_name,
            sku: item.sku ?? null,
            quantity: item.quantity,
            unit_price: unitPrice,
            subtotal: itemSubtotal,
            metadata: item.metadata ?? undefined,
          },
        });
      }

      // Auditar
      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actor.id),
          actor_type: 'USER',
          actor_role: actor.user_type,
          action: 'CORPORATE_ORDER_REPEATED',
          entity_type: 'order',
          entity_id: created.id,
          result: 'SUCCESS',
          metadata: {
            buyer_id: buyerId,
            source_order_id: Number(lastOrder.id),
            item_count: lastOrder.order_items.length,
          },
        },
      });

      logger.info(
        {
          clientId,
          buyerId,
          newOrderId: String(created.id),
          sourceOrderId: String(lastOrder.id),
          actorId: actor.id,
        },
        'Repeat last corporate order: DRAFT created',
      );

      return created;
    });

    return serializeOrder(newOrder);
  },
};
