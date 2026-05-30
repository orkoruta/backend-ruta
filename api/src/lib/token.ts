import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env.js';

export interface TokenPayload {
  sub: string;
  client_id: number;
  user_type: string;
  session_id: number;
  impersonating?: boolean;       // 5.BACK-1: Vista de Control
  target_client_id?: number;     // 5.BACK-1: Vista de Control
}

const secret = new TextEncoder().encode(env.JWT_SECRET);

export async function signAccessToken(payload: TokenPayload, lifetimeMinutes: number): Promise<string> {
  const claims: Record<string, unknown> = {
    client_id: payload.client_id,
    user_type: payload.user_type,
    session_id: payload.session_id,
  };
  if (payload.impersonating !== undefined) claims.impersonating = payload.impersonating;
  if (payload.target_client_id !== undefined) claims.target_client_id = payload.target_client_id;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${lifetimeMinutes}m`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<JWTPayload & TokenPayload> {
  const { payload } = await jwtVerify(token, secret);
  return payload as JWTPayload & TokenPayload;
}
