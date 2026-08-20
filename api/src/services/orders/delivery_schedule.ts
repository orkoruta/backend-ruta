/**
 * Fecha de entrega programada: conversión entre la columna `DATE` de la BD y el
 * `YYYY-MM-DD` que viaja por la API.
 *
 * `orders.scheduled_delivery_date` es un `DATE` (día calendario del negocio), no
 * un instante. Prisma lo entrega como un `Date` de JavaScript posicionado en la
 * medianoche **UTC** de ese día, así que hay que recortarlo en UTC y nunca con
 * los getters locales: en Colombia (UTC-5) `getDate()` devolvería el día
 * anterior.
 */

/** Día calendario en formato ISO corto. Se valida con `DATE_ONLY_PATTERN`. */
export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `DATE` de la BD → `YYYY-MM-DD` para la API. */
export function toDateOnly(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` de la API → `Date` en medianoche UTC, que es como Postgres
 * guarda un `DATE` y como Prisma espera recibirlo.
 */
export function fromDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00.000Z`);
}
