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
/**
 * Nequi Negocios se modela como proveedor de tipo `PAYMENT_LINK` en la misma
 * tabla, sin tocar el esquema: la CHECK ya admite ese `provider_type`.
 *
 * **No es una pasarela.** Un link de Nequi Negocios es una URL estática que el
 * negocio publica; el comprador paga desde su app y **no hay webhook de vuelta**.
 * RUTA no puede enterarse sola de que el pago ocurrió, así que el Cliente lo
 * confirma a mano desde el detalle del pedido. De ahí dos consecuencias en el
 * resto del código:
 *   1. El link **no es secreto** (está pensado para compartirse), a diferencia
 *      de las llaves de Wompi: se devuelve tal cual.
 *   2. Estos pedidos quedan fuera del job de expiración por falta de pago
 *      (`payment_timeout.job.ts`), que si no los cancelaría a todos.
 */
const NEQUI_PROVIDER_NAME = 'nequi';
const NEQUI_PROVIDER_TYPE = 'PAYMENT_LINK';
const NEQUI_METHODS = ['ONLINE_AT_ORDER'];
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

export const nequiConfigSchema = z.object({
  enabled: z.boolean(),
  /**
   * URL del link de pago de Nequi Negocios. Se exige http(s) para no acabar
   * pintándole al comprador un enlace que no abre.
   */
  payment_link: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'El link debe empezar por http:// o https://')
    .optional()
    .default(''),
});

export type NequiConfigInput = z.infer<typeof nequiConfigSchema>;

type StoredConfig = {
  public_key?: string;
  private_key?: string;
  payment_link?: string;
};

/** Config lista para escribir en el JSONB: sin claves `undefined`. */
function toJsonConfig(config: StoredConfig): Record<string, string> {
  const out: Record<string, string> = {};
  if (config.public_key) out.public_key = config.public_key;
  if (config.private_key) out.private_key = config.private_key;
  if (config.payment_link) out.payment_link = config.payment_link;
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

  /** Estado de la config de Nequi. El link no es secreto: se devuelve entero. */
  async getNequiConfig(clientId: number) {
    const provider = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.client_payment_providers.findFirst({
        where: { client_id: BigInt(clientId), provider_name: NEQUI_PROVIDER_NAME },
        select: { config: true, status: true, updated_at: true },
      }),
    );

    if (!provider) {
      return {
        configured: false,
        enabled: false,
        payment_link: '',
        updated_at: null as string | null,
      };
    }

    const config = (provider.config ?? {}) as StoredConfig;
    return {
      configured: true,
      enabled: provider.status === 'ACTIVE',
      payment_link: config.payment_link ?? '',
      updated_at: provider.updated_at?.toISOString() ?? null,
    };
  },

  /** Crea o actualiza el link de pago de Nequi del Cliente. */
  async upsertNequiConfig(clientId: number, input: NequiConfigInput) {
    return withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.client_payment_providers.findFirst({
        where: { client_id: BigInt(clientId), provider_name: NEQUI_PROVIDER_NAME },
        select: { id: true },
      });

      // Activar sin link dejaría al comprador con una opción que no lleva a
      // ningún sitio, así que el estado real depende de que el link exista.
      const status = input.enabled && input.payment_link ? 'ACTIVE' : 'INACTIVE';
      const now = new Date();
      const config = toJsonConfig({ payment_link: input.payment_link });

      if (existing) {
        await tx.client_payment_providers.update({
          where: { id_client_id: { id: existing.id, client_id: BigInt(clientId) } },
          data: { config, status, updated_at: now },
        });
      } else {
        await tx.client_payment_providers.create({
          data: {
            client_id: BigInt(clientId),
            provider_type: NEQUI_PROVIDER_TYPE,
            provider_name: NEQUI_PROVIDER_NAME,
            display_name: 'Nequi Negocios',
            config,
            // `is_default` en false: el proveedor por defecto de ONLINE_AT_ORDER
            // sigue siendo Wompi, que es el que resuelve `initiate-payment`.
            is_default: false,
            applicable_payment_methods: NEQUI_METHODS,
            created_at: now,
            updated_at: now,
          },
        });
      }

      return {
        configured: true,
        enabled: status === 'ACTIVE',
        payment_link: input.payment_link,
        updated_at: now.toISOString(),
      };
    });
  },

  /**
   * ¿El Cliente puede recibir pagos online por Wompi? Verdadero solo si el
   * proveedor está ACTIVO y tiene public + private key cargadas. Lo usa el
   * storefront para mostrar u ocultar la opción de Wompi en el checkout.
   */
  async isOnlinePaymentEnabled(clientId: number): Promise<boolean> {
    const provider = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      tx.client_payment_providers.findFirst({
        where: {
          client_id: BigInt(clientId),
          status: 'ACTIVE',
          provider_name: WOMPI_PROVIDER_NAME,
        },
        select: { config: true },
      }),
    );

    if (!provider) return false;
    const config = (provider.config ?? {}) as StoredConfig;
    return Boolean(config.public_key && config.private_key);
  },

  /**
   * Link de Nequi del Cliente, o `null` si no lo tiene activo. El storefront lo
   * usa para decidir si ofrece la opción y para mostrarle la URL al comprador.
   */
  async getActiveNequiLink(clientId: number): Promise<string | null> {
    const provider = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      tx.client_payment_providers.findFirst({
        where: {
          client_id: BigInt(clientId),
          status: 'ACTIVE',
          provider_name: NEQUI_PROVIDER_NAME,
        },
        select: { config: true },
      }),
    );

    if (!provider) return null;
    const config = (provider.config ?? {}) as StoredConfig;
    return config.payment_link || null;
  },
};
