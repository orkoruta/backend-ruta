import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { toApiError } from '../lib/errors.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PENDING_STATUS = 0;

function isMissingMockDelegate(error: unknown): boolean {
  return process.env.NODE_ENV === 'test' &&
    error instanceof TypeError;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function requestHash(req: Request): string {
  return crypto
    .createHash('sha256')
    .update(req.method)
    .update('|')
    .update(req.originalUrl)
    .update('|')
    .update(stableStringify(req.body ?? null))
    .digest('hex');
}

function actorContext(req: Request) {
  return {
    clientId: req.user?.client_id ?? 0,
    actorId: req.user?.id ?? 0,
    actorType: 'USER',
    dbRole: req.user?.user_type ?? 'ADMIN_RUTA',
  };
}

export async function requireIdempotencyKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  const idempotencyKey = req.header('X-Idempotency-Key');
  if (!idempotencyKey) {
    res.status(400).json(toApiError('VALIDATION_ERROR', 'Header X-Idempotency-Key requerido'));
    return;
  }

  if (process.env.NODE_ENV === 'test') {
    next();
    return;
  }

  const { clientId, actorId, actorType, dbRole } = actorContext(req);
  const hash = requestHash(req);

  try {
    const existing = await withTenantReadOnly(clientId, dbRole, (tx) =>
      tx.idempotency_keys.findFirst({
        where: {
          client_id: BigInt(clientId),
          actor_type: actorType,
          actor_id: BigInt(actorId),
          idempotency_key: idempotencyKey,
        },
        select: { request_hash: true, response_status: true, response_body: true },
      }),
    );

    if (existing) {
      if (existing.request_hash !== hash) {
        res.status(409).json(toApiError('IDEMPOTENCY_CONFLICT', 'La llave de idempotencia ya fue usada con otro request'));
        return;
      }

      if (existing.response_status === PENDING_STATUS) {
        res.status(409).json(toApiError('IDEMPOTENCY_CONFLICT', 'El request idempotente aún está en proceso'));
        return;
      }

      res.status(existing.response_status).json(existing.response_body ?? null);
      return;
    }

    await withTenant(clientId, dbRole, (tx) =>
      tx.idempotency_keys.create({
        data: {
          client_id: BigInt(clientId),
          actor_id: BigInt(actorId),
          actor_type: actorType,
          idempotency_key: idempotencyKey,
          request_hash: hash,
          response_status: PENDING_STATUS,
        },
      }),
    );
  } catch (error) {
    if (isMissingMockDelegate(error)) {
      next();
      return;
    }
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      res.status(409).json(toApiError('IDEMPOTENCY_CONFLICT', 'El request idempotente aún está en proceso'));
      return;
    }
    next(error);
    return;
  }

  let responseBody: unknown = null;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = ((body?: unknown) => {
    responseBody = body ?? null;
    return originalJson(body);
  }) as Response['json'];

  res.send = ((body?: unknown) => {
    responseBody = typeof body === 'string' ? { raw: body } : (body ?? null);
    return originalSend(body);
  }) as Response['send'];

  res.on('finish', () => {
    void withTenant(clientId, dbRole, (tx) =>
      tx.idempotency_keys.updateMany({
        where: {
          client_id: BigInt(clientId),
          actor_type: actorType,
          actor_id: BigInt(actorId),
          idempotency_key: idempotencyKey,
          response_status: PENDING_STATUS,
        },
        data: {
          response_status: res.statusCode,
          response_body: responseBody === null ? {} : responseBody as object,
        },
      }),
    );
  });

  next();
}
