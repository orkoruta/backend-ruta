import type { NextFunction, Request, Response } from 'express';
import { toApiError } from '../lib/errors.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  const idempotencyKey = req.header('X-Idempotency-Key');
  if (!idempotencyKey) {
    res.status(400).json(toApiError('VALIDATION_ERROR', 'Header X-Idempotency-Key requerido'));
    return;
  }

  next();
}
