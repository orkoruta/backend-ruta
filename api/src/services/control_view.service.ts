import crypto from 'node:crypto';
import argon2 from 'argon2';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from '../lib/http_error.js';
import { signAccessToken } from '../lib/token.js';
import { getParameterInt } from '../lib/parameter.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

interface EnterControlViewInput {
  targetClientId: number;
  masterPassword: string;
  reason?: string;
}

interface EnterControlViewResult {
  accessToken: string;
  refreshToken: string;
  targetClient: {
    id: number;
    name: string;
    slug: string;
  };
}

function generateRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(48).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export const controlViewService = {
  async enterControlView(
    adminRutaUser: AuthenticatedUser,
    input: EnterControlViewInput,
    ctx: RequestContext
  ): Promise<EnterControlViewResult> {
    const { targetClientId, masterPassword, reason } = input;

    // 1. Verify target client exists and is ACTIVE
    const targetClient = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
      tx.clients.findUnique({
        where: { id: BigInt(targetClientId) },
        select: { id: true, name: true, slug: true, status: true },
      })
    );

    if (!targetClient) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Cliente no encontrado');
    }

    if (targetClient.status !== 'ACTIVE') {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Cliente no encontrado o no está activo');
    }

    // 2. Verify master password from control_view_master_passwords for this user
    const masterPwdRecord = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
      tx.control_view_master_passwords.findUnique({
        where: {
          user_id_client_id: {
            user_id: BigInt(adminRutaUser.id),
            client_id: BigInt(0),
          },
        },
        select: {
          master_password_hash: true,
          can_use_control_view: true,
          expires_at: true,
        },
      })
    );

    if (!masterPwdRecord || !masterPwdRecord.can_use_control_view) {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'No tiene permiso para usar Vista de Control');
    }

    if (masterPwdRecord.expires_at && masterPwdRecord.expires_at < new Date()) {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Contraseña maestra expirada');
    }

    const passwordValid = await argon2.verify(masterPwdRecord.master_password_hash, masterPassword);
    if (!passwordValid) {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Contraseña maestra inválida');
    }

    // 3. Create control_view_session record and a new session for the impersonated client
    const jwtMinutes = await getParameterInt(0, 'auth.jwt_lifetime_admin_ruta_minutes', 5);
    const refreshDays = await getParameterInt(0, 'auth.refresh_token_lifetime_admin_days', 30);
    const expiresAt = new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000);
    const { raw, hash } = generateRefreshToken();

    const { session } = await withTenant(0, 'ADMIN_RUTA', async (tx) => {
      // Create control_view_session
      const cvSession = await tx.control_view_sessions.create({
        data: {
          admin_ruta_user_id: BigInt(adminRutaUser.id),
          impersonated_client_id: BigInt(targetClientId),
          reason: reason ?? null,
          ip_address: ctx.ip ?? null,
          user_agent: ctx.userAgent ?? null,
        },
      });

      // Create session for the impersonated client
      const session = await tx.sessions.create({
        data: {
          client_id: BigInt(targetClientId),
          user_id: BigInt(adminRutaUser.id),
          refresh_token_hash: hash,
          control_view_session_id: cvSession.id,
          ip_address: ctx.ip ?? null,
          user_agent: ctx.userAgent ?? null,
          expires_at: expiresAt,
        },
      });

      // Audit CONTROL_VIEW_ENTERED in the platform tenant (client_id=0)
      await tx.audit_events.create({
        data: {
          client_id: BigInt(0),
          actor_user_id: BigInt(adminRutaUser.id),
          actor_type: 'USER',
          actor_role: 'ADMIN_RUTA',
          acting_via_control_view: true,
          impersonator_user_id: BigInt(adminRutaUser.id),
          control_view_session_id: cvSession.id,
          action: 'CONTROL_VIEW_ENTERED',
          entity_type: 'client',
          entity_id: BigInt(targetClientId),
          ip_address: ctx.ip ?? null,
          user_agent: ctx.userAgent ?? null,
          metadata: { target_client_id: targetClientId, reason: reason ?? null },
          result: 'SUCCESS',
        },
      });

      return { session };
    });

    // 4. Sign JWT with impersonation claims
    const accessToken = await signAccessToken(
      {
        sub: String(adminRutaUser.id),
        client_id: targetClientId,
        user_type: 'ADMIN_RUTA',
        session_id: Number(session.id),
        impersonating: true,
        target_client_id: targetClientId,
      },
      jwtMinutes
    );

    return {
      accessToken,
      refreshToken: raw,
      targetClient: {
        id: Number(targetClient.id),
        name: targetClient.name,
        slug: targetClient.slug,
      },
    };
  },

  async exitControlView(
    authUser: AuthenticatedUser,
    ctx: RequestContext
  ): Promise<void> {
    const sessionId = authUser.session_id;

    // Revoke the control view session
    await withTenant(0, 'ADMIN_RUTA', async (tx) => {
      // Find and revoke the session
      const session = await tx.sessions.findUnique({
        where: { id: BigInt(sessionId) },
        select: { id: true, control_view_session_id: true, client_id: true },
      });

      if (session) {
        await tx.sessions.update({
          where: { id: BigInt(sessionId) },
          data: {
            revoked_at: new Date(),
            revocation_reason: 'CONTROL_VIEW_EXIT',
          },
        });

        // Close the control_view_session record if exists
        if (session.control_view_session_id) {
          await tx.control_view_sessions.update({
            where: { id: session.control_view_session_id },
            data: { ended_at: new Date() },
          });
        }
      }

      // Audit CONTROL_VIEW_EXITED
      await tx.audit_events.create({
        data: {
          client_id: BigInt(0),
          actor_user_id: BigInt(authUser.id),
          actor_type: 'USER',
          actor_role: 'ADMIN_RUTA',
          acting_via_control_view: true,
          impersonator_user_id: BigInt(authUser.id),
          control_view_session_id: session?.control_view_session_id ?? null,
          action: 'CONTROL_VIEW_EXITED',
          entity_type: 'session',
          entity_id: BigInt(sessionId),
          ip_address: ctx.ip ?? null,
          user_agent: ctx.userAgent ?? null,
          result: 'SUCCESS',
        },
      });
    });

  },
};
