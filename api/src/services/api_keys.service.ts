/**
 * api_keys.service.ts — F2.2.BACK-1
 *
 * Servicio de gestión de API keys para Cliente API.
 * ADMIN_CLIENT puede crear, listar y revocar API keys.
 * El secreto se retorna únicamente en la creación; nunca más.
 */

import crypto from 'node:crypto';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from '../lib/http_error.js';
import { logger } from '../lib/logger.js';
import type { CreateApiKeyInput } from '@orkoruta/shared';

const SALT = process.env.API_KEY_SECRET_SALT ?? 'ruta-dev-salt';

function hashSecret(secret: string): string {
  return crypto.createHmac('sha256', SALT).update(secret).digest('hex');
}

function generateKeyId(): string {
  return 'rk_' + crypto.randomBytes(16).toString('hex');
}

function generateSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

function computeKeyStatus(key: {
  revoked_at: Date | null;
  expires_at: Date | null;
}): 'ACTIVE' | 'REVOKED' | 'EXPIRED' {
  if (key.revoked_at !== null) return 'REVOKED';
  if (key.expires_at !== null && key.expires_at <= new Date()) return 'EXPIRED';
  return 'ACTIVE';
}

export interface GenerateApiKeyResult {
  key_id: string;
  secret: string;
  scopes: string[];
  expires_at: Date | null;
  created_at: Date;
}

export interface ApiKeyListItem {
  id: string;
  key_id: string;
  name: string | null;
  scopes: string[];
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  revocation_reason: string | null;
  created_at: Date;
}

/**
 * Crea una nueva API key para el cliente.
 * Retorna el secret en claro solo en esta llamada.
 */
export async function generateApiKey(
  clientId: bigint,
  input: CreateApiKeyInput,
  actorUserId: bigint,
): Promise<GenerateApiKeyResult> {
  const keyId = generateKeyId();
  const secret = generateSecret();
  const secretHash = hashSecret(secret);

  const expiresAt = input.expires_at ? new Date(input.expires_at) : null;

  const created = await withTenant(Number(clientId), 'ADMIN_CLIENT', (tx) =>
    tx.client_api_keys.create({
      data: {
        client_id: clientId,
        key_id: keyId,
        secret_hash: secretHash,
        name: input.name,
        scopes: input.scopes,
        expires_at: expiresAt,
        created_by_user_id: actorUserId,
      },
      select: {
        id: true,
        key_id: true,
        scopes: true,
        expires_at: true,
        created_at: true,
      },
    })
  );

  // Auditar creación
  setImmediate(() => {
    withTenant(Number(clientId), 'ADMIN_CLIENT', (tx) =>
      tx.audit_events.create({
        data: {
          client_id: clientId,
          actor_user_id: actorUserId,
          actor_type: 'ADMIN_CLIENT',
          action: 'API_KEY_CREATED',
          entity_type: 'client_api_keys',
          entity_id: created.id,
          result: 'SUCCESS',
        },
      })
    ).catch((err: unknown) => {
      logger.warn({ err, clientId }, 'api_keys.service: error auditando API_KEY_CREATED');
    });
  });

  logger.info({ clientId, keyId: created.key_id }, 'API key creada');

  return {
    key_id: created.key_id,
    secret,
    scopes: created.scopes,
    expires_at: created.expires_at,
    created_at: created.created_at,
  };
}

/**
 * Lista las API keys del cliente, sin incluir secret_hash.
 * Incluye status calculado.
 */
export async function listApiKeys(
  clientId: bigint,
): Promise<ApiKeyListItem[]> {
  const keys = await withTenantReadOnly(Number(clientId), 'ADMIN_CLIENT', (tx) =>
    tx.client_api_keys.findMany({
      where: { client_id: clientId },
      select: {
        id: true,
        key_id: true,
        name: true,
        scopes: true,
        last_used_at: true,
        expires_at: true,
        revoked_at: true,
        revocation_reason: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
    })
  );

  return keys.map((k) => ({
    id: String(k.id),
    key_id: k.key_id,
    name: k.name,
    scopes: k.scopes,
    status: computeKeyStatus(k),
    last_used_at: k.last_used_at,
    expires_at: k.expires_at,
    revoked_at: k.revoked_at,
    revocation_reason: k.revocation_reason,
    created_at: k.created_at,
  }));
}

/**
 * Revoca una API key del cliente.
 * Si ya está revocada → 409 IDEMPOTENCY_CONFLICT.
 */
export async function revokeApiKey(
  clientId: bigint,
  keyId: string,
  reason: string | undefined,
  actorUserId: bigint,
): Promise<void> {
  const existing = await withTenantReadOnly(Number(clientId), 'ADMIN_CLIENT', (tx) =>
    tx.client_api_keys.findFirst({
      where: { key_id: keyId, client_id: clientId },
      select: { id: true, revoked_at: true },
    })
  );

  if (!existing) {
    throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'API key no encontrada');
  }

  if (existing.revoked_at !== null) {
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'API key ya revocada');
  }

  await withTenant(Number(clientId), 'ADMIN_CLIENT', (tx) =>
    tx.client_api_keys.update({
      where: { id: existing.id },
      data: {
        revoked_at: new Date(),
        revocation_reason: reason ?? null,
      },
    })
  );

  // Auditar revocación
  setImmediate(() => {
    withTenant(Number(clientId), 'ADMIN_CLIENT', (tx) =>
      tx.audit_events.create({
        data: {
          client_id: clientId,
          actor_user_id: actorUserId,
          actor_type: 'ADMIN_CLIENT',
          action: 'API_KEY_REVOKED',
          entity_type: 'client_api_keys',
          entity_id: existing.id,
          result: 'SUCCESS',
          metadata: reason ? { reason } : undefined,
        },
      })
    ).catch((err: unknown) => {
      logger.warn({ err, clientId }, 'api_keys.service: error auditando API_KEY_REVOKED');
    });
  });

  logger.info({ clientId, keyId }, 'API key revocada');
}
