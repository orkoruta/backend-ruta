/**
 * api_key_auth.ts — F2.2.BACK-2
 *
 * Middleware de autenticación por API key para Cliente API.
 * Formato: Authorization: Bearer <key_id>.<secret>
 * El separador es el primer '.' para tolerar key_ids con prefijo como 'rk_...'.
 */

import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { HttpError, sendHttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const SALT = process.env.API_KEY_SECRET_SALT ?? 'ruta-dev-salt';

function hashSecret(secret: string): string {
  return crypto.createHmac('sha256', SALT).update(secret).digest('hex');
}

export type ApiKeyScope = 'orders:write' | 'orders:read';

/**
 * Factory que devuelve un middleware que autentica por API key
 * y verifica que la key tenga el scope requerido.
 */
export function apiKeyAuth(requiredScope: ApiKeyScope) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    // Sin header → 401
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
      return;
    }

    const token = authHeader.slice(7);

    // Parsear: separar por el primer '.'
    const dotIndex = token.indexOf('.');
    if (dotIndex === -1) {
      res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Formato de API key inválido'));
      return;
    }

    const keyId = token.slice(0, dotIndex);
    const secret = token.slice(dotIndex + 1);

    if (!keyId || !secret) {
      res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Formato de API key inválido'));
      return;
    }

    // Buscar key en BD (sin tenant context ya que key_id es unique global)
    let apiKey: {
      id: bigint;
      client_id: bigint;
      secret_hash: string;
      scopes: string[];
      revoked_at: Date | null;
      expires_at: Date | null;
      last_used_at: Date | null;
    } | null;

    try {
      apiKey = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
        tx.client_api_keys.findUnique({
          where: { key_id: keyId },
          select: {
            id: true,
            client_id: true,
            secret_hash: true,
            scopes: true,
            revoked_at: true,
            expires_at: true,
            last_used_at: true,
          },
        })
      );
    } catch (err) {
      logger.error({ err }, 'api_key_auth: error buscando API key en BD');
      res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Error interno de autenticación'));
      return;
    }

    // Key no encontrada — mismo mensaje que secret incorrecto (no revelar si key_id existe)
    if (!apiKey) {
      res.status(401).json(sendHttpError(new HttpError(401, 'API_KEY_INVALID', 'API key inválida')));
      return;
    }

    // Verificar secret HMAC — timing-safe comparison
    const expectedHash = hashSecret(secret);
    const expectedBuf = Buffer.from(expectedHash, 'hex');
    const actualBuf = Buffer.from(apiKey.secret_hash, 'hex');
    const secretValid =
      expectedBuf.length === actualBuf.length &&
      crypto.timingSafeEqual(expectedBuf, actualBuf);

    if (!secretValid) {
      res.status(401).json(sendHttpError(new HttpError(401, 'API_KEY_INVALID', 'API key inválida')));
      return;
    }

    // Verificar si está revocada
    if (apiKey.revoked_at !== null) {
      res.status(401).json(sendHttpError(new HttpError(401, 'API_KEY_REVOKED', 'API key revocada')));
      return;
    }

    // Verificar expiración
    if (apiKey.expires_at !== null && apiKey.expires_at <= new Date()) {
      res.status(401).json(sendHttpError(new HttpError(401, 'API_KEY_EXPIRED', 'API key expirada')));
      return;
    }

    // Verificar scope requerido
    if (!apiKey.scopes.includes(requiredScope)) {
      res.status(403).json(sendHttpError(new HttpError(403, 'SCOPE_NOT_ALLOWED', `Scope requerido: ${requiredScope}`)));
      return;
    }

    // Poblar req.user
    req.user = {
      id: 0, // API clients no tienen user_id; usar 0 como sentinel
      client_id: Number(apiKey.client_id),
      user_type: 'API_CLIENT',
      session_id: 0,
      userType: 'API_CLIENT',
      apiKeyId: apiKey.id,
      scopes: apiKey.scopes,
    };

    // Fire-and-forget: actualizar last_used_at y last_used_ip
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      ?? req.socket.remoteAddress
      ?? null;
    const keyId_ = apiKey.id;
    const clientId_ = apiKey.client_id;

    setImmediate(() => {
      withTenant(Number(clientId_), 'ADMIN_CLIENT', (tx) =>
        tx.client_api_keys.update({
          where: { id: keyId_ },
          data: {
            last_used_at: new Date(),
            ...(ip ? { last_used_ip: ip } : {}),
          },
        })
      ).catch((err: unknown) => {
        logger.warn({ err, keyId_ }, 'api_key_auth: no se pudo actualizar last_used_at');
      });
    });

    next();
  };
}
