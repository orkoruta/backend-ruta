import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { createRutaAdminClientsRouter } from '../routes/ruta_admin_clients.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

function testApp(service: Parameters<typeof createRutaAdminClientsRouter>[0], user?: AuthenticatedUser) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = user;
      next();
    });
  }
  app.use('/ruta-admin/clients', createRutaAdminClientsRouter(service));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.statusCode).json(sendHttpError(err));
      return;
    }
    res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno del servidor'));
  });
  return app;
}

function serviceMock() {
  return {
    list: vi.fn().mockResolvedValue({ items: [], pagination: { page: 1, page_size: 20, total: 0 } }),
    getById: vi.fn().mockResolvedValue({ id: 10, slug: 'cliente-test' }),
    create: vi.fn().mockResolvedValue({ id: 10, slug: 'cliente-test' }),
    update: vi.fn().mockResolvedValue({ id: 10, slug: 'cliente-test' }),
    activate: vi.fn().mockResolvedValue({ id: 10, status: 'ACTIVE' }),
    deactivate: vi.fn().mockResolvedValue({ id: 10, status: 'INACTIVE' }),
    purge: vi.fn().mockResolvedValue({ id: 10 }),
  };
}

const adminRuta = { id: 9, client_id: 0, user_type: 'ADMIN_RUTA' };

describe('ruta-admin clients routes', () => {
  it('rechaza requests sin autenticación', async () => {
    const service = serviceMock();
    const res = await request(testApp(service)).get('/ruta-admin/clients').expect(401);

    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('rechaza usuarios que no son ADMIN_RUTA', async () => {
    const service = serviceMock();
    const res = await request(testApp(service, { id: 10, client_id: 1, user_type: 'ADMIN_CLIENT' }))
      .get('/ruta-admin/clients')
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('lista clientes con filtros paginados', async () => {
    const service = serviceMock();
    await request(testApp(service, adminRuta))
      .get('/ruta-admin/clients?status=ACTIVE&client_type=FULL&page=2&page_size=5')
      .expect(200);

    expect(service.list).toHaveBeenCalledWith({
      status: 'ACTIVE',
      client_type: 'FULL',
      page: 2,
      page_size: 5,
    });
  });

  it('requiere idempotency key para crear clientes', async () => {
    const service = serviceMock();
    const res = await request(testApp(service, adminRuta))
      .post('/ruta-admin/clients')
      .send({
        business_code: 'CLI001',
        slug: 'cliente-test',
        name: 'Cliente Test',
        client_type: 'FULL',
        frontend_mode: 'NATIVE_RUTA',
      })
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(service.create).not.toHaveBeenCalled();
  });

  it('crea clientes FULL con frontend_mode', async () => {
    const service = serviceMock();
    await request(testApp(service, adminRuta))
      .post('/ruta-admin/clients')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({
        business_code: 'CLI001',
        slug: 'cliente-test',
        name: 'Cliente Test',
        client_type: 'FULL',
        frontend_mode: 'NATIVE_RUTA',
      })
      .expect(201);

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'cliente-test', client_type: 'FULL', frontend_mode: 'NATIVE_RUTA' }),
      expect.objectContaining({ user: adminRuta })
    );
  });

  it('valida que cliente FULL tenga frontend_mode', async () => {
    const service = serviceMock();
    const res = await request(testApp(service, adminRuta))
      .post('/ruta-admin/clients')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({
        business_code: 'CLI002',
        slug: 'cliente-sin-front',
        name: 'Cliente Sin Front',
        client_type: 'FULL',
      })
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(service.create).not.toHaveBeenCalled();
  });

  it('obtiene cliente por id', async () => {
    const service = serviceMock();
    const res = await request(testApp(service, adminRuta))
      .get('/ruta-admin/clients/10')
      .expect(200);

    expect(res.body.slug).toBe('cliente-test');
    expect(service.getById).toHaveBeenCalledWith(10);
  });

  it('actualiza, activa, desactiva y elimina por id', async () => {
    const service = serviceMock();
    const app = testApp(service, adminRuta);

    await request(app)
      .patch('/ruta-admin/clients/10')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ name: 'Nuevo Nombre' })
      .expect(200);
    await request(app).post('/ruta-admin/clients/10/activate').set('X-Idempotency-Key', crypto.randomUUID()).expect(200);
    await request(app).post('/ruta-admin/clients/10/deactivate').set('X-Idempotency-Key', crypto.randomUUID()).expect(200);
    await request(app).delete('/ruta-admin/clients/10').set('X-Idempotency-Key', crypto.randomUUID()).expect(204);

    expect(service.update).toHaveBeenCalledWith(10, { name: 'Nuevo Nombre' }, expect.objectContaining({ user: adminRuta }));
    expect(service.activate).toHaveBeenCalledWith(10, expect.objectContaining({ user: adminRuta }));
    expect(service.deactivate).toHaveBeenCalledWith(10, expect.objectContaining({ user: adminRuta }));
    expect(service.purge).toHaveBeenCalledWith(10, expect.objectContaining({ user: adminRuta }));
  });
});
