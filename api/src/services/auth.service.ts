import crypto from 'node:crypto';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from '../lib/http_error.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signAccessToken } from '../lib/token.js';
import { getParameterInt } from '../lib/parameter.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  /** `null` cuando el token no expira (p.ej. repartidor). */
  expiresInSeconds: number | null;
  user: {
    id: number;
    client_id: number;
    user_type: string;
    email: string;
  };
}

function generateRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(48).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

function jwtLifetimeKeyForRole(userType: string): string {
  switch (userType) {
    case 'ADMIN_RUTA': return 'auth.jwt_lifetime_admin_ruta_minutes';
    case 'ADMIN_CLIENT': return 'auth.jwt_lifetime_admin_client_minutes';
    case 'OPERATOR_CLIENT': return 'auth.jwt_lifetime_operator_client_minutes';
    case 'BUYER': return 'auth.jwt_lifetime_buyer_minutes';
    case 'COURIER': return 'auth.jwt_lifetime_courier_minutes';
    default: return 'auth.jwt_lifetime_admin_client_minutes';
  }
}

function refreshTokenLifetimeDaysKeyForRole(userType: string): string {
  switch (userType) {
    case 'BUYER': return 'auth.refresh_token_lifetime_buyer_days';
    case 'COURIER': return 'auth.refresh_token_lifetime_courier_days';
    default: return 'auth.refresh_token_lifetime_admin_days';
  }
}

function defaultRefreshDaysForRole(userType: string): number {
  switch (userType) {
    case 'BUYER': return 90;
    case 'COURIER': return 30;
    default: return 30;
  }
}

function defaultJwtMinutesForRole(userType: string): number {
  // El repartidor no expira (0); el resto, 30 min. Este default solo aplica si
  // no hay valor en client_parameters (`auth.jwt_lifetime_<rol>_minutes`), que
  // gana sobre esto.
  return userType === 'COURIER' ? 0 : 30;
}

async function buildLoginResult(
  userId: bigint,
  clientId: bigint,
  userType: string,
  email: string,
  ctx: RequestContext
): Promise<LoginResult> {
  const cid = Number(clientId);
  const uid = Number(userId);

  const jwtMinutes = await getParameterInt(cid, jwtLifetimeKeyForRole(userType), defaultJwtMinutesForRole(userType));
  const refreshDays = await getParameterInt(cid, refreshTokenLifetimeDaysKeyForRole(userType), defaultRefreshDaysForRole(userType));

  const expiresAt = new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000);
  const { raw, hash } = generateRefreshToken();

  const session = await withTenant(0, 'ADMIN_RUTA', (tx) =>
    tx.sessions.create({
      data: {
        client_id: clientId,
        user_id: userId,
        refresh_token_hash: hash,
        ip_address: ctx.ip,
        user_agent: ctx.userAgent,
        expires_at: expiresAt,
      },
    })
  );

  const accessToken = await signAccessToken(
    { sub: String(uid), client_id: cid, user_type: userType, session_id: Number(session.id) },
    jwtMinutes
  );

  return {
    accessToken,
    refreshToken: raw,
    // `null` = el token no expira (jwtMinutes <= 0, p.ej. repartidor).
    expiresInSeconds: jwtMinutes > 0 ? jwtMinutes * 60 : null,
    user: { id: uid, client_id: cid, user_type: userType, email },
  };
}

export const authService = {
  async register(
    input: {
      email: string;
      password: string;
      full_name?: string;
      phone?: string;
      document_type?: string;
      document_number?: string;
      client_slug: string;
    },
    ctx: RequestContext
  ): Promise<LoginResult> {
    const client = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
      tx.clients.findUnique({ where: { slug: input.client_slug }, select: { id: true, status: true } })
    );

    if (!client || client.status !== 'ACTIVE') {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Cliente no encontrado');
    }

    const clientId = Number(client.id);
    const passwordHash = await hashPassword(input.password);

    const user = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.users.findUnique({
        where: {
          client_id_email: { client_id: client.id, email: input.email },
        },
      });

      if (existing) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Email ya registrado');
      }

      return tx.users.create({
        data: {
          client_id: client.id,
          user_type: 'BUYER',
          email: input.email,
          password_hash: passwordHash,
          full_name: input.full_name,
          phone: input.phone,
          document_type: input.document_type,
          document_number: input.document_number,
          status: 'ACTIVE',
        },
      });
    }).catch((err: unknown) => {
      if (typeof err === 'object' && err && 'code' in err && err.code === 'P2002') {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Email ya registrado');
      }
      throw err;
    });

    return buildLoginResult(user.id, user.client_id, 'BUYER', user.email, ctx);
  },

  /**
   * Inicia una sesión de invitado: crea un comprador sin contraseña
   * (`auth_mode = 'EXTERNAL_REFERENCE'`) y emite las cookies normales, de modo
   * que todo el flujo de compra funciona igual que con una cuenta. El invitado
   * se distingue por su `external_buyer_id` con prefijo `guest-`; el frontend
   * usa eso (vía `/buyer/me`) para ocultarle "Mis pedidos" y la recurrencia.
   */
  async startGuest(
    input: { client_slug: string; full_name?: string; phone?: string },
    ctx: RequestContext,
  ): Promise<LoginResult> {
    const client = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
      tx.clients.findUnique({
        where: { slug: input.client_slug },
        select: { id: true, status: true, client_type: true },
      }),
    );

    if (!client || client.status !== 'ACTIVE') {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Cliente no encontrado');
    }
    // El pedido como invitado es de storefront: solo aplica a Cliente Full.
    if (client.client_type !== 'FULL') {
      throw new HttpError(422, 'LOGISTICS_ONLY_FEATURE_UNAVAILABLE', 'Este cliente no acepta pedidos como invitado');
    }

    const token = globalThis.crypto.randomUUID();
    const guestRef = `guest-${token}`;

    const user = await withTenant(Number(client.id), 'ADMIN_CLIENT', (tx) =>
      tx.users.create({
        data: {
          client_id: client.id,
          user_type: 'BUYER',
          // Email sintético único; el invitado nunca inicia sesión con él.
          email: `${guestRef}@guest.ruta`,
          auth_mode: 'EXTERNAL_REFERENCE',
          external_buyer_id: guestRef,
          full_name: input.full_name?.trim() || 'Invitado',
          phone: input.phone?.trim() || null,
          status: 'ACTIVE',
        },
      }),
    );

    return buildLoginResult(user.id, user.client_id, 'BUYER', user.email, ctx);
  },

  async login(
    input: { email: string; password: string; client_slug: string },
    ctx: RequestContext
  ): Promise<LoginResult> {
    const client = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
      tx.clients.findUnique({ where: { slug: input.client_slug }, select: { id: true, status: true } })
    );

    if (!client || client.status !== 'ACTIVE') {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Credenciales inválidas');
    }

    const clientId = Number(client.id);

    const user = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
      tx.users.findUnique({
        where: {
          client_id_email: { client_id: client.id, email: input.email },
        },
      })
    );

    if (!user || !user.password_hash || user.status !== 'ACTIVE') {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Credenciales inválidas');
    }

    const valid = await verifyPassword(user.password_hash, input.password);
    if (!valid) {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Credenciales inválidas');
    }

    await withTenant(clientId, 'BUYER', (tx) =>
      tx.users.update({
        where: { id_client_id: { id: user.id, client_id: user.client_id } },
        data: { last_login_at: new Date() },
      })
    );

    return buildLoginResult(user.id, user.client_id, user.user_type, user.email, ctx);
  },

  async loginRutaAdmin(
    input: { email: string; password: string },
    ctx: RequestContext
  ): Promise<LoginResult> {
    const user = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
      tx.users.findUnique({
        where: {
          client_id_email: { client_id: BigInt(0), email: input.email },
        },
      })
    );

    if (!user || !user.password_hash || user.status !== 'ACTIVE') {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Credenciales inválidas');
    }

    if (user.user_type !== 'ADMIN_RUTA') {
      throw new HttpError(403, 'FORBIDDEN', 'Requiere rol ADMIN_RUTA');
    }

    const valid = await verifyPassword(user.password_hash, input.password);
    if (!valid) {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Credenciales inválidas');
    }

    await withTenant(0, 'ADMIN_RUTA', (tx) =>
      tx.users.update({
        where: { id_client_id: { id: user.id, client_id: user.client_id } },
        data: { last_login_at: new Date() },
      })
    );

    return buildLoginResult(user.id, user.client_id, 'ADMIN_RUTA', user.email, ctx);
  },

  async refresh(input: { refreshToken: string }, ctx: RequestContext): Promise<LoginResult> {
    const hash = crypto.createHash('sha256').update(input.refreshToken).digest('hex');

    const session = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
      tx.sessions.findFirst({
        where: { refresh_token_hash: hash, revoked_at: null },
      })
    );

    if (!session || session.expires_at < new Date()) {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Sesión inválida o expirada');
    }

    const user = await withTenantReadOnly(Number(session.client_id), 'ADMIN_RUTA', (tx) =>
      tx.users.findUnique({
        where: {
          id_client_id: { id: session.user_id, client_id: session.client_id },
        },
      })
    );

    if (!user || user.status !== 'ACTIVE') {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Usuario inactivo');
    }

    await withTenant(0, 'ADMIN_RUTA', (tx) =>
      tx.sessions.update({
        where: { id: session.id },
        data: {
          revoked_at: new Date(),
          revocation_reason: 'ROTATED',
        },
      })
    );

    return buildLoginResult(user.id, user.client_id, user.user_type, user.email, {
      ip: ctx.ip ?? session.ip_address ?? undefined,
      userAgent: ctx.userAgent ?? session.user_agent ?? undefined,
    });
  },

  async logout(
    authUser: AuthenticatedUser,
    input: { allSessions: boolean; sessionId?: number }
  ): Promise<void> {
    if (input.allSessions) {
      await withTenant(0, 'ADMIN_RUTA', (tx) =>
        tx.sessions.updateMany({
          where: {
            user_id: BigInt(authUser.id),
            client_id: BigInt(authUser.client_id),
            revoked_at: null,
          },
          data: { revoked_at: new Date(), revocation_reason: 'LOGOUT_ALL' },
        })
      );
    } else if (input.sessionId) {
      await withTenant(0, 'ADMIN_RUTA', (tx) =>
        tx.sessions.updateMany({
          where: {
            id: BigInt(input.sessionId!),
            user_id: BigInt(authUser.id),
            client_id: BigInt(authUser.client_id),
            revoked_at: null,
          },
          data: { revoked_at: new Date(), revocation_reason: 'LOGOUT' },
        })
      );
    }
  },
};
