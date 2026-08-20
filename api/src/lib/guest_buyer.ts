/**
 * Compradores invitados (pedido sin cuenta).
 *
 * `POST /auth/guest` crea un comprador real en `users` pero sin contraseña, con
 * `auth_mode = 'EXTERNAL_REFERENCE'` y un `external_buyer_id` con prefijo
 * `guest-`. Ese prefijo es la **única** marca que los distingue, así que la
 * comprobación vive aquí y no repetida en cada ruta: si algún día cambia la
 * convención, cambia en un solo sitio.
 *
 * Importa para el panel del Cliente: el correo de un invitado es **sintético**
 * (`guest-<uuid>@guest.ruta`) y no lleva a ninguna bandeja. Su teléfono, que se
 * pide como obligatorio en el checkout, es el único canal real para contactarlo.
 */

const GUEST_PREFIX = 'guest-';

export function isGuestBuyer(externalBuyerId: string | null | undefined): boolean {
  return Boolean(externalBuyerId?.startsWith(GUEST_PREFIX));
}
