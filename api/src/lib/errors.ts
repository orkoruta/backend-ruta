import { ERROR_CODES, type ApiError, type ErrorCode } from '@orkoruta/shared';

/**
 * Códigos de error del backend.
 *
 * La lista **no se copia**: se importa de `@orkoruta/shared`, que es la fuente
 * de verdad compartida con el frontend. Antes había aquí una copia escrita a
 * mano, y añadir un código en `shared` rompía la compilación de este archivo
 * hasta que alguien se acordaba de duplicarlo. `DATABASE_UNAVAILABLE` es el
 * único propio: no viaja al cliente como código de negocio.
 */
type BackendErrorCode = ErrorCode | 'DATABASE_UNAVAILABLE';

const BACKEND_ERROR_CODES = {
  ...ERROR_CODES,
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
} as const;

export function toApiError(code: BackendErrorCode, message: string): ApiError {
  return {
    code: BACKEND_ERROR_CODES[code],
    message,
  };
}
