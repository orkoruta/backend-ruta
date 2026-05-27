import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { createAdminBuyersRouter } from '../routes/admin_buyers.js';
import { createAdminCouriersRouter } from '../routes/admin_couriers.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

const adminClient: AuthenticatedUser = { id: 5, client_id: 1, user_type: 'ADMIN_CLIENT', session_id: 10 };

function testBuyerApp(service: Parameters<typeof createAdminBuyersRouter>[0], user?: AuthenticatedUser) {
  const app = express();
  app.use(express.json());
  if (user) app.use((req: Request, _res: Response, next: NextFunction) => { req.user = user; next(); });
  app.use('/admin/buyers', createAdminBuyersRouter(service));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) { res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() }); return; }
    if (err instanceof HttpError) { res.status(err.statusCode).json(sendHttpError(err)); return; }
    res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno'));
  });
  return app;
}

function testCourierApp(service: Parameters<typeof createAdminCouriersRouter>[0], user?: AuthenticatedUser) {
  const app = express();
  app.use(express.json());
  if (user) app.use((req: Request, _res: Response, next: NextFunction) => { req.user = user; next(); });
  app.use('/admin/couriers', createAdminCouriersRouter(service));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) { res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() }); return; }
    if (err instanceof HttpError) { res.status(err.statusCode).json(sendHttpError(err)); return; }
    res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno'));
  });
  return app;
}

const mockBuyer = { id: 10, client_id: 1, email: 'buyer@test.com', status: 'ACTIVE', profile: null };
const mockCourier = { id: 20, client_id: 1, email: 'courier@test.com', status: 'ACTIVE', profile: null };

function buyerServiceMock() {
  return {
    list: vi.fn().mockResolvedValue({ items: [mockBuyer], pagination: { page: 1, page_size: 20, total: 1 } }),
    getById: vi.fn().mockResolvedValue(mockBuyer),
    create: vi.fn().mockResolvedValue(mockBuyer),
    update: vi.fn().mockResolvedValue(mockBuyer),
    activate: vi.fn().mockResolvedValue({ ...mockBuyer, status: 'ACTIVE' }),
    deactivate: vi.fn().mockResolvedValue({ ...mockBuyer, status: 'INACTIVE' }),
  };
}

function courierServiceMock() {
  return {
    list: vi.fn().mockResolvedValue({ items: [mockCourier], pagination: { page: 1, page_size: 20, total: 1 } }),
    getById: vi.fn().mockResolvedValue(mockCourier),
    create: vi.fn().mockResolvedValue(mockCourier),
    update: vi.fn().mockResolvedValue(mockCourier),
    activate: vi.fn().mockResolvedValue({ ...mockCourier, status: 'ACTIVE' }),
    deactivate: vi.fn().mockResolvedValue({ ...mockCourier, status: 'INACTIVE' }),
  };
}

describe('admin buyers routes', () => {
  it('rechaza sin autenticación', async () => {
    const service = buyerServiceMock();
    const res = await request(testBuyerApp(service)).get('/admin/buyers').expect(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('rechaza usuario que no es ADMIN_CLIENT', async () => {
    const service = buyerServiceMock();
    const buyer: AuthenticatedUser = { id: 99, client_id: 1, user_type: 'BUYER', session_id: 1 };
    await request(testBuyerApp(service, buyer)).get('/admin/buyers').expect(403);
  });

  it('lista compradores con filtros', async () => {
    const service = buyerServiceMock();
    const res = await request(testBuyerApp(service, adminClient))
      .get('/admin/buyers?status=ACTIVE&page=1&page_size=10')
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(service.list).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ACTIVE', page: 1, page_size: 10 }));
  });

  it('obtiene comprador por id', async () => {
    const service = buyerServiceMock();
    const res = await request(testBuyerApp(service, adminClient))
      .get('/admin/buyers/10')
      .expect(200);
    expect(res.body.email).toBe('buyer@test.com');
    expect(service.getById).toHaveBeenCalledWith(1, 10);
  });

  it('crea comprador válido', async () => {
    const service = buyerServiceMock();
    await request(testBuyerApp(service, adminClient))
      .post('/admin/buyers')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ email: 'nuevo@test.com', password: 'password123', full_name: 'Nuevo Comprador' })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ email: 'nuevo@test.com' }),
      expect.objectContaining({ user: adminClient })
    );
  });

  it('valida campos requeridos al crear comprador', async () => {
    const service = buyerServiceMock();
    const res = await request(testBuyerApp(service, adminClient))
      .post('/admin/buyers')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ email: 'bad' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(service.create).not.toHaveBeenCalled();
  });

  it('actualiza, activa y desactiva comprador', async () => {
    const service = buyerServiceMock();
    const app = testBuyerApp(service, adminClient);
    await request(app).patch('/admin/buyers/10').set('X-Idempotency-Key', crypto.randomUUID()).send({ full_name: 'Nuevo Nombre' }).expect(200);
    await request(app).post('/admin/buyers/10/activate').set('X-Idempotency-Key', crypto.randomUUID()).expect(200);
    await request(app).post('/admin/buyers/10/deactivate').set('X-Idempotency-Key', crypto.randomUUID()).expect(200);
    expect(service.update).toHaveBeenCalledWith(1, 10, { full_name: 'Nuevo Nombre' }, expect.anything());
    expect(service.activate).toHaveBeenCalledWith(1, 10, expect.anything());
    expect(service.deactivate).toHaveBeenCalledWith(1, 10, expect.anything());
  });
});

describe('admin couriers routes', () => {
  it('rechaza sin autenticación', async () => {
    const service = courierServiceMock();
    const res = await request(testCourierApp(service)).get('/admin/couriers').expect(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('lista repartidores', async () => {
    const service = courierServiceMock();
    const res = await request(testCourierApp(service, adminClient))
      .get('/admin/couriers?q=juan')
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(service.list).toHaveBeenCalledWith(1, expect.objectContaining({ q: 'juan' }));
  });

  it('crea repartidor válido', async () => {
    const service = courierServiceMock();
    await request(testCourierApp(service, adminClient))
      .post('/admin/couriers')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ email: 'courier@test.com', password: 'password123', full_name: 'Juan Courier', phone: '3001234567' })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ email: 'courier@test.com', phone: '3001234567' }),
      expect.objectContaining({ user: adminClient })
    );
  });

  it('valida campos requeridos al crear repartidor', async () => {
    const service = courierServiceMock();
    const res = await request(testCourierApp(service, adminClient))
      .post('/admin/couriers')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ email: 'ok@test.com', password: 'pass123' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(service.create).not.toHaveBeenCalled();
  });

  it('actualiza y desactiva repartidor', async () => {
    const service = courierServiceMock();
    const app = testCourierApp(service, adminClient);
    await request(app).patch('/admin/couriers/20').set('X-Idempotency-Key', crypto.randomUUID()).send({ transport_mode: 'MOTO' }).expect(200);
    await request(app).post('/admin/couriers/20/deactivate').set('X-Idempotency-Key', crypto.randomUUID()).expect(200);
    expect(service.update).toHaveBeenCalledWith(1, 20, { transport_mode: 'MOTO' }, expect.anything());
    expect(service.deactivate).toHaveBeenCalledWith(1, 20, expect.anything());
  });
});
