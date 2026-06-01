import { Router, type Router as ExpressRouter } from 'express';

const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'RUTA API',
    version: '1.0.0',
  },
  servers: [{ url: '/' }],
  paths: {
    '/healthz': { get: { summary: 'Health check', responses: { '200': { description: 'OK' } } } },
    '/auth/register': { post: { summary: 'Registrar comprador', responses: { '201': { description: 'Creado' } } } },
    '/auth/login': { post: { summary: 'Login tenant', responses: { '200': { description: 'OK' } } } },
    '/auth/ruta-admin/login': { post: { summary: 'Login ADMIN_RUTA', responses: { '200': { description: 'OK' } } } },
    '/auth/refresh': { post: { summary: 'Renovar sesión', responses: { '200': { description: 'OK' } } } },
    '/auth/logout': { post: { summary: 'Cerrar sesión', responses: { '204': { description: 'No Content' } } } },
    '/public/clients/{slug}': { get: { summary: 'Información pública del cliente', responses: { '200': { description: 'OK' } } } },
    '/buyer/orders': { get: { summary: 'Pedidos del comprador', responses: { '200': { description: 'OK' } } }, post: { summary: 'Crear pedido', responses: { '201': { description: 'Creado' } } } },
    '/admin/orders': { get: { summary: 'Pedidos admin', responses: { '200': { description: 'OK' } } } },
    '/admin/metrics': { get: { summary: 'Métricas tenant', responses: { '200': { description: 'OK' } } } },
    '/ruta-admin/metrics': { get: { summary: 'Métricas globales', responses: { '200': { description: 'OK' } } } },
  },
};

export const openApiRouter: ExpressRouter = Router();

openApiRouter.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument);
});

openApiRouter.get('/docs', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>RUTA API Docs</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <h1>RUTA API</h1>
    <p>La especificación OpenAPI está disponible en <a href="/openapi.json">/openapi.json</a>.</p>
  </body>
</html>`);
});
