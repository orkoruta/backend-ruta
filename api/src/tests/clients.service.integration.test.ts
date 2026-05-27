import { describe, expect, it } from 'vitest';
import { clientsService } from '../services/clients.service.js';

const runIntegration = process.env.RUN_DB_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);

const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration('clientsService integration', () => {
  it('crea, lista, actualiza, desactiva y elimina un cliente de prueba con auditoría', async () => {
    const suffix = Date.now().toString();
    const ctx = {
      user: { id: 9, client_id: 0, user_type: 'ADMIN_RUTA' },
      ip: '127.0.0.1',
      userAgent: 'vitest-integration',
    };

    const created = await clientsService.create({
      business_code: `IT${suffix}`,
      slug: `ruta-it-${suffix}`,
      name: `Ruta IT ${suffix}`,
      client_type: 'FULL',
      frontend_mode: 'NATIVE_RUTA',
    }, ctx);

    expect(created.id).toBeGreaterThan(0);
    expect(created.status).toBe('ACTIVE');

    const listed = await clientsService.list({ q: created.slug, page: 1, page_size: 10 });
    expect(listed.items.some((client) => client.id === created.id)).toBe(true);

    const updated = await clientsService.update(created.id, { name: `Ruta IT Updated ${suffix}` }, ctx);
    expect(updated.name).toBe(`Ruta IT Updated ${suffix}`);

    const deactivated = await clientsService.deactivate(created.id, ctx);
    expect(deactivated.status).toBe('INACTIVE');

    await expect(clientsService.purge(created.id, ctx)).resolves.toMatchObject({
      id: created.id,
      status: 'INACTIVE',
    });
  });
});
