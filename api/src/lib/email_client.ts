import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Envío de correo transaccional.
 *
 * Se usa la API HTTP de Resend en vez de SMTP para no añadir `nodemailer` al
 * proyecto. Todo el trato con el proveedor vive **solo aquí**: cambiarlo por
 * SES, Postmark o SMTP es reescribir este archivo y nada más.
 *
 * Nunca lanza: devuelve `{ ok }` y deja que el worker decida si reintenta. Un
 * fallo de correo no puede tumbar la entrega de un pedido.
 */

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

export interface SendEmailInput {
  to: string;
  subject: string;
  /** Cuerpo en texto plano. Se convierte a HTML simple respetando los saltos. */
  text: string;
  /**
   * Nombre que ve el comprador como remitente: el del negocio, no el de RUTA.
   * La **dirección** siempre es la de RUTA (`EMAIL_FROM`), que es el único
   * dominio verificado. Así ningún Cliente tiene que verificar el suyo.
   */
  fromName: string;
  /** A dónde van las respuestas del comprador: el correo real del negocio. */
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  /** `true` cuando no vale la pena reintentar (credenciales, remitente inválido). */
  permanent?: boolean;
}

/**
 * ¿Se puede enviar? Hacen falta las dos cosas: la clave del proveedor y la
 * dirección remitente de RUTA, que es la que debe estar verificada. Sin
 * cualquiera de las dos el envío se salta con un log en vez de fallar.
 */
export function isEmailConfigured(): boolean {
  return Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM);
}

/** Texto plano a HTML mínimo: se escapa y se respetan los saltos de línea. */
function toHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#0f172a">${escaped.replace(
    /\n/g,
    '<br>',
  )}</div>`;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!isEmailConfigured()) {
    logger.warn(
      { to: input.to },
      'email: EMAIL_API_KEY no configurada, se omite el envío',
    );
    // No es un fallo reintentable: falta configuración, no hay red caída.
    return { ok: false, error: 'EMAIL_NOT_CONFIGURED', permanent: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.EMAIL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Dirección de RUTA (dominio verificado) con el nombre del negocio
        // delante: el comprador ve "Pizzería La Colina" como remitente.
        from: `${input.fromName} <${env.EMAIL_FROM}>`,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: toHtml(input.text),
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
      signal: controller.signal,
    });

    if (res.ok) {
      const body = (await res.json()) as { id?: string };
      return { ok: true, providerMessageId: body.id };
    }

    const detail = await res.text();
    // 4xx = el proveedor rechaza el mensaje (remitente sin verificar, clave
    // inválida, destinatario mal formado). Reintentar no lo va a arreglar.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    logger.error(
      { status: res.status, detail, to: input.to },
      'email: el proveedor rechazó el envío',
    );
    return { ok: false, error: `HTTP ${res.status}: ${detail}`, permanent };
  } catch (err) {
    logger.error({ err, to: input.to }, 'email: fallo de red al enviar');
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
