import { z } from 'zod';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';

/**
 * Configuración de la pasarela Wompi por Cliente.
 *
 * Vive en `client_payment_providers` (la misma tabla que `payments.service` lee
 * para cobrar), NO en `client_parameters`. Un Cliente tiene, como mucho, un
 * proveedor Wompi (`provider_name = 'wompi'`). Las claves secretas (private key
 * y events secret) se guardan pero **nunca** se devuelven: al leer solo se
 * informa si están o no cargadas.
 */

const WOMPI_PROVIDER_NAME = 'wompi';
const WOMPI_PROVIDER_TYPE = 'PAYMENT_GATEWAY';
const WOMPI_METHODS = ['ONLINE_AT_ORDER'];

export const wompiConfigSchema = z.object({
  enabled: z.boolean(),
  // La public key no es secreta (viaja al navegador en el checkout de Wompi).
  public_key: z.string().trim().max(200).optional().default(''),
  // Secretas: opcionales al actualizar. Vacío = "no cambiar" (se conserva la
  // que ya estaba), así se puede editar la public key sin re-escribir secretos.
  private_key: z.string().trim().max(200).optional(),
  events_secret: z.string().trim().max(200).optional(),
});

export type WompiConfigInput = z.infer<typeof wompiConfigSchema>;

type StoredConfig = {
  public_key?: string;
  private_key?: string;
};

/** Config lista para escribir en el JSONB: sin claves `undefined`. */
function toJsonConfig(config: StoredConfig): Record<string, string> {
  const out: Record<string, string> = {};
  if (config.public_key) out.public_key = config.public_key;
  if (config.private_key) out.private_key = config.private_key;
  return out;
}

export const paymentConfigService = {
  /** Estado de la config Wompi del Cliente, con los secretos enmascarados. */
  async getWompiConfig(clientId: number) {
    const provider = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.client_payment_providers.findFirst({
        where: { client_id: BigInt(clientId), provider_name: WOMPI_PROVIDER_NAME },
        select: {
          config: true,
          webhook_secret: true,
          status: true,
          updated_at: true,
        },
      }),
    );

    if (!provider) {
      return {
        configured: false,
        enabled: false,
        public_key: '',
        has_private_key: false,
        has_webhook_secret: false,
        updated_at: null as string | null,
      };
    }

    const config = (provider.config ?? {}) as StoredConfig;
    return {
      configured: true,
      enabled: provider.status === 'ACTIVE',
      public_key: config.public_key ?? '',
      has_private_key: Boolean(config.private_key),
      has_webhook_secret: Boolean(provider.webhook_secret),
      updated_at: provider.updated_at?.toISOString() ?? null,
    };
  },

  /** Crea o actualiza el proveedor Wompi del Cliente. */
  async upsertWompiConfig(clientId: number, input: WompiConfigInput) {
    return withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.client_payment_providers.findFirst({
        where: { client_id: BigInt(clientId), provider_name: WOMPI_PROVIDER_NAME },
        select: { id: true, config: true, webhook_secret: true },
      });

      const prevConfig = (existing?.config ?? {}) as StoredConfig;
      const nextConfig: StoredConfig = {
        public_key: input.public_key,
        // Secreto vacío/omitido → se conserva el anterior.
        private_key: input.private_key && input.private_key.length > 0
          ? input.private_key
          : prevConfig.private_key,
      };
      const nextWebhookSecret =
        input.events_secret && input.events_secret.length > 0
          ? input.events_secret
          : (existing?.webhook_secret ?? null);

      const status = input.enabled ? 'ACTIVE' : 'INACTIVE';
      const now = new Date();

      if (existing) {
        await tx.client_payment_providers.update({
          where: { id_client_id: { id: existing.id, client_id: BigInt(clientId) } },
          data: {
            config: toJsonConfig(nextConfig),
            webhook_secret: nextWebhookSecret,
            status,
            updated_at: now,
          },
        });
      } else {
        await tx.client_payment_providers.create({
          data: {
            client_id: BigInt(clientId),
            provider_type: WOMPI_PROVIDER_TYPE,
            provider_name: WOMPI_PROVIDER_NAME,
            display_name: 'Wompi',
            config: toJsonConfig(nextConfig),
            webhook_secret: nextWebhookSecret,
            status,
            is_default: true,
            applicable_payment_methods: WOMPI_METHODS,
            created_at: now,
            updated_at: now,
          },
        });
      }

      // Se construye la respuesta con lo que se acaba de escribir, sin re-leer:
      // una lectura en otra conexión no vería la fila hasta que esta transacción
      // haga commit. Los secretos, igual, nunca se devuelven.
      return {
        configured: true,
        enabled: status === 'ACTIVE',
        public_key: nextConfig.public_key ?? '',
        has_private_key: Boolean(nextConfig.private_key),
        has_webhook_secret: Boolean(nextWebhookSecret),
        updated_at: now.toISOString(),
      };
    });
  },

  /**
   * ¿El Cliente puede recibir pagos online? Verdadero solo si el proveedor está
   * ACTIVO y tiene public + private key cargadas. Lo usa el storefront para
   * mostrar u ocultar la opción de Wompi en el checkout.
   */
  async isOnlinePaymentEnabled(clientId: number): Promise<boolean> {
    const provider = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      tx.client_payment_providers.findFirst({
        where: {
          client_id: BigInt(clientId),
          status: 'ACTIVE',
          applicable_payment_methods: { has: 'ONLINE_AT_ORDER' },
        },
        select: { config: true },
      }),
    );

    if (!provider) return false;
    const config = (provider.config ?? {}) as StoredConfig;
    return Boolean(config.public_key && config.private_key);
  },
};
