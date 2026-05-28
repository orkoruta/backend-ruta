import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { createAdminProductsBulkRouter } from '../routes/admin_products_bulk.js';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

const adminClient: AuthenticatedUser = { id: 5, client_id: 1, user_type: 'ADMIN_CLIENT', session_id: 10 };
const buyer: AuthenticatedUser = { id: 10, client_id: 1, user_type: 'BUYER', session_id: 11 };

function bulkServiceMock() {
  return {
    startImport: vi.fn().mockResolvedValue({ job_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'pending' as const }),
    getJobStatus: vi.fn().mockResolvedValue({
      job_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      status: 'completed' as const,
      result: { created: 3, failed: 0, errors: [] },
    }),
  };
}

function testBulkApp(
  service: ReturnType<typeof bulkServiceMock>,
  user?: AuthenticatedUser,
) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = user;
      next();
    });
  }
  app.use('/admin/products/bulk-import', createAdminProductsBulkRouter(service));
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

const IDEMPOTENCY_KEY = 'test-key-1234';
const JOB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('POST /admin/products/bulk-import', () => {
  it('rechaza sin autenticación', async () => {
    const service = bulkServiceMock();
    const res = await request(testBulkApp(service))
      .post('/admin/products/bulk-import')
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .expect(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.startImport).not.toHaveBeenCalled();
  });

  it('rechaza usuario que no es ADMIN_CLIENT', async () => {
    const service = bulkServiceMock();
    const res = await request(testBulkApp(service, buyer))
      .post('/admin/products/bulk-import')
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(service.startImport).not.toHaveBeenCalled();
  });

  it('rechaza sin X-Idempotency-Key', async () => {
    const service = bulkServiceMock();
    const res = await request(testBulkApp(service, adminClient))
      .post('/admin/products/bulk-import')
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(service.startImport).not.toHaveBeenCalled();
  });

  it('rechaza petición sin archivo', async () => {
    const service = bulkServiceMock();
    const res = await request(testBulkApp(service, adminClient))
      .post('/admin/products/bulk-import')
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(service.startImport).not.toHaveBeenCalled();
  });

  it('rechaza archivo con extensión incorrecta', async () => {
    const service = bulkServiceMock();
    const res = await request(testBulkApp(service, adminClient))
      .post('/admin/products/bulk-import')
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .attach('file', Buffer.from('contenido'), { filename: 'productos.csv', contentType: 'text/csv' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(service.startImport).not.toHaveBeenCalled();
  });

  it('acepta archivo .xlsx y retorna job_id con status 202', async () => {
    const service = bulkServiceMock();
    const res = await request(testBulkApp(service, adminClient))
      .post('/admin/products/bulk-import')
      .set('X-Idempotency-Key', IDEMPOTENCY_KEY)
      .attach('file', Buffer.from('fake xlsx content'), { filename: 'productos.xlsx', contentType: XLSX_MIME })
      .expect(202);

    expect(res.body.job_id).toBe(JOB_ID);
    expect(res.body.status).toBe('pending');
    expect(typeof res.body.message).toBe('string');
    expect(service.startImport).toHaveBeenCalledWith(
      adminClient.client_id,
      expect.any(Buffer),
      adminClient,
    );
  });
});

describe('GET /admin/products/bulk-import/:job_id', () => {
  it('rechaza sin autenticación', async () => {
    const service = bulkServiceMock();
    const res = await request(testBulkApp(service))
      .get(`/admin/products/bulk-import/${JOB_ID}`)
      .expect(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.getJobStatus).not.toHaveBeenCalled();
  });

  it('rechaza usuario que no es ADMIN_CLIENT', async () => {
    const service = bulkServiceMock();
    const res = await request(testBulkApp(service, buyer))
      .get(`/admin/products/bulk-import/${JOB_ID}`)
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('retorna 400 si job_id no es UUID', async () => {
    const service = bulkServiceMock();
    const res = await request(testBulkApp(service, adminClient))
      .get('/admin/products/bulk-import/no-es-uuid')
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(service.getJobStatus).not.toHaveBeenCalled();
  });

  it('retorna 404 si el job no existe (service lanza HttpError)', async () => {
    const service = bulkServiceMock();
    service.getJobStatus.mockRejectedValueOnce(
      new HttpError(404, 'RESOURCE_NOT_FOUND', 'Trabajo de importación no encontrado'),
    );
    const res = await request(testBulkApp(service, adminClient))
      .get(`/admin/products/bulk-import/${JOB_ID}`)
      .expect(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('retorna el estado del job con status 200', async () => {
    const service = bulkServiceMock();
    const res = await request(testBulkApp(service, adminClient))
      .get(`/admin/products/bulk-import/${JOB_ID}`)
      .expect(200);

    expect(res.body.job_id).toBe(JOB_ID);
    expect(res.body.status).toBe('completed');
    expect(res.body.result.created).toBe(3);
    expect(service.getJobStatus).toHaveBeenCalledWith(adminClient.client_id, JOB_ID);
  });
});
