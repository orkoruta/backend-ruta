import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';

describe('GET /healthz', () => {
  it('debe retornar 200 con status ok', async () => {
    const res = await request(app)
      .get('/healthz')
      .expect('Content-Type', /json/)
      .expect(200);

    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('version');
  });

  it('debe incluir X-Request-Id header', async () => {
    const res = await request(app)
      .get('/healthz')
      .expect(200);

    expect(res.headers['x-request-id']).toBeDefined();
  });
});

describe('GET /nonexistent', () => {
  it('debe retornar 404 para rutas no encontradas', async () => {
    const res = await request(app)
      .get('/nonexistent')
      .expect(404);

    expect(res.body).toHaveProperty('code', 'RESOURCE_NOT_FOUND');
  });
});
