/**
 * recurrence.service.ts — Flujo 5: Recurrencia de pedidos (Fase 3, Bloque 4.2)
 *
 * Aplica solo a Cliente Full. Cliente API → 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE.
 *
 * Máquina de estados de recurrence_templates.recurrence_status:
 *   RECURRENCE_ACTIVE → RECURRENCE_PAUSED → RECURRENCE_ACTIVE
 *   RECURRENCE_ACTIVE → RECURRENCE_CANCELLED
 *   RECURRENCE_PAUSED → RECURRENCE_CANCELLED
 *
 * Aislamiento multi-tenant: todo query filtra por client_id.
 */

import { z } from 'zod';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import {
  RecurrenceStatus,
  RecurrencePeriodicity,
  markAsRecurringSchema,
  updateTemplateSchema,
  recurrenceListQuerySchema,
} from '@orkoruta/shared';
import { HttpError } from '../lib/http_error.js';
import { logger } from '../lib/logger.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

// ── Re-exports de schemas para uso en rutas ───────────────────────────────────

export {
  markAsRecurringSchema,
  updateTemplateSchema,
  recurrenceListQuerySchema,
};

export type MarkAsRecurringInput = z.infer<typeof markAsRecurringSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type RecurrenceListQuery = z.infer<typeof recurrenceListQuerySchema>;

// ── Helpers de periodicidad ───────────────────────────────────────────────────

const PERIODICITY_DAYS: Partial<Record<RecurrencePeriodicity, number>> = {
  [RecurrencePeriodicity.DAILY]: 1,
  [RecurrencePeriodicity.WEEKLY]: 7,
  [RecurrencePeriodicity.BIWEEKLY]: 14,
  [RecurrencePeriodicity.MONTHLY]: 30,
};

function calcNextGenerationAt(
  periodicity: RecurrencePeriodicity,
  customIntervalDays?: number,
  from: Date = new Date(),
): Date {
  let days: number;
  if (periodicity === RecurrencePeriodicity.CUSTOM_INTERVAL) {
    if (!customIntervalDays || customIntervalDays <= 0) {
      throw new HttpError(
        422,
        'VALIDATION_ERROR',
        'custom_interval_days es requerido y debe ser positivo para CUSTOM_INTERVAL',
      );
    }
    days = customIntervalDays;
  } else {
    days = PERIODICITY_DAYS[periodicity]!;
  }
  const next = new Date(from);
  next.setDate(next.getDate() + days);
  return next;
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
      'La recurrencia no aplica para Clientes API',
    );
  }
}

// ── Serialización ─────────────────────────────────────────────────────────────

function serializeTemplate(t: {
  id: bigint;
  client_id: bigint;
  buyer_id: bigint;
  recurrence_mode: string;
  recurrence_status: string;
  recurrence_periodicity: string | null;
  custom_interval_days: number | null;
  template_payload: unknown;
  delivery_type: string;
  delivery_carrier_type: string | null;
  payment_method: string;
  payment_method_submethod: string | null;
  next_generation_at: Date | null;
  last_generated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: Number(t.id),
    client_id: Number(t.client_id),
    buyer_id: Number(t.buyer_id),
    recurrence_mode: t.recurrence_mode,
    recurrence_status: t.recurrence_status,
    recurrence_periodicity: t.recurrence_periodicity,
    custom_interval_days: t.custom_interval_days,
    template_payload: t.template_payload,
    delivery_type: t.delivery_type,
    delivery_carrier_type: t.delivery_carrier_type,
    payment_method: t.payment_method,
    payment_method_submethod: t.payment_method_submethod,
    next_generation_at: t.next_generation_at?.toISOString() ?? null,
    last_generated_at: t.last_generated_at?.toISOString() ?? null,
    created_at: t.created_at.toISOString(),
    updated_at: t.updated_at.toISOString(),
  };
}

// ── Servicio ──────────────────────────────────────────────────────────────────

export const recurrenceService = {
  /**
   * Marca un pedido como recurrente: crea la plantilla y actualiza el pedido.
   * El pedido debe pertenecer al comprador indicado.
   */
  async markOrderAsRecurring(
    clientId: number,
    orderId: number,
    buyerId: number,
    input: MarkAsRecurringInput,
  ) {
    await assertFullClient(clientId);

    const template = await withTenant(clientId, 'BUYER', async (tx) => {
      // Verificar que el pedido pertenece al cliente y al comprador
      const order = await tx.orders.findFirst({
        where: {
          id: BigInt(orderId),
          client_id: BigInt(clientId),
          buyer_id: BigInt(buyerId),
        },
        select: {
          id: true,
          client_id: true,
          buyer_id: true,
          delivery_type: true,
          delivery_carrier_type: true,
          payment_method: true,
          payment_method_submethod: true,
          delivery_address_line: true,
          delivery_address_city: true,
          delivery_address_state: true,
          delivery_address_country: true,
          delivery_address_postal_code: true,
          delivery_address_latitude: true,
          delivery_address_longitude: true,
          delivery_instructions: true,
          recurrence_template_id: true,
        },
      });

      if (!order) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
      }

      if (order.recurrence_template_id) {
        throw new HttpError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'El pedido ya está asociado a una plantilla de recurrencia',
        );
      }

      const nextGenerationAt = calcNextGenerationAt(
        input.recurrence_periodicity as RecurrencePeriodicity,
        input.custom_interval_days,
      );

      const created = await tx.recurrence_templates.create({
        data: {
          client_id: BigInt(clientId),
          buyer_id: BigInt(buyerId),
          recurrence_mode: 'SCHEDULED_RECURRING',
          recurrence_periodicity: input.recurrence_periodicity,
          custom_interval_days: input.custom_interval_days ?? null,
          recurrence_status: RecurrenceStatus.RECURRENCE_ACTIVE,
          delivery_type: order.delivery_type,
          delivery_carrier_type: order.delivery_carrier_type ?? null,
          payment_method: order.payment_method,
          payment_method_submethod: order.payment_method_submethod ?? null,
          next_generation_at: nextGenerationAt,
          template_payload: {
            order_id: orderId,
            delivery_address_line: order.delivery_address_line,
            delivery_address_city: order.delivery_address_city,
            delivery_address_state: order.delivery_address_state,
            delivery_address_country: order.delivery_address_country,
            delivery_address_postal_code: order.delivery_address_postal_code,
            delivery_instructions: order.delivery_instructions,
          },
        },
      });

      await tx.orders.update({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        data: { recurrence_template_id: created.id, updated_at: new Date() },
      });

      logger.info(
        { clientId, orderId, buyerId, templateId: String(created.id), periodicity: input.recurrence_periodicity },
        'Recurrence template created',
      );

      return created;
    });

    return serializeTemplate(template);
  },

  /**
   * Repite el último pedido del comprador: clona sus ítems en un nuevo pedido DRAFT.
   */
  async repeatLastOrder(clientId: number, buyerId: number) {
    await assertFullClient(clientId);

    const newOrder = await withTenant(clientId, 'BUYER', async (tx) => {
      // Obtener el último pedido del comprador (cualquier estado finalizado)
      const lastOrder = await tx.orders.findFirst({
        where: {
          client_id: BigInt(clientId),
          buyer_id: BigInt(buyerId),
        },
        orderBy: { created_at: 'desc' },
        include: {
          order_items: true,
        },
      });

      if (!lastOrder) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'No se encontraron pedidos anteriores para repetir');
      }

      if (!lastOrder.order_items || lastOrder.order_items.length === 0) {
        throw new HttpError(422, 'VALIDATION_ERROR', 'El último pedido no tiene ítems para repetir');
      }

      // Calcular totales
      let subtotal = 0;
      for (const item of lastOrder.order_items) {
        const qty = item.quantity;
        const unitPrice = typeof item.unit_price === 'object' && 'toNumber' in item.unit_price
          ? (item.unit_price as { toNumber(): number }).toNumber()
          : Number(item.unit_price);
        subtotal += qty * unitPrice;
      }

      const created = await tx.orders.create({
        data: {
          client_id: BigInt(clientId),
          buyer_id: BigInt(buyerId),
          order_origin: 'REPEAT_LAST',
          order_status: 'DRAFT',
          payment_status: 'PAYMENT_PENDING',
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
          delivery_instructions: lastOrder.delivery_instructions ?? null,
          pickup_point_id: lastOrder.pickup_point_id ?? null,
          buyer_type: lastOrder.buyer_type,
          subtotal,
          total: subtotal,
        },
      });

      // Clonar ítems
      for (const item of lastOrder.order_items) {
        const unitPrice = typeof item.unit_price === 'object' && 'toNumber' in item.unit_price
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

      logger.info(
        { clientId, buyerId, newOrderId: String(created.id), sourceOrderId: String(lastOrder.id) },
        'Repeat last order: DRAFT created',
      );

      return created;
    });

    return {
      id: Number(newOrder.id),
      client_id: Number(newOrder.client_id),
      buyer_id: Number(newOrder.buyer_id),
      order_status: newOrder.order_status,
      order_origin: newOrder.order_origin,
      payment_method: newOrder.payment_method,
      delivery_type: newOrder.delivery_type,
      subtotal: Number(newOrder.subtotal),
      total: Number(newOrder.total),
      created_at: newOrder.created_at.toISOString(),
    };
  },

  /**
   * Pausa una plantilla activa (RECURRENCE_ACTIVE → RECURRENCE_PAUSED).
   * Solo el comprador dueño puede pausarla.
   */
  async pauseRecurrence(clientId: number, templateId: number, buyerId: number) {
    await assertFullClient(clientId);

    const template = await withTenant(clientId, 'BUYER', async (tx) => {
      const existing = await tx.recurrence_templates.findFirst({
        where: {
          id: BigInt(templateId),
          client_id: BigInt(clientId),
          buyer_id: BigInt(buyerId),
        },
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Plantilla de recurrencia no encontrada');
      }

      if (existing.recurrence_status !== RecurrenceStatus.RECURRENCE_ACTIVE) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La plantilla está en estado ${existing.recurrence_status}; se esperaba RECURRENCE_ACTIVE`,
        );
      }

      const updated = await tx.recurrence_templates.update({
        where: { id_client_id: { id: BigInt(templateId), client_id: BigInt(clientId) } },
        data: { recurrence_status: RecurrenceStatus.RECURRENCE_PAUSED, updated_at: new Date() },
      });

      logger.info({ clientId, templateId, buyerId }, 'Recurrence paused by buyer');
      return updated;
    });

    return serializeTemplate(template);
  },

  /**
   * Reanuda una plantilla pausada (RECURRENCE_PAUSED → RECURRENCE_ACTIVE).
   * Recalcula next_generation_at desde NOW().
   */
  async resumeRecurrence(clientId: number, templateId: number, buyerId: number) {
    await assertFullClient(clientId);

    const template = await withTenant(clientId, 'BUYER', async (tx) => {
      const existing = await tx.recurrence_templates.findFirst({
        where: {
          id: BigInt(templateId),
          client_id: BigInt(clientId),
          buyer_id: BigInt(buyerId),
        },
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Plantilla de recurrencia no encontrada');
      }

      if (existing.recurrence_status !== RecurrenceStatus.RECURRENCE_PAUSED) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La plantilla está en estado ${existing.recurrence_status}; se esperaba RECURRENCE_PAUSED`,
        );
      }

      const nextGenerationAt = calcNextGenerationAt(
        (existing.recurrence_periodicity ?? RecurrencePeriodicity.WEEKLY) as RecurrencePeriodicity,
        existing.custom_interval_days ?? undefined,
      );

      const updated = await tx.recurrence_templates.update({
        where: { id_client_id: { id: BigInt(templateId), client_id: BigInt(clientId) } },
        data: {
          recurrence_status: RecurrenceStatus.RECURRENCE_ACTIVE,
          next_generation_at: nextGenerationAt,
          updated_at: new Date(),
        },
      });

      logger.info({ clientId, templateId, buyerId, nextGenerationAt }, 'Recurrence resumed by buyer');
      return updated;
    });

    return serializeTemplate(template);
  },

  /**
   * Cancela una plantilla (cualquier estado → RECURRENCE_CANCELLED).
   * Solo el comprador dueño puede cancelarla.
   */
  async cancelRecurrence(clientId: number, templateId: number, buyerId: number) {
    await assertFullClient(clientId);

    const template = await withTenant(clientId, 'BUYER', async (tx) => {
      const existing = await tx.recurrence_templates.findFirst({
        where: {
          id: BigInt(templateId),
          client_id: BigInt(clientId),
          buyer_id: BigInt(buyerId),
        },
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Plantilla de recurrencia no encontrada');
      }

      if (existing.recurrence_status === RecurrenceStatus.RECURRENCE_CANCELLED) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'La plantilla ya está cancelada');
      }

      const updated = await tx.recurrence_templates.update({
        where: { id_client_id: { id: BigInt(templateId), client_id: BigInt(clientId) } },
        data: { recurrence_status: RecurrenceStatus.RECURRENCE_CANCELLED, updated_at: new Date() },
      });

      logger.info({ clientId, templateId, buyerId }, 'Recurrence cancelled by buyer');
      return updated;
    });

    return serializeTemplate(template);
  },

  /**
   * Actualiza la periodicidad y/o template_payload de la plantilla.
   */
  async updateTemplate(
    clientId: number,
    templateId: number,
    buyerId: number,
    input: UpdateTemplateInput,
  ) {
    await assertFullClient(clientId);

    const template = await withTenant(clientId, 'BUYER', async (tx) => {
      const existing = await tx.recurrence_templates.findFirst({
        where: {
          id: BigInt(templateId),
          client_id: BigInt(clientId),
          buyer_id: BigInt(buyerId),
        },
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Plantilla de recurrencia no encontrada');
      }

      if (existing.recurrence_status === RecurrenceStatus.RECURRENCE_CANCELLED) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          'No se puede actualizar una plantilla cancelada',
        );
      }

      const now = new Date();

      // Calcular nuevo next_generation_at si cambia la periodicidad
      let nextGenerationAt = existing.next_generation_at ?? undefined;
      if (input.recurrence_periodicity) {
        nextGenerationAt = calcNextGenerationAt(
          input.recurrence_periodicity as RecurrencePeriodicity,
          input.custom_interval_days ?? existing.custom_interval_days ?? undefined,
        );
      }

      // Construir nuevo template_payload con campos de dirección si los provee
      const currentPayload = (existing.template_payload ?? {}) as Record<string, unknown>;
      const updatedPayload = { ...currentPayload };
      if (input.delivery_address) {
        updatedPayload.delivery_address_line = input.delivery_address.line;
        updatedPayload.delivery_address_city = input.delivery_address.city;
        updatedPayload.delivery_address_state = input.delivery_address.state;
        updatedPayload.delivery_address_country = input.delivery_address.country;
        updatedPayload.delivery_address_postal_code = input.delivery_address.postal_code ?? null;
        updatedPayload.delivery_address_latitude = input.delivery_address.latitude ?? null;
        updatedPayload.delivery_address_longitude = input.delivery_address.longitude ?? null;
        updatedPayload.delivery_instructions = input.delivery_address.instructions ?? null;
      }

      const updated = await tx.recurrence_templates.update({
        where: { id_client_id: { id: BigInt(templateId), client_id: BigInt(clientId) } },
        data: {
          ...(input.recurrence_periodicity ? { recurrence_periodicity: input.recurrence_periodicity } : {}),
          ...(input.custom_interval_days !== undefined ? { custom_interval_days: input.custom_interval_days } : {}),
          ...(input.payment_method ? { payment_method: input.payment_method } : {}),
          next_generation_at: nextGenerationAt,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          template_payload: updatedPayload as any,
          updated_at: now,
        },
      });

      logger.info({ clientId, templateId, buyerId }, 'Recurrence template updated by buyer');
      return updated;
    });

    return serializeTemplate(template);
  },

  /**
   * Admin pausa cualquier plantilla del cliente sin validar buyerId.
   */
  async pauseRecurrenceAsAdmin(
    clientId: number,
    templateId: number,
    actor: AuthenticatedUser,
  ) {
    await assertFullClient(clientId);

    const template = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.recurrence_templates.findFirst({
        where: { id: BigInt(templateId), client_id: BigInt(clientId) },
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Plantilla de recurrencia no encontrada');
      }

      if (existing.recurrence_status !== RecurrenceStatus.RECURRENCE_ACTIVE) {
        throw new HttpError(
          422,
          'INVALID_STATE_TRANSITION',
          `La plantilla está en estado ${existing.recurrence_status}; se esperaba RECURRENCE_ACTIVE`,
        );
      }

      const updated = await tx.recurrence_templates.update({
        where: { id_client_id: { id: BigInt(templateId), client_id: BigInt(clientId) } },
        data: { recurrence_status: RecurrenceStatus.RECURRENCE_PAUSED, updated_at: new Date() },
      });

      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actor.id),
          actor_type: 'USER',
          actor_role: actor.user_type,
          action: 'RECURRENCE_PAUSED_BY_ADMIN',
          entity_type: 'recurrence_template',
          entity_id: BigInt(templateId),
          result: 'SUCCESS',
          metadata: { buyer_id: Number(existing.buyer_id) },
        },
      });

      logger.info({ clientId, templateId, actorId: actor.id }, 'Recurrence paused by admin');
      return updated;
    });

    return serializeTemplate(template);
  },

  /**
   * Admin cancela cualquier plantilla del cliente sin validar buyerId.
   */
  async cancelRecurrenceAsAdmin(
    clientId: number,
    templateId: number,
    actor: AuthenticatedUser,
  ) {
    await assertFullClient(clientId);

    const template = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.recurrence_templates.findFirst({
        where: { id: BigInt(templateId), client_id: BigInt(clientId) },
      });

      if (!existing) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Plantilla de recurrencia no encontrada');
      }

      if (existing.recurrence_status === RecurrenceStatus.RECURRENCE_CANCELLED) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'La plantilla ya está cancelada');
      }

      const updated = await tx.recurrence_templates.update({
        where: { id_client_id: { id: BigInt(templateId), client_id: BigInt(clientId) } },
        data: { recurrence_status: RecurrenceStatus.RECURRENCE_CANCELLED, updated_at: new Date() },
      });

      await tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actor.id),
          actor_type: 'USER',
          actor_role: actor.user_type,
          action: 'RECURRENCE_CANCELLED_BY_ADMIN',
          entity_type: 'recurrence_template',
          entity_id: BigInt(templateId),
          result: 'SUCCESS',
          metadata: { buyer_id: Number(existing.buyer_id) },
        },
      });

      logger.info({ clientId, templateId, actorId: actor.id }, 'Recurrence cancelled by admin');
      return updated;
    });

    return serializeTemplate(template);
  },

  /**
   * Retorna una plantilla por ID o lanza 404.
   */
  async getTemplate(clientId: number, templateId: number) {
    const template = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.recurrence_templates.findFirst({
        where: { id: BigInt(templateId), client_id: BigInt(clientId) },
      }),
    );
    if (!template) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Plantilla de recurrencia no encontrada');
    }
    return serializeTemplate(template);
  },

  /**
   * Lista plantillas del cliente con filtros opcionales por status y buyer_id.
   */
  async listTemplates(clientId: number, query: RecurrenceListQuery & { buyer_id?: number }) {
    const skip = (query.page - 1) * query.page_size;
    const where = {
      client_id: BigInt(clientId),
      ...(query.status ? { recurrence_status: query.status } : {}),
      ...(query.buyer_id ? { buyer_id: BigInt(query.buyer_id) } : {}),
    };

    const [items, total] = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      Promise.all([
        tx.recurrence_templates.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip,
          take: query.page_size,
        }),
        tx.recurrence_templates.count({ where }),
      ]),
    );

    return {
      data: items.map(serializeTemplate),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },

  /**
   * Lista plantillas de un comprador específico (para el panel del comprador).
   * Filtra por buyer_id para garantizar aislamiento.
   */
  async listBuyerTemplates(clientId: number, buyerId: number, query: RecurrenceListQuery) {
    const skip = (query.page - 1) * query.page_size;
    const where = {
      client_id: BigInt(clientId),
      buyer_id: BigInt(buyerId),
      ...(query.status ? { recurrence_status: query.status } : {}),
    };

    const [items, total] = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      Promise.all([
        tx.recurrence_templates.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip,
          take: query.page_size,
        }),
        tx.recurrence_templates.count({ where }),
      ]),
    );

    return {
      data: items.map(serializeTemplate),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },
};
