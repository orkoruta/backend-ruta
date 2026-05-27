import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env.js';

export interface TokenPayload {
  sub: string;
  client_id: number;
  user_type: string;
  session_id: number;
}

const secret = new TextEncoder().encode(env.JWT_SECRET);

export async function signAccessToken(payload: TokenPayload, lifetimeMinutes: number): Promise<string> {
  return new SignJWT({
    client_id: payload.client_id,
    user_type: payload.user_type,
    session_id: payload.session_id,
  })
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
