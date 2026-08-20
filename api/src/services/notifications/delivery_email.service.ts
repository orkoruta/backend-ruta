import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { logger } from '../../lib/logger.js';

/**
 * Aviso por correo al comprador cuando le entregan el pedido.
 *
 * La configuración es **por Cliente** y vive en `client_parameters`, que es el
 * mecanismo del proyecto para config por tenant y no necesita migración. Cada
 * Cliente decide el nombre con el que firma, a qué correo le responden, y el
 * asunto y el texto del mensaje.
 *
 * **La dirección remitente es siempre la de RUTA** (`EMAIL_FROM`), porque es el
 * único dominio verificado con el proveedor. El comprador ve el nombre del
 * negocio como remitente y, al responder, le escribe al negocio gracias al
 * Reply-To. La alternativa —que cada Cliente enviara desde su propio dominio—
 * obligaría a verificar el dominio de cada uno, un trámite por cliente.
 *
 * **A los invitados no se les escribe.** Su correo es sintético
 * (`guest-<uuid>@guest.ruta`) y no existe: enviarlo sería generar rebotes y
 * ensuciar la reputación del dominio remitente. Es una decisión explícita, no
 * un olvido.
 */

export const DELIVERY_EMAIL_JOB = 'send_delivery_email';

// ── Parámetros por Cliente ───────────────────────────────────────────────────

const PARAM = {
  enabled: 'notifications.delivery_email_enabled',
  replyTo: 'notifications.delivery_email_reply_to',
  fromName: 'notifications.delivery_email_from_name',
  subject: 'notifications.delivery_email_subject',
  body: 'notifications.delivery_email_body',
} as const;

export const DEFAULT_SUBJECT = 'Tu pedido #{{pedido}} fue entregado';

export const DEFAULT_BODY = `Hola {{comprador}},

Tu pedido #{{pedido}} fue entregado. El total fue {{total}}.

Gracias por comprar con {{negocio}}.`;

/**
 * Marcas que el Cliente puede usar en el asunto y el cuerpo. Se documentan en
 * la pantalla de configuración: un editor de plantillas sin lista de variables
 * obliga a adivinar.
 */
export const PLACEHOLDERS = ['comprador', 'pedido', 'total', 'negocio'] as const;

export const deliveryEmailConfigSchema = z.object({
  enabled: z.boolean(),
  reply_to: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Correo inválido')
    .optional()
    .default(''),
  from_name: z.string().trim().max(100).optional().default(''),
  subject: z.string().trim().min(1, 'El asunto no puede quedar vacío').max(200),
  body: z.string().trim().min(1, 'El mensaje no puede quedar vacío').max(5000),
});

export type DeliveryEmailConfigInput = z.infer<typeof deliveryEmailConfigSchema>;

export interface DeliveryEmailJobData {
  clientId: number;
  orderId: number;
}

/** Sustituye `{{marca}}` por su valor. Lo que no reconoce se deja tal cual. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    key in values ? values[key]! : match,
  );
}

async function readParams(clientId: number): Promise<Record<string, string>> {
  const rows = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
    tx.client_parameters.findMany({
      where: { client_id: BigInt(clientId), parameter_key: { in: Object.values(PARAM) } },
      select: { parameter_key: true, parameter_value: true },
    }),
  );
  return Object.fromEntries(rows.map((r) => [r.parameter_key, r.parameter_value]));
}

export const deliveryEmailService = {
  /** Config actual del Cliente, con los textos por defecto si no la ha tocado. */
  async getConfig(clientId: number) {
    const p = await readParams(clientId);
    return {
      enabled: p[PARAM.enabled] === 'true',
      reply_to: p[PARAM.replyTo] ?? '',
      from_name: p[PARAM.fromName] ?? '',
      subject: p[PARAM.subject] ?? DEFAULT_SUBJECT,
      body: p[PARAM.body] ?? DEFAULT_BODY,
      placeholders: [...PLACEHOLDERS],
    };
  },

  async saveConfig(clientId: number, input: DeliveryEmailConfigInput) {
    // Se exige correo de respuesta para activarlo: un aviso de entrega al que
    // el comprador no puede contestar deja su duda sin destinatario.
    const enabled = input.enabled && input.reply_to.length > 0;

    const entries: Array<[string, string, string]> = [
      [PARAM.enabled, enabled ? 'true' : 'false', 'BOOLEAN'],
      [PARAM.replyTo, input.reply_to, 'STRING'],
      [PARAM.fromName, input.from_name, 'STRING'],
      [PARAM.subject, input.subject, 'STRING'],
      [PARAM.body, input.body, 'STRING'],
    ];

    await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const now = new Date();
      for (const [key, value, valueType] of entries) {
        const existing = await tx.client_parameters.findFirst({
          where: { client_id: BigInt(clientId), parameter_key: key },
          select: { id: true },
        });
        if (existing) {
          await tx.client_parameters.update({
            where: { id_client_id: { id: existing.id, client_id: BigInt(clientId) } },
            data: { parameter_value: value, updated_at: now },
          });
        } else {
          await tx.client_parameters.create({
            data: {
              client_id: BigInt(clientId),
              parameter_key: key,
              parameter_value: value,
              value_type: valueType,
              description: 'Aviso por correo al comprador cuando se entrega el pedido',
              created_at: now,
              updated_at: now,
            },
          });
        }
      }
    });

    return { ...(await this.getConfig(clientId)), enabled };
  },

  /**
   * Encola el aviso. Se llama tras confirmar la entrega y **nunca** con `await`
   * en la ruta crítica: si el correo falla, el pedido sigue entregado igual.
   */
  async queueDeliveryEmail(clientId: number, orderId: number, boss: PgBoss): Promise<void> {
    const p = await readParams(clientId);
    if (p[PARAM.enabled] !== 'true') return;

    await boss.send(
      DELIVERY_EMAIL_JOB,
      { clientId, orderId } satisfies DeliveryEmailJobData,
      { retryLimit: 3, retryBackoff: true },
    );
    logger.info({ clientId, orderId }, 'delivery_email: aviso encolado');
  },

  /** Config + datos del pedido que necesita el worker para componer el correo. */
  async buildMessage(clientId: number, orderId: number) {
    const [params, order] = await Promise.all([
      readParams(clientId),
      withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
        tx.orders.findUnique({
          where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
          select: {
            total: true,
            currency: true,
            users_orders_buyer_id_client_idTousers: {
              select: { full_name: true, email: true, external_buyer_id: true },
            },
            clients: { select: { name: true } },
          },
        }),
      ),
    ]);

    if (!order) return null;
    if (params[PARAM.enabled] !== 'true') return null;

    const replyTo = params[PARAM.replyTo];
    if (!replyTo) return null;

    const buyer = order.users_orders_buyer_id_client_idTousers;
    const values = {
      comprador: buyer.full_name ?? 'cliente',
      pedido: String(orderId),
      total: new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: order.currency || 'COP',
        maximumFractionDigits: 0,
      }).format(Number(order.total)),
      negocio: order.clients?.name ?? '',
    };

    return {
      to: buyer.email,
      externalBuyerId: buyer.external_buyer_id,
      subject: renderTemplate(params[PARAM.subject] ?? DEFAULT_SUBJECT, values),
      text: renderTemplate(params[PARAM.body] ?? DEFAULT_BODY, values),
      // La dirección remitente la pone `email_client` (la de RUTA, que es el
      // dominio verificado). Aquí solo van el nombre visible y a dónde deben
      // ir las respuestas del comprador.
      fromName: params[PARAM.fromName] || (order.clients?.name ?? 'RUTA'),
      replyTo,
    };
  },
};
