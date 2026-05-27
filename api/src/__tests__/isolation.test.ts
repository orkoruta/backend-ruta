/**
 * isolation.test.ts — Suite de aislamiento cross-tenant (1.QA-1)
 *
 * Verifica que ningún endpoint permita acceso a recursos de otro cliente.
 * Un fallo en esta suite es un hallazgo de seguridad crítico y bloquea el merge.
 *
 * Cobertura:
 *   G1 — RBAC: roles sin permiso reciben 401/403 en todos los endpoints protegidos
 *   G2 — Cross-tenant /admin/*: el service siempre recibe el client_id del TOKEN
 *   G3 — ADMIN_RUTA sobre /admin/*: accede con client_id=0, no con el de ningún tenant
 *   G4 — /ruta-admin/clients: solo accesible por ADMIN_RUTA
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { createAdminProductsRouter } from '../routes/admin_products.js';
import { createAdminCategoriesRouter } from '../routes/admin_categories.js';
import { createAdminBuyersRouter } from '../routes/admin_buyers.js';
import { createAdminCouriersRouter } from '../routes/admin_couriers.js';
import { createRutaAdminClientsRouter } from '../routes/ruta_admin_clients.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

// ─── Fixtures de usuarios (dos tenants distintos) ────────────────────────────

const clientA_admin: AuthenticatedUser = { id: 10, client_id: 1, user_type: 'ADMIN_CLIENT', session_id: 100 };
const clientB_admin: AuthenticatedUser = { id: 20, client_id: 2, user_type: 'ADMIN_CLIENT', session_id: 200 };
const rutaAdmin: AuthenticatedUser = { id: 1, client_id: 0, user_type: 'ADMIN_RUTA', session_id: 1 };
const buyerUser: AuthenticatedUser = { id: 30, client_id: 1, user_type: 'BUYER', session_id: 300 };
const courierUser: AuthenticatedUser = { id: 40, client_id: 1, user_type: 'COURIER', session_id: 400 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ ...toApiError('VALIDATION_ERROR', 'Datos inválidos'), details: err.flatten() });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.statusCode).json(sendHttpError(err));
    return;
  }
  res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno'));
}

type RouterFactory<T> = (service: T) => ReturnType<typeof express.Router>;

function makeApp<T>(mountPath: string, factory: RouterFactory<T>, service: T, user?: AuthenticatedUser) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = user;
      next();
    });
  }
  app.use(mountPath, factory(service));
  app.use(errorHandler);
  return app;
}

// ─── Service mocks ─────────────────────────────────────────────────────────────

function productsMock() {
  return {
    list: vi.fn().mockResolvedValue({ items: [], pagination: { page: 1, page_size: 20, total: 0 } }),
    getById: vi.fn().mockResolvedValue({ id: 1, name: 'Test', client_id: 1 }),
    create: vi.fn().mockResolvedValue({ id: 1, name: 'Test', client_id: 1, status: 'ACTIVE' }),
    update: vi.fn().mockResolvedValue({ id: 1, name: 'Test', client_id: 1 }),
    activate: vi.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }),
    deactivate: vi.fn().mockResolvedValue({ id: 1, status: 'INACTIVE' }),
  };
}

function categoriesMock() {
  return {
    list: vi.fn().mockResolvedValue({ items: [], pagination: { page: 1, page_size: 50, total: 0 } }),
    getById: vi.fn().mockResolvedValue({ id: 1, name: 'Test', client_id: 1 }),
    create: vi.fn().mockResolvedValue({ id: 1, name: 'Test', client_id: 1, status: 'ACTIVE' }),
    update: vi.fn().mockResolvedValue({ id: 1, name: 'Test', client_id: 1 }),
    activate: vi.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }),
    deactivate: vi.fn().mockResolvedValue({ id: 1, status: 'INACTIVE' }),
  };
}

function buyersMock() {
  return {
    list: vi.fn().mockResolvedValue({ items: [], pagination: { page: 1, page_size: 20, total: 0 } }),
    getById: vi.fn().mockResolvedValue({ id: 1, client_id: 1, email: 'buyer@test.com', status: 'ACTIVE', profile: null }),
    create: vi.fn().mockResolvedValue({ id: 1, client_id: 1, email: 'buyer@test.com', status: 'ACTIVE', profile: null }),
    update: vi.fn().mockResolvedValue({ id: 1, client_id: 1, email: 'buyer@test.com', status: 'ACTIVE', profile: null }),
    activate: vi.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }),
    deactivate: vi.fn().mockResolvedValue({ id: 1, status: 'INACTIVE' }),
  };
}

function couriersMock() {
  return {
    list: vi.fn().mockResolvedValue({ items: [], pagination: { page: 1, page_size: 20, total: 0 } }),
    getById: vi.fn().mockResolvedValue({ id: 1, client_id: 1, email: 'courier@test.com', status: 'ACTIVE', profile: null }),
    create: vi.fn().mockResolvedValue({ id: 1, client_id: 1, email: 'courier@test.com', status: 'ACTIVE', profile: null }),
    update: vi.fn().mockResolvedValue({ id: 1, client_id: 1, email: 'courier@test.com', status: 'ACTIVE', profile: null }),
    activate: vi.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }),
    deactivate: vi.fn().mockResolvedValue({ id: 1, status: 'INACTIVE' }),
  };
}

function clientsMock() {
  return {
    list: vi.fn().mockResolvedValue({ items: [], pagination: { page: 1, page_size: 20, total: 0 } }),
    getById: vi.fn().mockResolvedValue({ id: 1, name: 'Test', slug: 'test', status: 'ACTIVE' }),
    create: vi.fn().mockResolvedValue({ id: 1, name: 'Test', slug: 'test', status: 'ACTIVE' }),
    update: vi.fn().mockResolvedValue({ id: 1, name: 'Test', slug: 'test', status: 'ACTIVE' }),
    activate: vi.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }),
    deactivate: vi.fn().mockResolvedValue({ id: 1, status: 'INACTIVE' }),
    purge: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── G1 — RBAC: autenticación y permisos por rol ─────────────────────────────

describe('G1 — RBAC: sin autenticación → 401 en todos los endpoints protegidos', () => {
  it('GET /admin/products sin auth → 401', async () => {
    const service = productsMock();
    const res = await request(makeApp('/admin/products', createAdminProductsRouter, service))
      .get('/admin/products')
      .expect(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('GET /admin/categories sin auth → 401', async () => {
    const service = categoriesMock();
    const res = await request(makeApp('/admin/categories', createAdminCategoriesRouter, service))
      .get('/admin/categories')
      .expect(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('GET /admin/buyers sin auth → 401', async () => {
    const service = buyersMock();
    const res = await request(makeApp('/admin/buyers', createAdminBuyersRouter, service))
      .get('/admin/buyers')
      .expect(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('GET /admin/couriers sin auth → 401', async () => {
    const service = couriersMock();
    const res = await request(makeApp('/admin/couriers', createAdminCouriersRouter, service))
      .get('/admin/couriers')
      .expect(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('GET /ruta-admin/clients sin auth → 401', async () => {
    const service = clientsMock();
    const res = await request(makeApp('/ruta-admin/clients', createRutaAdminClientsRouter, service))
      .get('/ruta-admin/clients')
      .expect(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.list).not.toHaveBeenCalled();
  });
});

describe('G1 — RBAC: BUYER no puede acceder a endpoints /admin/*', () => {
  it('BUYER → GET /admin/products → 403', async () => {
    const service = productsMock();
    const res = await request(makeApp('/admin/products', createAdminProductsRouter, service, buyerUser))
      .get('/admin/products')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('BUYER → GET /admin/categories → 403', async () => {
    const service = categoriesMock();
    const res = await request(makeApp('/admin/categories', createAdminCategoriesRouter, service, buyerUser))
      .get('/admin/categories')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('BUYER → GET /admin/buyers → 403', async () => {
    const service = buyersMock();
    const res = await request(makeApp('/admin/buyers', createAdminBuyersRouter, service, buyerUser))
      .get('/admin/buyers')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('BUYER → GET /admin/couriers → 403', async () => {
    const service = couriersMock();
    const res = await request(makeApp('/admin/couriers', createAdminCouriersRouter, service, buyerUser))
      .get('/admin/couriers')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.list).not.toHaveBeenCalled();
  });
});

describe('G1 — RBAC: COURIER no puede acceder a endpoints /admin/*', () => {
  it('COURIER → GET /admin/products → 403', async () => {
    const service = productsMock();
    const res = await request(makeApp('/admin/products', createAdminProductsRouter, service, courierUser))
      .get('/admin/products')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('COURIER → GET /admin/categories → 403', async () => {
    const service = categoriesMock();
    const res = await request(makeApp('/admin/categories', createAdminCategoriesRouter, service, courierUser))
      .get('/admin/categories')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('COURIER → GET /admin/buyers → 403', async () => {
    const service = buyersMock();
    const res = await request(makeApp('/admin/buyers', createAdminBuyersRouter, service, courierUser))
      .get('/admin/buyers')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('COURIER → GET /admin/couriers → 403', async () => {
    const service = couriersMock();
    const res = await request(makeApp('/admin/couriers', createAdminCouriersRouter, service, courierUser))
      .get('/admin/couriers')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.list).not.toHaveBeenCalled();
  });
});

describe('G1 — RBAC: ADMIN_CLIENT no puede acceder a /ruta-admin/*', () => {
  it('ADMIN_CLIENT → GET /ruta-admin/clients → 403', async () => {
    const service = clientsMock();
    const res = await request(makeApp('/ruta-admin/clients', createRutaAdminClientsRouter, service, clientA_admin))
      .get('/ruta-admin/clients')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('ADMIN_CLIENT → POST /ruta-admin/clients → 403', async () => {
    const service = clientsMock();
    await request(makeApp('/ruta-admin/clients', createRutaAdminClientsRouter, service, clientA_admin))
      .post('/ruta-admin/clients')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ name: 'Hack', slug: 'hack', business_code: 'HC-001', client_type: 'FULL', frontend_mode: 'NATIVE_RUTA' })
      .expect(403);
    expect(service.create).not.toHaveBeenCalled();
  });
});

// ─── G2 — Cross-tenant: el service siempre recibe el client_id del TOKEN ──────

describe('G2 — Cross-tenant /admin/products: client_id del TOKEN, no del body/URL', () => {
  it('client A y client B reciben datos aislados (service llamado con su propio client_id)', async () => {
    const service = productsMock();

    await request(makeApp('/admin/products', createAdminProductsRouter, service, clientA_admin))
      .get('/admin/products')
      .expect(200);
    expect(service.list).toHaveBeenCalledWith(1, expect.anything());

    service.list.mockClear();

    await request(makeApp('/admin/products', createAdminProductsRouter, service, clientB_admin))
      .get('/admin/products')
      .expect(200);
    expect(service.list).toHaveBeenCalledWith(2, expect.anything());
  });

  it('client B no puede acceder al producto con ID de client A (service recibe clientId=2)', async () => {
    const service = productsMock();
    await request(makeApp('/admin/products', createAdminProductsRouter, service, clientB_admin))
      .get('/admin/products/1')
      .expect(200);
    expect(service.getById).toHaveBeenCalledWith(2, 1);
    expect(service.getById).not.toHaveBeenCalledWith(1, expect.anything());
  });

  it('client B no puede inyectar client_id=1 en el body de POST', async () => {
    const service = productsMock();
    await request(makeApp('/admin/products', createAdminProductsRouter, service, clientB_admin))
      .post('/admin/products')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ name: 'Producto', unit_price: 10000, product_type: 'VENTA_NORMAL', client_id: 1 })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(2, expect.not.objectContaining({ client_id: 1 }), expect.anything());
    expect(service.create).toHaveBeenCalledWith(2, expect.anything(), expect.anything());
  });

  it('PATCH de client B usa clientId=2, no clientId=1 aunque el product_id=1 sea de client A', async () => {
    const service = productsMock();
    await request(makeApp('/admin/products', createAdminProductsRouter, service, clientB_admin))
      .patch('/admin/products/1')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ name: 'Intento hack' })
      .expect(200);
    expect(service.update).toHaveBeenCalledWith(2, 1, expect.anything(), expect.anything());
    expect(service.update).not.toHaveBeenCalledWith(1, expect.anything(), expect.anything(), expect.anything());
  });
});

describe('G2 — Cross-tenant /admin/categories: client_id del TOKEN', () => {
  it('client A y client B reciben categorías aisladas', async () => {
    const service = categoriesMock();

    await request(makeApp('/admin/categories', createAdminCategoriesRouter, service, clientA_admin))
      .get('/admin/categories')
      .expect(200);
    expect(service.list).toHaveBeenCalledWith(1, expect.anything());

    service.list.mockClear();

    await request(makeApp('/admin/categories', createAdminCategoriesRouter, service, clientB_admin))
      .get('/admin/categories')
      .expect(200);
    expect(service.list).toHaveBeenCalledWith(2, expect.anything());
  });

  it('client B no puede ver una categoría de client A (service recibe clientId=2)', async () => {
    const service = categoriesMock();
    await request(makeApp('/admin/categories', createAdminCategoriesRouter, service, clientB_admin))
      .get('/admin/categories/1')
      .expect(200);
    expect(service.getById).toHaveBeenCalledWith(2, 1);
    expect(service.getById).not.toHaveBeenCalledWith(1, expect.anything());
  });

  it('client B no puede inyectar client_id=1 en POST de categoria', async () => {
    const service = categoriesMock();
    await request(makeApp('/admin/categories', createAdminCategoriesRouter, service, clientB_admin))
      .post('/admin/categories')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ name: 'Electrónicos', client_id: 1 })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(2, expect.not.objectContaining({ client_id: 1 }), expect.anything());
  });
});

describe('G2 — Cross-tenant /admin/buyers: client_id del TOKEN', () => {
  it('client A y client B ven sus propios compradores', async () => {
    const service = buyersMock();

    await request(makeApp('/admin/buyers', createAdminBuyersRouter, service, clientA_admin))
      .get('/admin/buyers')
      .expect(200);
    expect(service.list).toHaveBeenCalledWith(1, expect.anything());

    service.list.mockClear();

    await request(makeApp('/admin/buyers', createAdminBuyersRouter, service, clientB_admin))
      .get('/admin/buyers')
      .expect(200);
    expect(service.list).toHaveBeenCalledWith(2, expect.anything());
  });

  it('client B no puede acceder al buyer con ID de client A (service recibe clientId=2)', async () => {
    const service = buyersMock();
    await request(makeApp('/admin/buyers', createAdminBuyersRouter, service, clientB_admin))
      .get('/admin/buyers/1')
      .expect(200);
    expect(service.getById).toHaveBeenCalledWith(2, 1);
    expect(service.getById).not.toHaveBeenCalledWith(1, expect.anything());
  });

  it('client B no puede desactivar al buyer de client A (service recibe clientId=2)', async () => {
    const service = buyersMock();
    await request(makeApp('/admin/buyers', createAdminBuyersRouter, service, clientB_admin))
      .post('/admin/buyers/1/deactivate')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .expect(200);
    expect(service.deactivate).toHaveBeenCalledWith(2, 1, expect.anything());
    expect(service.deactivate).not.toHaveBeenCalledWith(1, expect.anything(), expect.anything());
  });
});

describe('G2 — Cross-tenant /admin/couriers: client_id del TOKEN', () => {
  it('client A y client B ven sus propios repartidores', async () => {
    const service = couriersMock();

    await request(makeApp('/admin/couriers', createAdminCouriersRouter, service, clientA_admin))
      .get('/admin/couriers')
      .expect(200);
    expect(service.list).toHaveBeenCalledWith(1, expect.anything());

    service.list.mockClear();

    await request(makeApp('/admin/couriers', createAdminCouriersRouter, service, clientB_admin))
      .get('/admin/couriers')
      .expect(200);
    expect(service.list).toHaveBeenCalledWith(2, expect.anything());
  });

  it('client B no puede ver al courier con ID de client A (service recibe clientId=2)', async () => {
    const service = couriersMock();
    await request(makeApp('/admin/couriers', createAdminCouriersRouter, service, clientB_admin))
      .get('/admin/couriers/1')
      .expect(200);
    expect(service.getById).toHaveBeenCalledWith(2, 1);
    expect(service.getById).not.toHaveBeenCalledWith(1, expect.anything());
  });

  it('client B no puede desactivar al courier de client A (service recibe clientId=2)', async () => {
    const service = couriersMock();
    await request(makeApp('/admin/couriers', createAdminCouriersRouter, service, clientB_admin))
      .post('/admin/couriers/1/deactivate')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .expect(200);
    expect(service.deactivate).toHaveBeenCalledWith(2, 1, expect.anything());
    expect(service.deactivate).not.toHaveBeenCalledWith(1, expect.anything(), expect.anything());
  });
});

// ─── G3 — ADMIN_RUTA sobre /admin/*: accede con client_id=0 ─────────────────
//
// HALLAZGO-QA-001: requireAdminClient permite ADMIN_RUTA (necesario para Vista
// de Control con token impersonado). Sin embargo, cuando ADMIN_RUTA está en modo
// plataforma (client_id=0), puede acceder a /admin/* y el service recibe
// clientId=0. Esto no es una fuga de datos de otro tenant (client_id=0 es la
// plataforma), pero sí es acceso directo a endpoints de tenant fuera de Vista
// de Control. La arquitectura indica que en modo plataforma ADMIN_RUTA debe
// operar bajo /ruta-admin/* y para operaciones sobre un tenant específico debe
// usar Vista de Control (JWT con client_id=X del tenant impersonado).
// Recomendación: agregar validación en requireAdminClient para rechazar
// client_id=0 salvo cuando impersonation=true en el JWT.

describe('G3 — ADMIN_RUTA en modo plataforma sobre /admin/* (HALLAZGO-QA-001)', () => {
  it('ADMIN_RUTA (client_id=0) pasa requireAdminClient y service recibe clientId=0, no datos de ningún tenant', async () => {
    const service = productsMock();
    await request(makeApp('/admin/products', createAdminProductsRouter, service, rutaAdmin))
      .get('/admin/products')
      .expect(200);
    // El service recibe client_id=0, nunca datos de tenants (client_id>0).
    // Esto es aislamiento correcto (no hay fuga), pero es acceso no intencionado
    // fuera de Vista de Control — ver HALLAZGO-QA-001 en el PR.
    expect(service.list).toHaveBeenCalledWith(0, expect.anything());
    expect(service.list).not.toHaveBeenCalledWith(1, expect.anything());
    expect(service.list).not.toHaveBeenCalledWith(2, expect.anything());
  });

  it('ADMIN_RUTA (client_id=0) no accede a productos de client_id=1 ni client_id=2', async () => {
    const service = productsMock();
    await request(makeApp('/admin/products', createAdminProductsRouter, service, rutaAdmin))
      .get('/admin/products/1')
      .expect(200);
    expect(service.getById).toHaveBeenCalledWith(0, 1);
    expect(service.getById).not.toHaveBeenCalledWith(1, expect.anything());
  });
});

// ─── G4 — /ruta-admin/clients: solo ADMIN_RUTA ───────────────────────────────

describe('G4 — /ruta-admin/clients: acceso exclusivo de ADMIN_RUTA', () => {
  it('ADMIN_RUTA puede listar clientes', async () => {
    const service = clientsMock();
    await request(makeApp('/ruta-admin/clients', createRutaAdminClientsRouter, service, rutaAdmin))
      .get('/ruta-admin/clients')
      .expect(200);
    expect(service.list).toHaveBeenCalled();
  });

  it('ADMIN_RUTA puede crear un cliente', async () => {
    const service = clientsMock();
    await request(makeApp('/ruta-admin/clients', createRutaAdminClientsRouter, service, rutaAdmin))
      .post('/ruta-admin/clients')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .send({ name: 'Nuevo', slug: 'nuevo', business_code: 'NV-001', client_type: 'FULL', frontend_mode: 'NATIVE_RUTA' })
      .expect(201);
    expect(service.create).toHaveBeenCalled();
  });

  it('ADMIN_RUTA puede leer, activar y desactivar un cliente', async () => {
    const service = clientsMock();
    const app = makeApp('/ruta-admin/clients', createRutaAdminClientsRouter, service, rutaAdmin);

    await request(app).get('/ruta-admin/clients/1').expect(200);
    expect(service.getById).toHaveBeenCalled();

    await request(app)
      .post('/ruta-admin/clients/1/activate')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .expect(200);
    expect(service.activate).toHaveBeenCalled();

    await request(app)
      .post('/ruta-admin/clients/1/deactivate')
      .set('X-Idempotency-Key', crypto.randomUUID())
      .expect(200);
    expect(service.deactivate).toHaveBeenCalled();
  });

  it('BUYER no puede listar clientes via /ruta-admin → 403', async () => {
    const service = clientsMock();
    const res = await request(makeApp('/ruta-admin/clients', createRutaAdminClientsRouter, service, buyerUser))
      .get('/ruta-admin/clients')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('COURIER no puede listar clientes via /ruta-admin → 403', async () => {
    const service = clientsMock();
    const res = await request(makeApp('/ruta-admin/clients', createRutaAdminClientsRouter, service, courierUser))
      .get('/ruta-admin/clients')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.list).not.toHaveBeenCalled();
  });
});
