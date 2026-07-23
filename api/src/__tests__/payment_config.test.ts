import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Config Wompi por Cliente. Lo delicado: los secretos se conservan al actualizar
 * si vienen en blanco, y nunca se devuelven al leer.
 */

let existingRow: {
  id: bigint;
  config: unknown;
  webhook_secret: string | null;
  status: string;
  updated_at: Date;
} | null = null;

const captured: { config?: unknown; webhook_secret?: unknown; status?: unknown } = {};

const tx = {
  client_payment_providers: {
    findFirst: vi.fn(async () => existingRow),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      captured.config = data.config;
      captured.webhook_secret = data.webhook_secret;
      captured.status = data.status;
      return {};
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      captured.config = data.config;
      captured.webhook_secret = data.webhook_secret;
      captured.status = data.status;
      return {};
    }),
  },
};

vi.mock('@orkoruta/db', () => ({
  withTenant: (_c: number, _r: string, fn: (t: unknown) => unknown) => fn(tx),
  withTenantReadOnly: (_c: number, _r: string, fn: (t: unknown) => unknown) => fn(tx),
}));

const { paymentConfigService } = await import('../services/payment_config.service.js');

describe('paymentConfigService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existingRow = null;
    captured.config = undefined;
    captured.webhook_secret = undefined;
    captured.status = undefined;
  });

  it('getWompiConfig sin proveedor → no configurado', async () => {
    const result = await paymentConfigService.getWompiConfig(7);
    expect(result.configured).toBe(false);
    expect(result.has_private_key).toBe(false);
  });

  it('getWompiConfig nunca devuelve los secretos, solo si existen', async () => {
    existingRow = {
      id: 1n,
      config: { public_key: 'pub_x', private_key: 'prv_SECRETO' },
      webhook_secret: 'evt_SECRETO',
      status: 'ACTIVE',
      updated_at: new Date(),
    };
    const result = await paymentConfigService.getWompiConfig(7);
    expect(result.public_key).toBe('pub_x');
    expect(result.has_private_key).toBe(true);
    expect(result.has_webhook_secret).toBe(true);
    // El objeto no expone los valores secretos.
    expect(JSON.stringify(result)).not.toContain('prv_SECRETO');
    expect(JSON.stringify(result)).not.toContain('evt_SECRETO');
  });

  it('al actualizar con secretos en blanco, conserva los guardados', async () => {
    existingRow = {
      id: 1n,
      config: { public_key: 'pub_viejo', private_key: 'prv_GUARDADO' },
      webhook_secret: 'evt_GUARDADO',
      status: 'ACTIVE',
      updated_at: new Date(),
    };
    await paymentConfigService.upsertWompiConfig(7, {
      enabled: true,
      public_key: 'pub_nuevo',
    });
    expect(captured.config).toEqual({ public_key: 'pub_nuevo', private_key: 'prv_GUARDADO' });
    expect(captured.webhook_secret).toBe('evt_GUARDADO');
  });

  it('al pasar secretos nuevos, los reemplaza', async () => {
    existingRow = {
      id: 1n,
      config: { public_key: 'pub', private_key: 'prv_viejo' },
      webhook_secret: 'evt_viejo',
      status: 'ACTIVE',
      updated_at: new Date(),
    };
    await paymentConfigService.upsertWompiConfig(7, {
      enabled: true,
      public_key: 'pub',
      private_key: 'prv_NUEVO',
      events_secret: 'evt_NUEVO',
    });
    expect((captured.config as { private_key: string }).private_key).toBe('prv_NUEVO');
    expect(captured.webhook_secret).toBe('evt_NUEVO');
  });

  it('enabled:false → status INACTIVE', async () => {
    await paymentConfigService.upsertWompiConfig(7, { enabled: false, public_key: 'pub' });
    expect(captured.status).toBe('INACTIVE');
  });

  it('isOnlinePaymentEnabled: true solo con public + private key', async () => {
    existingRow = {
      id: 1n,
      config: { public_key: 'pub', private_key: 'prv' },
      webhook_secret: null,
      status: 'ACTIVE',
      updated_at: new Date(),
    };
    expect(await paymentConfigService.isOnlinePaymentEnabled(7)).toBe(true);

    existingRow = {
      id: 1n,
      config: { public_key: 'pub' }, // sin private key
      webhook_secret: null,
      status: 'ACTIVE',
      updated_at: new Date(),
    };
    expect(await paymentConfigService.isOnlinePaymentEnabled(7)).toBe(false);
  });
});
