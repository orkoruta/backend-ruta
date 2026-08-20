import { z } from 'zod';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { OrderStatus } from '@orkoruta/shared';
import { HttpError } from '../../lib/http_error.js';
import { resolveParamInt } from '../../lib/parameter_resolver.js';

/**
 * Seguimiento del repartidor en el mapa.
 *
 * El repartidor reporta su posición mientras lleva pedidos; el comprador la
 * consulta para ver por dónde va la suya. Se guarda **solo la última posición**
 * en `courier_profiles` — el historial serían miles de filas por persona y día
 * y no aporta a la pregunta que hace el comprador, que es "dónde está ahora".
 *
 * Tres reglas de privacidad, porque esto es la ubicación de una persona:
 *
 * 1. El comprador solo ve al repartidor **de su propio pedido**, nunca a la flota.
 * 2. Solo mientras el pedido va en camino. Entregado o cancelado, deja de verse:
 *    el repartidor sigue su jornada y eso ya no le incumbe al comprador.
 * 3. Una posición vieja **no se hace pasar por actual**. Pasado el TTL se
 *    informa como caducada, con su hora, y que el frontend decida cómo decirlo.
 */

/**
 * Estados en los que el pedido va de camino y tiene sentido seguirlo.
 * Arranca en SHIPPED, que es a lo que lleva "Iniciar despacho".
 * `COURIER_ASSIGNED` queda fuera a propósito: el repartidor lo tiene asignado
 * pero aún no ha salido, y mostrar su posición ahí sería vigilarlo en la base.
 */
export const TRACKABLE_STATUSES: string[] = [
  OrderStatus.SHIPPED,
  OrderStatus.IN_TRANSIT,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.ARRIVED_AT_CUSTOMER,
];

/**
 * Cuántos segundos se considera vigente una posición. Configurable por Cliente
 * porque depende de la operación (moto en ciudad ≠ furgón interurbano) y la
 * regla del proyecto es no fijar plazos en el código.
 */
const LOCATION_TTL_PARAM = 'tracking.courier_location_ttl_seconds';
const DEFAULT_LOCATION_TTL_SECONDS = 300;

export const courierLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Precisión en metros que reporta el GPS. Se guarda no; sirve para descartar. */
  accuracy: z.number().nonnegative().optional(),
});

export type CourierLocationInput = z.infer<typeof courierLocationSchema>;

/**
 * Lecturas peores que esto se descartan: un GPS que dice "estás en algún punto
 * de este kilómetro" pintaría al repartidor saltando por el mapa.
 */
const MAX_ACCEPTABLE_ACCURACY_METERS = 1000;

export const courierLocationService = {
  /** El repartidor reporta dónde está. */
  async reportLocation(clientId: number, courierUserId: number, input: CourierLocationInput) {
    if (input.accuracy !== undefined && input.accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
      // No es un error del cliente: el GPS aún no fija bien. Se ignora en
      // silencio para no llenar de ruido ni el mapa ni los logs.
      return { accepted: false as const, reason: 'LOW_ACCURACY' as const };
    }

    const now = new Date();
    await withTenant(clientId, 'COURIER', (tx) =>
      tx.courier_profiles.update({
        where: { user_id_client_id: { user_id: BigInt(courierUserId), client_id: BigInt(clientId) } },
        data: {
          last_latitude: input.latitude,
          last_longitude: input.longitude,
          last_location_at: now,
          updated_at: now,
        },
      }),
    );

    return { accepted: true as const, recorded_at: now.toISOString() };
  },

  /**
   * Posición del repartidor de un pedido, para el comprador.
   *
   * Devuelve `null` cuando no hay nada que mostrar (pedido fuera de reparto, sin
   * repartidor, o sin ninguna posición reportada). El llamador lo traduce a 404:
   * así el comprador no puede distinguir "no hay posición" de "no es tu pedido",
   * que sería una forma de sondear pedidos ajenos.
   */
  async getLocationForBuyer(clientId: number, orderId: number, buyerUserId: number) {
    const order = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      tx.orders.findUnique({
        where: { id_client_id: { id: BigInt(orderId), client_id: BigInt(clientId) } },
        select: {
          buyer_id: true,
          order_status: true,
          courier_user_id: true,
          delivery_address_latitude: true,
          delivery_address_longitude: true,
          users_orders_courier_user_id_client_idTousers: {
            select: {
              full_name: true,
              courier_profiles: {
                select: { last_latitude: true, last_longitude: true, last_location_at: true },
              },
            },
          },
        },
      }),
    );

    if (!order) return null;
    // El pedido tiene que ser suyo. Sin esto, cualquier comprador del mismo
    // Cliente podría seguir al repartidor de un pedido ajeno probando ids.
    if (Number(order.buyer_id) !== buyerUserId) return null;
    if (!TRACKABLE_STATUSES.includes(order.order_status)) return null;
    if (!order.courier_user_id) return null;

    const courier = order.users_orders_courier_user_id_client_idTousers;
    const profile = courier?.courier_profiles;
    if (!profile?.last_latitude || !profile.last_longitude || !profile.last_location_at) {
      return null;
    }

    const ttlSeconds = await resolveParamInt(
      clientId,
      LOCATION_TTL_PARAM,
      DEFAULT_LOCATION_TTL_SECONDS,
    );
    const ageSeconds = Math.floor((Date.now() - profile.last_location_at.getTime()) / 1000);

    return {
      latitude: Number(profile.last_latitude),
      longitude: Number(profile.last_longitude),
      updated_at: profile.last_location_at.toISOString(),
      age_seconds: ageSeconds,
      /** `true` = la posición ya no es de fiar; el frontend debe decirlo. */
      is_stale: ageSeconds > ttlSeconds,
      courier_name: courier?.full_name ?? null,
      /** Destino, para encuadrar el mapa sin una segunda llamada. */
      destination:
        order.delivery_address_latitude && order.delivery_address_longitude
          ? {
              latitude: Number(order.delivery_address_latitude),
              longitude: Number(order.delivery_address_longitude),
            }
          : null,
    };
  },
};

/** 404 uniforme: no distingue "no hay posición" de "no es tu pedido". */
export function notTrackable(): HttpError {
  return new HttpError(404, 'RESOURCE_NOT_FOUND', 'No hay seguimiento disponible para este pedido');
}
