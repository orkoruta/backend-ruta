import express, { type Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { healthzRouter } from './routes/healthz.js';
import { openApiRouter } from './routes/openapi.js';
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
import { buyerProfileRouter } from './routes/buyer_profile.js';
import { adminPaymentConfigRouter } from './routes/admin_payment_config.js';
import { loggerMiddleware, logger } from './lib/logger.js';
import { authenticate } from './middleware/auth.js';
import { toApiError } from './lib/errors.js';
import { HttpError, sendHttpError } from './lib/http_error.js';
import { ZodError } from 'zod';
import { buyerOrdersRouter } from './routes/buyer_orders.js'; // 2.BACK-1
import { adminOrdersRouter } from './routes/admin_orders.js'; // 2.BACK-2
import { adminOrderAssignmentRouter } from './routes/admin_order_assignment.js'; // 3.BACK-1
import { courierOrdersRouter } from './routes/courier_orders.js'; // 3.BACK-2+3
import { courierCollectionRouter } from './routes/courier_collection.js'; // 3.BACK-3 COD
import { adminPickupPointsRouter } from './routes/admin_pickup_points.js'; // 4.FIX-1
import { createAdminPickupOpsRouter } from './routes/admin_pickup_ops.js'; // 4.BACK-1
import { createAdminParametersRouter } from './routes/admin_parameters.js'; // 5.BACK-34
import { createAdminAuditRouter, createRutaAdminAuditRouter } from './routes/admin_audit.js'; // 5.BACK-34
import { createAdminMetricsRouter } from './routes/admin_metrics.js'; // 5.BACK-2
import { createRutaAdminMetricsRouter } from './routes/ruta_admin_metrics.js'; // 5.BACK-2
import { createControlViewRouter } from './routes/ruta_admin_control_view.js'; // 5.BACK-1
import { createAdminWebhooksRouter } from './routes/admin_webhooks.js'; // 6.INFRA-3
import { adminRefundsRouter, adminOrderRefundRouter } from './routes/admin_refunds.js'; // F3.B1-BACK-1
import { adminReturnsRouter } from './routes/admin_returns.js'; // F3.B2-BACK-1
import { buyerReturnsRouter } from './routes/buyer_returns.js'; // F3.B2-BACK-1
import { adminDisputesRouter } from './routes/admin_disputes.js'; // F3.B3-BACK-1
import { buyerDisputesRouter } from './routes/buyer_disputes.js'; // F3.B3-BACK-1
import { buyerRecurrenceRouter, buyerOrderRecurrenceRouter } from './routes/buyer_recurrence.js'; // F3.B4-BACK-1
import { adminRecurrenceRouter } from './routes/admin_recurrence.js'; // F3.B4-BACK-1
import { adminCorporateOrdersRouter } from './routes/admin_corporate_orders.js'; // F3.B5-BACK-1
import { adminApiKeysRouter } from './routes/admin_api_keys.js'; // F2.BACK-1
import { apiClientOrdersRouter } from './routes/api_client_orders.js'; // F2.BACK-4
import { createGeocodingRouter } from './routes/geocoding.js';
import { adminNotificationsRouter } from './routes/admin_notifications.js';
import { courierLocationRouter, buyerTrackingRouter } from './routes/courier_location.js';
import { env } from './config/env.js';

const app: Express = express();

// CORS: origins configured via CORS_ORIGINS env var (comma-separated)
const corsOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));

// Webhooks: mount before express.json() to preserve raw body for HMAC verification // 2.BACK-3
app.use('/webhooks', express.raw({ type: 'application/json' }), webhooksRouter);

/*
 * El repartidor manda la foto del recibo embebida en el JSON (base64), hasta que
 * exista object storage. Ese cuerpo no cabe en el límite por defecto de 100 kB,
 * así que las rutas del repartidor se parsean antes y con un tope mayor; el
 * `express.json()` global de abajo las ve ya parseadas y no las vuelve a tocar.
 * El límite ampliado queda acotado a `/courier` a propósito: subirlo de forma
 * global abriría el resto de la API a cuerpos de 2 MB sin necesitarlo.
 */
app.use('/courier', express.json({ limit: '2mb' }));

// Global middleware
app.use(express.json());
app.use(cookieParser());
app.use(loggerMiddleware);

// Public routes (no auth required)
app.use('/healthz', healthzRouter);
app.use('/', openApiRouter);
app.use('/auth', authRouter);
app.use('/public/clients/:slug', publicCatalogRouter);

// F2.BACK-4 — Cliente API endpoints (API key auth, NOT JWT — must come BEFORE authenticate)
app.use('/api', apiClientOrdersRouter);

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
app.use('/buyer', buyerProfileRouter); // GET /buyer/me
app.use('/admin/pickup-points', adminPickupPointsRouter); // 4.FIX-1
app.use('/admin', createAdminPickupOpsRouter()); // 4.BACK-1
// Debe ir antes de adminOrdersRouter: su ruta literal /orders/map
// quedaría capturada por el /:id genérico de 2.BACK-2.
app.use('/admin', adminOrderAssignmentRouter); // 3.BACK-1
app.use('/admin/orders', adminOrdersRouter); // 2.BACK-2
// El seguimiento va ANTES que los otros routers de /courier, y no después:
// ambos aplican `requireIdempotencyKey` con `router.use(...)`, que corre para
// cualquier `/courier/*` aunque ninguna de sus rutas coincida. Montado detrás,
// `POST /courier/location` moría con 400 por no llevar cabecera de
// idempotencia — que a propósito no lleva, por ser un latido que sobrescribe.
// Este router usa guardas por ruta, así que no intercepta a los de abajo.
app.use('/courier', courierLocationRouter); // seguimiento: el repartidor reporta
app.use('/courier', courierOrdersRouter); // 3.BACK-2+3
app.use('/courier', courierCollectionRouter); // 3.BACK-3 COD collection
app.use('/buyer/orders', buyerTrackingRouter); // seguimiento: el comprador consulta
app.use('/admin/payment-providers', adminPaymentConfigRouter);
app.use('/admin/notifications', adminNotificationsRouter);
app.use('/admin/parameters', createAdminParametersRouter()); // 5.BACK-34
app.use('/admin/audit-events', createAdminAuditRouter()); // 5.BACK-34
app.use('/ruta-admin/audit-events', createRutaAdminAuditRouter()); // 5.BACK-34
app.use('/admin/metrics', createAdminMetricsRouter()); // 5.BACK-2
app.use('/ruta-admin/metrics', createRutaAdminMetricsRouter()); // 5.BACK-2
app.use('/ruta-admin/control-view', createControlViewRouter()); // 5.BACK-1
app.use('/admin', createAdminWebhooksRouter()); // 6.INFRA-3
app.use('/admin/refunds', adminRefundsRouter); // F3.B1-BACK-1
app.use('/admin/orders', adminOrderRefundRouter); // F3.B1-BACK-1 (POST /:id/initiate-refund)
app.use('/admin/returns', adminReturnsRouter); // F3.B2-BACK-1
app.use('/buyer/orders', buyerReturnsRouter); // F3.B2-BACK-1 (POST /:id/request-return, GET /:id/return)
app.use('/admin/disputes', adminDisputesRouter); // F3.B3-BACK-1
app.use('/buyer/orders', buyerDisputesRouter); // F3.B3-BACK-1 (POST /:id/dispute, GET /:id/dispute)
app.use('/buyer/recurrence', buyerRecurrenceRouter); // F3.B4-BACK-1
app.use('/buyer/orders', buyerOrderRecurrenceRouter); // F3.B4-BACK-1 (POST /:id/mark-recurring)
app.use('/admin/recurrence', adminRecurrenceRouter); // F3.B4-BACK-1
app.use('/admin/orders', adminCorporateOrdersRouter); // F3.B5-BACK-1
app.use('/admin/api-keys', adminApiKeysRouter); // F2.BACK-1
app.use('/geocode', createGeocodingRouter());

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

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Error interno del servidor' });
});

export { app };
