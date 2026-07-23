/**
 * Traducción del submétodo de pago entre el vocabulario de la aplicación y el de
 * la BD.
 *
 * `@orkoruta/shared` y el frontend usan `'QR'`, pero la CHECK constraint de la
 * tabla `orders` (`orders_payment_method_submethod_check`) solo admite
 * `'QR_OR_PAYMENT_LINK'`. Sin traducir, la validación Zod pasa pero el INSERT/
 * UPDATE revienta con un 23514 (violación de constraint). Se traduce aquí, en la
 * frontera de la BD, en vez de cambiar la constraint (BD compartida) o el enum
 * publicado de `shared`. Los demás valores (`DATAFONO`, `BANK_TRANSFER`,
 * `PAYMENT_LINK`) coinciden en ambos lados y pasan sin cambios.
 */

const APP_TO_DB: Record<string, string> = {
  QR: 'QR_OR_PAYMENT_LINK',
};

const DB_TO_APP: Record<string, string> = {
  QR_OR_PAYMENT_LINK: 'QR',
};

/** Valor de la app → valor que acepta la BD. Úsese antes de escribir en `orders`. */
export function toDbSubmethod(value: string | null | undefined): string | null {
  if (!value) return null;
  return APP_TO_DB[value] ?? value;
}

/** Valor de la BD → valor de la app. Úsese al serializar para el frontend. */
export function fromDbSubmethod(value: string | null | undefined): string | null {
  if (!value) return null;
  return DB_TO_APP[value] ?? value;
}
