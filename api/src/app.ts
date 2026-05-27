import express, { type Express } from 'express';
import { healthzRouter } from './routes/healthz.js';
import { loggerMiddleware } from './middleware/logger.js';
import { toApiError } from './lib/errors.js';

const app: Express = express();

// Global middleware
app.use(express.json());
app.use(loggerMiddleware);

// Routes
app.use('/healthz', healthzRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json(toApiError('RESOURCE_NOT_FOUND', 'Endpoint no encontrado'));
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno del servidor'));
});

export { app };
