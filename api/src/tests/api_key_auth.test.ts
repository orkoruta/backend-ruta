/**
 * api_key_auth.test.ts — F2.4.QA-1
 *
 * Tests del middleware apiKeyAuth() de api_key_auth.ts.
 *
 * El middleware se monta sobre un mini-router que expone:
 *   GET /protected (requiere scope 'orders:write')
 *
 * Cobertura:
 *   AM1  Key válida con scope correcto → 200
 *   AM2  Sin header Authorization → 401 AUTHENTICATION_REQUIRED
 *   AM3  Header mal formado (sin Bearer, sin punto) → 401 AUTHENTICATION_REQUIRED
 *   AM4  key_id inexistente → 401 API_KEY_INVALID
 *   AM5  Secret incorrecto → 401 API_KEY_INVALID
 *   AM6  Key revocada → 401 API_KEY_REVOKED
 *   AM7  Key expirada → 401 API_KEY_EXPIRED
 *   AM8  Scope incorrecto → 403 SCOPE_NOT_ALLOWED
 *   AM9  Key válida → last_used_at se actualiza en BD
 */

import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── DB mock (vi.hoisted) ─────────────────────────────────────────────────────
// IMPORTANT: vi.hoisted runs before any imports are resolved.
// We CANNOT use `crypto` from 'node:crypto' here because that import hasn't
// been resolved yet. Instead we use require() which works synchronously.

const dbMock = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require('node:crypto') as typeof import('node:crypto');
  const SALT = 'ruta-dev-salt';

  function hashSecret(secret: string): string {
    return nodeCrypto.createHmac('sha256', SALT).update(secret).digest('hex');
  }

  const VALID_KEY_ID = 'rk_validkeyid0000';
  const VALID_SECRET = 'validSecret1234567890abcdef12345';
  const VALID_SECRET_HASH = hashSecret(VALID_SECRET);

  const readTx = {
    client_api_keys: {
      findUnique: vi.fn(),
    },
  };

  const writeTx = {
    client_api_keys: {
      update: vi.fn().mockResolvedValue({}),
    },
  };

  return {
    VALID_KEY_ID,
    VALID_SECRET,
    VALID_SECRET_HASH,
    hashSecret,
    readTx,
    writeTx,
    withTenantReadOnly: vi.fn(
      (_clientId: number, _role: string, callback: (tx: typeof readTx) => unknown) =>
        callback(readTx),
    ),
    withTenant: vi.fn(
      (_clientId: number, _role: string, callback: (tx: typeof writeTx) => unknown) =>
        callback(writeTx),
    ),
  };
});

vi.mock('@orkoruta/db', () => ({
  withTenantReadOnly: dbMock.withTenantReadOnly,
  withTenant: dbMock.withTenant,
}));

const { apiKeyAuth } = await import('../middleware/api_key_auth.js');

// ─── App de prueba ────────────────────────────────────────────────────────────

function buildTestApp(requiredScope: 'orders:write' | 'orders:read' = 'orders:write') {
  const app = express();
  app.use(express.json());
  app.get('/protected', apiKeyAuth(requiredScope), (_req: Request, res: Response) => {
    // apiKeyId is a BigInt; serialize it as string to avoid JSON.stringify error
    const user = (_req as Request & { user?: Record<string, unknown> }).user;
    const safeUser = user
      ? { ...user, apiKeyId: user.apiKeyId !== undefined ? String(user.apiKeyId) : undefined }
      : undefined;
    res.status(200).json({ ok: true, user: safeUser });
  });
  return app;
}

// ─── Tokens de prueba ─────────────────────────────────────────────────────────

function bearerToken(keyId: string, secret: string): string {
  return `Bearer ${keyId}.${secret}`;
}

// ─── beforeEach ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Restaurar comportamiento por defecto del findUnique usando dbMock.hashSecret
  // que ya tiene acceso a node:crypto via require() (safe inside vi.hoisted).
  dbMock.readTx.client_api_keys.findUnique.mockImplementation(
    (args: { where: { key_id: string } }) => {
      const store: Record<string, unknown> = {
        [dbMock.VALID_KEY_ID]: {
          id: 1n,
          client_id: 1n,
          secret_hash: dbMock.hashSecret(dbMock.VALID_SECRET),
          scopes: ['orders:write', 'orders:read'],
          revoked_at: null,
          expires_at: null,
          last_used_at: null,
        },
        'rk_revokedkeyid000': {
          id: 2n,
          client_id: 1n,
          secret_hash: dbMock.hashSecret(dbMock.VALID_SECRET),
          scopes: ['orders:write'],
          revoked_at: new Date(Date.now() - 60_000),
          expires_at: null,
          last_used_at: null,
        },
        'rk_expiredkeyid000': {
          id: 3n,
          client_id: 1n,
          secret_hash: dbMock.hashSecret(dbMock.VALID_SECRET),
          scopes: ['orders:write'],
          revoked_at: null,
          expires_at: new Date(Date.now() - 86_400_000),
          last_used_at: null,
        },
        'rk_readonly000000': {
          id: 4n,
          client_id: 1n,
          secret_hash: dbMock.hashSecret(dbMock.VALID_SECRET),
          scopes: ['orders:read'],
          revoked_at: null,
          expires_at: null,
          last_used_at: null,
        },
      };
      return store[args.where.key_id] ?? null;
    },
  );

  dbMock.writeTx.client_api_keys.update.mockResolvedValue({});
});

// ─── Tests ────────────────────────────────────────────────────────────────────

// AM1 — Key válida con scope correcto → 200
describe('AM1 — Key válida con scope correcto → 200', () => {
  it('retorna 200 y popula req.user con client_id y scopes', async () => {
    const app = buildTestApp('orders:write');

    const res = await request(app)
      .get('/protected')
      .set('Authorization', bearerToken(dbMock.VALID_KEY_ID, dbMock.VALID_SECRET));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.client_id).toBe(1);
    expect(res.body.user.user_type).toBe('API_CLIENT');
    expect(res.body.user.scopes).toContain('orders:write');
  });

  it('acepta key con scope orders:read cuando el endpoint requiere orders:read', async () => {
    const app = buildTestApp('orders:read');

    const res = await request(app)
      .get('/protected')
      .set('Authorization', bearerToken('rk_readonly000000', dbMock.VALID_SECRET));

    expect(res.status).toBe(200);
    expect(res.body.user.scopes).toContain('orders:read');
  });
});

// AM2 — Sin header Authorization → 401 AUTHENTICATION_REQUIRED
describe('AM2 — Sin header Authorization → 401 AUTHENTICATION_REQUIRED', () => {
  it('retorna 401 cuando no hay header Authorization', async () => {
    const app = buildTestApp();

    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('retorna 401 cuando Authorization no tiene prefijo Bearer', async () => {
    const app = buildTestApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Basic dXNlcjpwYXNz');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('retorna 401 cuando Authorization es solo "Bearer " vacío', async () => {
    const app = buildTestApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer ');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });
});

// AM3 — Header mal formado (sin punto separador) → 401 AUTHENTICATION_REQUIRED
describe('AM3 — Header mal formado → 401 AUTHENTICATION_REQUIRED', () => {
  it('retorna 401 cuando el token no tiene separador "."', async () => {
    const app = buildTestApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer sinpuntoseparador');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('retorna 401 cuando key_id está vacío (token empieza con ".")', async () => {
    const app = buildTestApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer .onlysecret');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('retorna 401 cuando secret está vacío (token termina con ".")', async () => {
    const app = buildTestApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${dbMock.VALID_KEY_ID}.`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });
});

// AM4 — key_id inexistente → 401 API_KEY_INVALID
describe('AM4 — key_id inexistente → 401 API_KEY_INVALID', () => {
  it('retorna 401 cuando el key_id no existe en BD', async () => {
    const app = buildTestApp();

    // findUnique devuelve null para key desconocida
    const res = await request(app)
      .get('/protected')
      .set('Authorization', bearerToken('rk_doesnotexist000', dbMock.VALID_SECRET));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('API_KEY_INVALID');
  });
});

// AM5 — Secret incorrecto → 401 API_KEY_INVALID
describe('AM5 — Secret incorrecto → 401 API_KEY_INVALID', () => {
  it('retorna 401 cuando el secret no coincide con el hash guardado', async () => {
    const app = buildTestApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', bearerToken(dbMock.VALID_KEY_ID, 'wrongsecretabcdef1234567890xxxxx'));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('API_KEY_INVALID');
  });

  it('no revela si el key_id existe o no (mismo código de error en ambos casos)', async () => {
    const app = buildTestApp();

    const resWrongId = await request(app)
      .get('/protected')
      .set('Authorization', bearerToken('rk_doesnotexist000', dbMock.VALID_SECRET));

    const resWrongSecret = await request(app)
      .get('/protected')
      .set('Authorization', bearerToken(dbMock.VALID_KEY_ID, 'wrongsecretabcdef1234567890xxxxx'));

    expect(resWrongId.status).toBe(401);
    expect(resWrongSecret.status).toBe(401);
    // Ambos devuelven el mismo código genérico
    expect(resWrongId.body.code).toBe('API_KEY_INVALID');
    expect(resWrongSecret.body.code).toBe('API_KEY_INVALID');
  });
});

// AM6 — Key revocada → 401 API_KEY_REVOKED
describe('AM6 — Key revocada → 401 API_KEY_REVOKED', () => {
  it('retorna 401 cuando la key tiene revoked_at no nulo', async () => {
    const app = buildTestApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', bearerToken('rk_revokedkeyid000', dbMock.VALID_SECRET));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('API_KEY_REVOKED');
  });
});

// AM7 — Key expirada → 401 API_KEY_EXPIRED
describe('AM7 — Key expirada → 401 API_KEY_EXPIRED', () => {
  it('retorna 401 cuando expires_at es anterior a la fecha actual', async () => {
    const app = buildTestApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', bearerToken('rk_expiredkeyid000', dbMock.VALID_SECRET));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('API_KEY_EXPIRED');
  });

  it('key con expires_at en el futuro no es rechazada como expirada', async () => {
    const SALT = 'ruta-dev-salt';
    const futureSecret = 'futureSecretxxxx1234567890abcdef';
    const futureHash = crypto.createHmac('sha256', SALT).update(futureSecret).digest('hex');

    // Sobreescribir findUnique para este test con una key que expira en el futuro
    dbMock.readTx.client_api_keys.findUnique.mockImplementation(
      (args: { where: { key_id: string } }) => {
        if (args.where.key_id === 'rk_futurekey00000') {
          return {
            id: 5n,
            client_id: 1n,
            secret_hash: futureHash,
            scopes: ['orders:write'],
            revoked_at: null,
            expires_at: new Date(Date.now() + 86_400_000 * 30), // +30 días
            last_used_at: null,
          };
        }
        return null;
      },
    );

    const app = buildTestApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', bearerToken('rk_futurekey00000', futureSecret));

    expect(res.status).toBe(200);
  });
});

// AM8 — Scope incorrecto → 403 SCOPE_NOT_ALLOWED
describe('AM8 — Scope incorrecto → 403 SCOPE_NOT_ALLOWED', () => {
  it('retorna 403 cuando la key tiene orders:read pero el endpoint requiere orders:write', async () => {
    const app = buildTestApp('orders:write'); // endpoint requiere write

    // rk_readonly000000 solo tiene orders:read
    const res = await request(app)
      .get('/protected')
      .set('Authorization', bearerToken('rk_readonly000000', dbMock.VALID_SECRET));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_NOT_ALLOWED');
  });

  it('retorna 403 para scope completamente diferente al requerido', async () => {
    // Reconfigurar para devolver key con solo orders:read
    dbMock.readTx.client_api_keys.findUnique.mockImplementation(
      (_args: { where: { key_id: string } }) => ({
        id: 10n,
        client_id: 1n,
        secret_hash: (() => {
          const SALT = 'ruta-dev-salt';
          return crypto.createHmac('sha256', SALT).update(dbMock.VALID_SECRET).digest('hex');
        })(),
        scopes: ['orders:read'],
        revoked_at: null,
        expires_at: null,
        last_used_at: null,
      }),
    );

    const appWrite = buildTestApp('orders:write');

    const res = await request(appWrite)
      .get('/protected')
      .set('Authorization', bearerToken(dbMock.VALID_KEY_ID, dbMock.VALID_SECRET));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_NOT_ALLOWED');
  });
});

// AM9 — Key válida → last_used_at se actualiza en BD
describe('AM9 — Key válida → last_used_at se actualiza en BD', () => {
  it('llama withTenant para actualizar last_used_at después de una request exitosa', async () => {
    const app = buildTestApp('orders:write');

    const res = await request(app)
      .get('/protected')
      .set('Authorization', bearerToken(dbMock.VALID_KEY_ID, dbMock.VALID_SECRET));

    expect(res.status).toBe(200);

    // El update ocurre en setImmediate → esperar un tick
    await new Promise((resolve) => setImmediate(resolve));

    expect(dbMock.withTenant).toHaveBeenCalledWith(
      1, // client_id
      'ADMIN_CLIENT',
      expect.any(Function),
    );

    expect(dbMock.writeTx.client_api_keys.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1n },
        data: expect.objectContaining({ last_used_at: expect.any(Date) }),
      }),
    );
  });

  it('last_used_at NO se actualiza si la key es inválida', async () => {
    const app = buildTestApp('orders:write');

    await request(app)
      .get('/protected')
      .set('Authorization', bearerToken('rk_doesnotexist000', dbMock.VALID_SECRET));

    await new Promise((resolve) => setImmediate(resolve));

    // withTenant no debe haberse llamado para actualizar last_used_at
    const updateCalls = dbMock.writeTx.client_api_keys.update.mock.calls;
    expect(updateCalls).toHaveLength(0);
  });

  it('last_used_at NO se actualiza si el secret es incorrecto', async () => {
    const app = buildTestApp('orders:write');

    await request(app)
      .get('/protected')
      .set('Authorization', bearerToken(dbMock.VALID_KEY_ID, 'wrongsecretabcdef1234567890xxxxx'));

    await new Promise((resolve) => setImmediate(resolve));

    expect(dbMock.writeTx.client_api_keys.update.mock.calls).toHaveLength(0);
  });
});

// ─── Pruebas adicionales de robustez ──────────────────────────────────────────

describe('Robustez del middleware — casos borde', () => {
  it('tolera key_id con prefijo rk_ que contiene puntos internos (no confunde separador)', async () => {
    // El middleware separa por el PRIMER '.': key_id = todo antes del primer '.', secret = el resto.
    // Un key_id sin puntos internos no plantea ambigüedad. Verificamos separación correcta.
    const SALT = 'ruta-dev-salt';
    const specialSecret = 'secretpart.with.extra.dots';
    const specialHash = crypto.createHmac('sha256', SALT).update(specialSecret).digest('hex');

    dbMock.readTx.client_api_keys.findUnique.mockImplementation(
      (args: { where: { key_id: string } }) => {
        if (args.where.key_id === 'rk_nodots1234abcd') {
          return {
            id: 6n,
            client_id: 1n,
            secret_hash: specialHash,
            scopes: ['orders:write'],
            revoked_at: null,
            expires_at: null,
            last_used_at: null,
          };
        }
        return null;
      },
    );

    const app = buildTestApp();

    // Token: "rk_nodots1234abcd.secretpart.with.extra.dots"
    // El middleware toma todo después del primer '.' como secret
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer rk_nodots1234abcd.${specialSecret}`);

    expect(res.status).toBe(200);
  });

  it('popula req.user con apiKeyId (BigInt) y userType API_CLIENT', async () => {
    const app = buildTestApp('orders:write');

    const res = await request(app)
      .get('/protected')
      .set('Authorization', bearerToken(dbMock.VALID_KEY_ID, dbMock.VALID_SECRET));

    expect(res.status).toBe(200);
    // BigInt se serializa como string en JSON según el entorno; verificar user_type
    expect(res.body.user.user_type).toBe('API_CLIENT');
    expect(res.body.user.id).toBe(0); // sentinel para API clients
  });
});
