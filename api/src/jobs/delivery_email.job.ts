import type { PgBoss, Job } from 'pg-boss';
import { logger } from '../lib/logger.js';
import { sendEmail, isEmailConfigured } from '../lib/email_client.js';
import { isGuestBuyer } from '../lib/guest_buyer.js';
import {
  DELIVERY_EMAIL_JOB,
  deliveryEmailService,
  type DeliveryEmailJobData,
} from '../services/notifications/delivery_email.service.js';

/**
 * Envía el aviso de entrega al comprador.
 *
 * Calcado del patrón de `webhook_sender.job.ts`: cola pg-boss con reintentos.
 * Lo que **no** se reintenta se descarta explícitamente, porque reintentar tres
 * veces algo que nunca va a funcionar solo llena los logs:
 *
 * - Sin proveedor configurado → se descarta (falta configuración, no es un
 *   fallo transitorio).
 * - Comprador **invitado** → se descarta. Su correo es sintético y no existe;
 *   enviarlo generaría rebotes que perjudican la reputación del remitente.
 * - Rechazo 4xx del proveedor (remitente sin verificar, clave mala) → se
 *   descarta con el detalle en el log.
 */
export async function registerDeliveryEmailJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(DELIVERY_EMAIL_JOB);

  await boss.work<DeliveryEmailJobData>(
    DELIVERY_EMAIL_JOB,
    async (jobs: Job<DeliveryEmailJobData>[]) => {
      for (const job of jobs) {
        const { clientId, orderId } = job.data;

        if (!isEmailConfigured()) {
          logger.warn({ clientId, orderId }, 'delivery_email: sin proveedor, se descarta');
          continue;
        }

        const message = await deliveryEmailService.buildMessage(clientId, orderId);
        if (!message) {
          // El Cliente lo desactivó o le falta remitente entre que se encoló y
          // se procesó. No es un error.
          logger.info({ clientId, orderId }, 'delivery_email: sin config vigente, se omite');
          continue;
        }

        if (isGuestBuyer(message.externalBuyerId)) {
          logger.info(
            { clientId, orderId },
            'delivery_email: comprador invitado, no se envía (correo sintético)',
          );
          continue;
        }

        const result = await sendEmail({
          to: message.to,
          subject: message.subject,
          text: message.text,
          fromName: message.fromName,
          replyTo: message.replyTo,
        });

        if (result.ok) {
          logger.info(
            { clientId, orderId, providerMessageId: result.providerMessageId },
            'delivery_email: enviado',
          );
          continue;
        }

        if (result.permanent) {
          logger.error(
            { clientId, orderId, error: result.error },
            'delivery_email: rechazo definitivo, no se reintenta',
          );
          continue;
        }

        // Fallo transitorio: se lanza para que pg-boss reintente con backoff.
        throw new Error(`delivery_email falló: ${result.error}`);
      }
    },
  );

  logger.info({ job: DELIVERY_EMAIL_JOB }, 'Job registered');
}
