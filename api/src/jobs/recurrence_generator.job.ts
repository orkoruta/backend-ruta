/**
 * recurrence_generator.job.ts — F3.B4.2.BACK-2
 *
 * Job pg-boss que genera automáticamente pedidos recurrentes.
 * Se ejecuta cada hora. Solo aplica a Clientes Full activos.
 *
 * Lógica por plantilla RECURRENCE_ACTIVE vencida:
 *   1. Lee template_payload para construir datos del nuevo pedido.
 *   2. Crea el pedido en estado ORDER_SUBMITTED.
 *   3. Si payment_method = ONLINE_AT_ORDER: loggea que requiere cobro automático.
 *   4. Actualiza last_generated_at = NOW() y calcula nuevo next_generation_at.
 *   5. Si falla una plantilla: loggea el error, dispara webhook RECURRENCE_GENERATION_FAILED
 *      y continúa con el resto.
 *
 * Idempotencia: el query filtra next_generation_at <= NOW() y la actualización
 * usa updateMany con condición en el mismo estado, por lo que una doble ejecución
 * en el mismo ciclo no genera duplicados.
 */

import type { PgBoss } from 'pg-boss';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { RecurrenceStatus, RecurrencePeriodicity, OrderOrigin } from '@orkoruta/shared';
import { logger } from '../lib/logger.js';
import { processWebhookEvent } from '../services/webhooks_outgoing.service.js';

export const RECURRENCE_GENERATOR_JOB = 'recurrence_generator';
const CRON = '0 * * * *'; // cada hora en punto

// ── Periodicidades ────────────────────────────────────────────────────────────

const PERIODICITY_DAYS: Partial<Record<RecurrencePeriodicity, number>> = {
  [RecurrencePeriodicity.DAILY]: 1,
  [RecurrencePeriodicity.WEEKLY]: 7,
  [RecurrencePeriodicity.BIWEEKLY]: 14,
  [RecurrencePeriodicity.MONTHLY]: 30,
};

function calcNextGenerationAt(
  periodicity: string,
  customIntervalDays: number | null,
  from: Date = new Date(),
): Date {
  let days: number;
  if (periodicity === RecurrencePeriodicity.CUSTOM_INTERVAL) {
    days = customIntervalDays ?? 7; // fallback defensivo: 7 días
  } else {
    days = PERIODICITY_DAYS[periodicity as RecurrencePeriodicity] ?? 7;
  }
  const next = new Date(from);
  next.setDate(next.getDate() + days);
  return next;
}

// ── Registro del job ──────────────────────────────────────────────────────────

export async function registerRecurrenceGeneratorJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(RECURRENCE_GENERATOR_JOB);
  await boss.schedule(RECURRENCE_GENERATOR_JOB, CRON);
  await boss.work(RECURRENCE_GENERATOR_JOB, async () => {
    await processRecurrenceGeneration(boss);
  });
  logger.info({ job: RECURRENCE_GENERATOR_JOB }, 'Job registered');
}

// ── Procesamiento principal ───────────────────────────────────────────────────

export async function processRecurrenceGeneration(boss: PgBoss): Promise<void> {
  // Solo Clientes Full activos tienen recurrencia (Regla 4.9)
  const clients = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findMany({
      where: { status: 'ACTIVE', id: { gt: 0n }, client_type: 'FULL' },
      select: { id: true },
    }),
  );

  for (const client of clients) {
    const clientId = Number(client.id);
    await generateRecurringOrdersForClient(clientId, boss);
  }
}

export async function generateRecurringOrdersForClient(
  clientId: number,
  boss: PgBoss,
): Promise<void> {
  const now = new Date();

  // Plantillas ACTIVE vencidas (next_generation_at <= NOW)
  // Idempotencia: el filtro garantiza que solo se procesan una vez por ciclo.
  const templates = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.recurrence_templates.findMany({
      where: {
        client_id: BigInt(clientId),
        recurrence_status: RecurrenceStatus.RECURRENCE_ACTIVE,
        next_generation_at: { lte: now },
      },
      select: {
        id: true,
        client_id: true,
        buyer_id: true,
        recurrence_periodicity: true,
        custom_interval_days: true,
        template_payload: true,
        delivery_type: true,
        delivery_carrier_type: true,
        payment_method: true,
        payment_method_submethod: true,
      },
    }),
  );

  if (templates.length === 0) return;

  logger.info({ clientId, count: templates.length }, 'Recurrence templates ready to generate');

  for (const template of templates) {
    const templateId = template.id;
    try {
      await generateOrderFromTemplate(clientId, template, now);
    } catch (err) {
      logger.error(
        { clientId, templateId: String(templateId), err: String(err) },
        'Recurrence generation failed for template — dispatching webhook',
      );
      // Dispara webhook RECURRENCE_GENERATION_FAILED sin interrumpir el loop
      try {
        await processWebhookEvent(
          'RECURRENCE_GENERATION_FAILED',
          {
            template_id: Number(templateId),
            client_id: clientId,
            buyer_id: Number(template.buyer_id),
            error: String(err),
            failed_at: now.toISOString(),
          },
          clientId,
          boss,
        );
      } catch (webhookErr) {
        logger.warn(
          { clientId, templateId: String(templateId), webhookErr: String(webhookErr) },
          'Could not dispatch RECURRENCE_GENERATION_FAILED webhook',
        );
      }
    }
  }
}

type TemplateRow = {
  id: bigint;
  client_id: bigint;
  buyer_id: bigint;
  recurrence_periodicity: string | null;
  custom_interval_days: number | null;
  template_payload: unknown;
  delivery_type: string;
  delivery_carrier_type: string | null;
  payment_method: string;
  payment_method_submethod: string | null;
};

export async function generateOrderFromTemplate(
  clientId: number,
  template: TemplateRow,
  now: Date,
): Promise<void> {
  const payload = (template.template_payload ?? {}) as Record<string, unknown>;
  const periodicity = template.recurrence_periodicity ?? RecurrencePeriodicity.WEEKLY;
  const nextGenerationAt = calcNextGenerationAt(periodicity, template.custom_interval_days, now);

  await withTenant(clientId, 'ADMIN_RUTA', async (tx) => {
    // Idempotencia: actualizar next_generation_at solo si aún está <= now.
    // Si otro proceso ya actualizó el registro en el mismo ciclo, updateMany
    // devuelve count = 0 y no se genera el pedido.
    const updated = await tx.recurrence_templates.updateMany({
      where: {
        id: template.id,
        client_id: BigInt(clientId),
        recurrence_status: RecurrenceStatus.RECURRENCE_ACTIVE,
        next_generation_at: { lte: now },
      },
      data: {
        last_generated_at: now,
        next_generation_at: nextGenerationAt,
        updated_at: now,
      },
    });

    if (updated.count === 0) {
      // Otro proceso ya generó este ciclo — saltar sin error
      logger.debug(
        { clientId, templateId: String(template.id) },
        'Recurrence template already processed in this cycle — skipping',
      );
      return;
    }

    /*
     * La plantilla solo guarda la dirección (y no las coordenadas) y el id del
     * pedido de origen. Los productos, las coordenadas, el punto de recogida y
     * el tipo de comprador salen de ese pedido.
     *
     * Antes el pedido se creaba con `payment_status: 'PAYMENT_PENDING'` —un
     * valor que no existe y que la BD rechaza— y sin ítems, en $0: no se llegó
     * a generar ni un pedido recurrente en producción, y la plantilla
     * reintentaba (y fallaba) cada hora.
     */
    const sourceOrderId = Number(payload.order_id);
    const source = Number.isFinite(sourceOrderId) && sourceOrderId > 0
      ? await tx.orders.findUnique({
          where: { id_client_id: { id: BigInt(sourceOrderId), client_id: BigInt(clientId) } },
          include: { order_items: true },
        })
      : null;

    if (!source || source.order_items.length === 0) {
      // Sin pedido de origen no hay qué repetir: se pausa en vez de reintentar
      // para siempre. El Cliente la ve pausada y puede rehacerla.
      await tx.recurrence_templates.update({
        where: { id_client_id: { id: template.id, client_id: BigInt(clientId) } },
        data: { recurrence_status: RecurrenceStatus.RECURRENCE_PAUSED, updated_at: now },
      });
      logger.warn(
        { clientId, templateId: String(template.id), sourceOrderId },
        'Recurrence template paused: source order missing or without items',
      );
      return;
    }

    // Precio vigente del catálogo para los productos activos; las líneas libres
    // (sin producto) y los productos retirados conservan el precio original.
    const productIds = source.order_items
      .map((i) => i.product_id)
      .filter((id): id is bigint => id !== null);
    const products = productIds.length
      ? await tx.products.findMany({
          where: { client_id: BigInt(clientId), id: { in: productIds }, status: 'ACTIVE' },
          select: { id: true, unit_price: true, name: true },
        })
      : [];
    const productById = new Map(products.map((p) => [p.id.toString(), p]));

    let subtotal = 0;
    const items = source.order_items.map((item) => {
      const current = item.product_id ? productById.get(item.product_id.toString()) : undefined;
      const unitPrice = Number(current ? current.unit_price : item.unit_price);
      const lineSubtotal = unitPrice * item.quantity;
      subtotal += lineSubtotal;
      return {
        product_id: item.product_id ?? null,
        product_name: current?.name ?? item.product_name,
        sku: item.sku ?? null,
        quantity: item.quantity,
        unit_price: unitPrice,
        subtotal: lineSubtotal,
        metadata: item.metadata ?? undefined,
      };
    });

    // La dirección de la plantilla manda (el comprador puede haberla cambiado
    // con updateTemplate); si no la tiene, la del pedido de origen.
    const pick = <T>(key: string, fallback: T): T =>
      (payload[key] as T | null | undefined) ?? fallback;
    const sameAddress =
      pick<string | null>('delivery_address_line', null) === null ||
      pick<string | null>('delivery_address_line', null) === source.delivery_address_line;

    const paymentStatus =
      template.payment_method === 'ONLINE_AT_ORDER' ? 'PENDING_ONLINE_PAYMENT' : 'PENDING_COLLECTION';

    // Un pedido recurrente ya está acordado: nace pre-aprobado en SELLER_CONFIRMED
    // (el Cliente lo ve listo para "Marcar preparando", sin validar ni aceptar).
    // El pago online, si aplica, lo ejecuta el proveedor del Cliente aparte.
    const newOrder = await tx.orders.create({
      data: {
        client_id: BigInt(clientId),
        buyer_id: template.buyer_id,
        recurrence_template_id: template.id,
        order_origin: OrderOrigin.RECURRENCE,
        order_status: 'SELLER_CONFIRMED',
        payment_status: paymentStatus,
        refund_status: 'REFUND_NOT_REQUIRED',
        delivery_type: template.delivery_type,
        delivery_carrier_type: template.delivery_carrier_type ?? null,
        payment_method: template.payment_method,
        payment_method_submethod: template.payment_method_submethod ?? null,
        delivery_address_line: pick('delivery_address_line', source.delivery_address_line),
        delivery_address_city: pick('delivery_address_city', source.delivery_address_city),
        delivery_address_state: pick('delivery_address_state', source.delivery_address_state),
        delivery_address_country: pick('delivery_address_country', source.delivery_address_country),
        delivery_address_postal_code: pick('delivery_address_postal_code', source.delivery_address_postal_code),
        // Las coordenadas solo valen si la dirección no cambió: sin ellas el
        // pedido no sale en el mapa, pero con las de otra dirección saldría mal.
        delivery_address_latitude: sameAddress ? source.delivery_address_latitude : null,
        delivery_address_longitude: sameAddress ? source.delivery_address_longitude : null,
        delivery_instructions: pick('delivery_instructions', source.delivery_instructions),
        pickup_point_id: source.pickup_point_id ?? null,
        buyer_type: source.buyer_type,
        subtotal,
        total: subtotal,
        currency: source.currency,
        submitted_at: now,
        order_items: { create: items },
      },
    });

    // Cobro automático: solo loggea; la ejecución real es del proveedor del Cliente
    if (template.payment_method === 'ONLINE_AT_ORDER') {
      logger.info(
        {
          clientId,
          templateId: String(template.id),
          orderId: String(newOrder.id),
          paymentMethod: template.payment_method,
        },
        'Recurring order created with ONLINE_AT_ORDER — automatic charge required by client payment provider',
      );
    }

    logger.info(
      {
        clientId,
        templateId: String(template.id),
        orderId: String(newOrder.id),
        nextGenerationAt: nextGenerationAt.toISOString(),
        periodicity,
      },
      'Recurring order generated successfully',
    );
  });
}
