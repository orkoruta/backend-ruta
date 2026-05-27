import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { createAdminProductsRouter } from '../routes/admin_products.js';
import { createAdminCategoriesRouter } from '../routes/admin_categories.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

const adminClient: AuthenticatedUser = { id: 5, client_id: 1, user_type: 'ADMIN_CLIENT', session_id: 10 };

function testProductApp(service: Parameters<typeof createAdminProductsRouter>[0], user?: AuthenticatedUser) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = user;
      next();
    });
  }
  app.use('/admin/products', createAdminProductsRouter(service));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.statusCode).json(sendHttpError(err));
      return;
    }
    res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno'));
  });
  return app;
}

function testCategoryApp(service: Parameters<typeof createAdminCategoriesRouter>[0], user?: AuthenticatedUser) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = user;
      next();
    });
  }
  app.use('/admin/categories', createAdminCategoriesRouter(service));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.statusCode).json(sendHttpError(err));
      return;
    }
    res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno'));
  });
  return app;
}

function productServiceMock() {
  return {
    list: vi.fn().mockResolvedValue({ items: [], pagination: { page: 1, page_size: 20, total: 0 } }),
    getById: vi.fn().mockResolvedValue({ id: 1, name: 'Producto Test', client_id: 1 }),
    create: vi.fn().mockResolvedValue({ id: 1, name: 'Producto Test', client_id: 1, status: 'ACTIVE' }),
    update: vi.fn().mockResolvedValue({ id: 1, name: 'Producto Actualizado', client_id: 1 }),
    activate: vi.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }),
    deactivate: vi.fn().mockResolvedValue({ id: 1, status: 'INACTIVE' }),
  };
}

function categoryServiceMock() {
  return {
    list: vi.fn().mockResolvedValue({ items: [], pagination: { page: 1, page_size: 50, total: 0 } }),
    getById: vi.fn().mockResolvedValue({ id: 1, name: 'Categoría Test', client_id: 1 }),
    create: vi.fn().mockResolvedValue({ id: 1, name: 'Categoría Test', client_id: 1, status: 'ACTIVE' }),
    update: vi.fn().mockResolvedValue({ id: 1, name: 'Categoría Actualizada', client_id: 1 }),
    activate: vi.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }),
    deactivate: vi.fn().mockResolvedValue({ id: 1, status: 'INACTIVE' }),
  };
}

describe('admin products routes', () => {
  it('rechaza sin autenticación', async () => {
    const service = productServiceMock();
    const res = await request(testProductApp(service)).get('/admin/products').expect(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('rechaza usuario que no es ADMIN_CLIENT', async () => {
    const service = productServiceMock();
    const buyer: AuthenticatedUser = { id: 10, client_id: 1, user_type: 'BUYER', session_id: 11 };
    const res = await request(testProductApp(service, buyer)).get('/admin/products').expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('lista productos con filtros', async () => {
    const service = productServiceMock();
    await request(testProductApp(service, adminClient))
      .get('/admin/products?status=ACTIVE&page=1&page_size=10')
      .expect(200);
    expect(service.list).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ACTIVE', page: 1, page_size: 10 }));
  });

  it('crea producto válido', async () => {
    const service = productServiceMock();
    await request(testProductApp(service, adminClient))
      .post('/admin/products')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ name: 'Producto', unit_price: 10000, product_type: 'VENTA_NORMAL' })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ name: 'Producto', unit_price: 10000 }),
      expect.objectContaining({ user: adminClient })
    );
  });

  it('valida campos requeridos al crear', async () => {
    const service = productServiceMock();
    const res = await request(testProductApp(service, adminClient))
      .post('/admin/products')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ name: 'Sin precio' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(service.create).not.toHaveBeenCalled();
  });

  it('actualiza, activa y desactiva por id', async () => {
    const service = productServiceMock();
    const app = testProductApp(service, adminClient);
    await request(app).patch('/admin/products/1').set('X-Idempotency-Key', crypto.randomUUID()).send({ name: 'Nuevo' }).expect(200);
    await request(app).post('/admin/products/1/activate').set('X-Idempotency-Key', crypto.randomUUID()).expect(200);
    await request(app).post('/admin/products/1/deactivate').set('X-Idempotency-Key', crypto.randomUUID()).expect(200);
    expect(service.update).toHaveBeenCalledWith(1, 1, { name: 'Nuevo' }, expect.anything());
    expect(service.activate).toHaveBeenCalledWith(1, 1, expect.anything());
    expect(service.deactivate).toHaveBeenCalledWith(1, 1, expect.anything());
  });
});

describe('admin categories routes', () => {
  it('rechaza sin autenticación', async () => {
    const service = categoryServiceMock();
    const res = await request(testCategoryApp(service)).get('/admin/categories').expect(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('lista categorías', async () => {
    const service = categoryServiceMock();
    await request(testCategoryApp(service, adminClient))
      .get('/admin/categories')
      .expect(200);
    expect(service.list).toHaveBeenCalledWith(1, expect.objectContaining({ page: 1 }));
  });

  it('crea categoría válida', async () => {
    const service = categoryServiceMock();
    await request(testCategoryApp(service, adminClient))
      .post('/admin/categories')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ name: 'Electrónicos' })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ name: 'Electrónicos' }),
      expect.objectContaining({ user: adminClient })
    );
  });

  it('actualiza y desactiva categoría', async () => {
    const service = categoryServiceMock();
    const app = testCategoryApp(service, adminClient);
    await request(app).patch('/admin/categories/1').set('X-Idempotency-Key', crypto.randomUUID()).send({ name: 'Nueva' }).expect(200);
    await request(app).post('/admin/categories/1/deactivate').set('X-Idempotency-Key', crypto.randomUUID()).expect(200);
    expect(service.update).toHaveBeenCalledWith(1, 1, { name: 'Nueva' }, expect.anything());
    expect(service.deactivate).toHaveBeenCalledWith(1, 1, expect.anything());
  });
});
