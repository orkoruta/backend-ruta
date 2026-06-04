/**
 * assert_client_is_full.ts — F2.3.BACK-5
 *
 * Helper para verificar que el cliente autenticado es de tipo FULL.
 * Si es de tipo API, lanza 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE.
 *
 * Endpoints bloqueados para Cliente API (se llama a esta función en su handler):
 *
 *  Flujo 1 — Creación de pedidos (storefront del comprador):
 *    - POST /buyer/orders                          (buyer_orders.ts — crear pedido DRAFT)
 *
 *  Pagos en línea (Wompi):
 *    - POST /buyer/orders/:id/initiate-payment     (buyer_payment.ts — iniciar pago Wompi)
 *
 *  Los endpoints de /admin/orders (accept, reject, mark-preparing, mark-ready) ya tienen
 *  su propio assertFullClient local en admin_orders.ts (implementado en el servicio adminOrdersService).
 *
 *  Los endpoints de refunds, recurrencia y corporativos ya tienen assertFullClient en sus
 *  servicios respectivos (refunds.service.ts, recurrence.service.ts, corporate_orders.service.ts).
 */

import { withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from './http_error.js';

/**
 * Verifica que el cliente (tenant) es de tipo FULL.
 * Si es de tipo API, lanza HTTP 422 LOGISTICS_ONLY_FEATURE_UNAVAILABLE.
 *
 * @param clientId  ID numérico del tenant
 * @throws {HttpError} 422 si el cliente es de tipo API
 */
export async function assertClientIsFull(clientId: number | null): Promise<void> {
  // null = ADMIN_RUTA sin tenant asignado; no aplica el bloqueo
  if (clientId === null) return;

  // Usa clientId=0 (plataforma) para consultar la tabla clients sin restricción de partición
  const client = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findUnique({
      where: { id: BigInt(clientId) },
      select: { client_type: true },
    }),
  );

  if (client?.client_type === 'API') {
    throw new HttpError(
      422,
      'LOGISTICS_ONLY_FEATURE_UNAVAILABLE',
      'Esta función no está disponible para clientes de tipo API.',
    );
  }
}
