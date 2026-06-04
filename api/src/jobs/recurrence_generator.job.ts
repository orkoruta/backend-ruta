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
import { RecurrenceStatus, RecurrencePeriodicity } from '@orkoruta/shared';
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

    // Crear el pedido en estado ORDER_SUBMITTED
    const newOrder = await tx.orders.create({
      data: {
        client_id: BigInt(clientId),
        buyer_id: template.buyer_id,
        recurrence_template_id: template.id,
        order_origin: 'SCHEDULED_RECURRING',
        order_status: 'ORDER_SUBMITTED',
        payment_status: 'PAYMENT_PENDING',
        delivery_type: template.delivery_type,
        delivery_carrier_type: template.delivery_carrier_type ?? null,
        payment_method: template.payment_method,
        payment_method_submethod: template.payment_method_submethod ?? null,
        delivery_address_line: (payload.delivery_address_line as string) ?? null,
        delivery_address_city: (payload.delivery_address_city as string) ?? null,
        delivery_address_state: (payload.delivery_address_state as string) ?? null,
        delivery_address_country: (payload.delivery_address_country as string) ?? null,
        delivery_address_postal_code: (payload.delivery_address_postal_code as string) ?? null,
        delivery_address_latitude: (payload.delivery_address_latitude as number) ?? null,
        delivery_address_longitude: (payload.delivery_address_longitude as number) ?? null,
        delivery_instructions: (payload.delivery_instructions as string) ?? null,
        buyer_type: (payload.buyer_type as string) ?? 'INDIVIDUAL',
        subtotal: 0,
        total: 0,
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
