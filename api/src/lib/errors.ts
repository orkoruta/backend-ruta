import { ERROR_CODES, type ApiError, type ErrorCode } from '@orkoruta/shared';

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
