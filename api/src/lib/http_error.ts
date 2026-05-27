import { toApiError } from './errors.js';
import type { ErrorCode } from '@orkoruta/shared';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function sendHttpError(error: HttpError) {
  return {
    ...toApiError(error.code, error.message),
    ...(error.details ? { details: error.details } : {}),
  };
}
