import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { healthzRouter } from './routes/healthz.js';
import { rutaAdminClientsRouter } from './routes/ruta_admin_clients.js';
import { authRouter } from './routes/auth.js';
import { adminCategoriesRouter } from './routes/admin_categories.js';
import { adminProductsRouter } from './routes/admin_products.js';
import { adminProductsBulkRouter } from './routes/admin_products_bulk.js'; // 1.BACK-5
import { adminBuyersRouter } from './routes/admin_buyers.js';
import { adminCouriersRouter } from './routes/admin_couriers.js';
import { publicCatalogRouter } from './routes/public_catalog.js';
import { uploadsRouter } from './routes/uploads.js';
import { webhooksRouter } from './routes/webhooks.js'; // 2.BACK-3
import { buyerPaymentRouter } from './routes/buyer_payment.js'; // 2.BACK-3
import { loggerMiddleware } from './middleware/logger.js';
import { authenticate } from './middleware/auth.js';
import { toApiError } from './lib/errors.js';
import { HttpError, sendHttpError } from './lib/http_error.js';
import { ZodError } from 'zod';
import { buyerOrdersRouter } from './routes/buyer_orders.js'; // 2.BACK-1

const app: Express = express();

// Webhooks: mount before express.json() to preserve raw body for HMAC verification // 2.BACK-3
app.use('/webhooks', express.raw({ type: 'application/json' }), webhooksRouter);

// Global middleware
app.use(express.json());
app.use(cookieParser());
app.use(loggerMiddleware);

// Public routes (no auth required)
app.use('/healthz', healthzRouter);
app.use('/auth', authRouter);
app.use('/public/clients/:slug', publicCatalogRouter);

// Apply authentication to all routes below
app.use(authenticate);

// Protected routes
app.use('/ruta-admin/clients', rutaAdminClientsRouter);
app.use('/admin/categories', adminCategoriesRouter);
app.use('/admin/products/bulk-import', adminProductsBulkRouter); // 1.BACK-5
app.use('/admin/products', adminProductsRouter);
app.use('/admin/buyers', adminBuyersRouter);
app.use('/admin/couriers', adminCouriersRouter);
app.use('/uploads', uploadsRouter);
app.use('/buyer/orders', buyerOrdersRouter); // 2.BACK-1
app.use('/buyer', buyerPaymentRouter); // 2.BACK-3

// 404 handler
app.use((_req, res) => {
  res.status(404).json(toApiError('RESOURCE_NOT_FOUND', 'Endpoint no encontrado'));
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      ...toApiError('VALIDATION_ERROR', 'Datos inválidos'),
      details: err.flatten(),
    });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.statusCode).json(sendHttpError(err));
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json(toApiError('TENANT_ISOLATION_VIOLATION', 'Error interno del servidor'));
});

export { app };
