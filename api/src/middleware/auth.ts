import type { NextFunction, Request, Response } from 'express';
import { toApiError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/token.js';

export interface AuthenticatedUser {
  id: number;
  client_id: number;
  user_type: string;
  session_id: number;
  email?: string;
  // F2.2.BACK-2: campos para Cliente API
  userType?: 'JWT' | 'API_CLIENT';
  apiKeyId?: bigint;
  scopes?: string[];
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.cookies?.access_token) {
    token = req.cookies.access_token as string;
  }

  if (!token) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }

  try {
    const payload = await verifyAccessToken(token);
    req.user = {
      id: Number(payload.sub),
      client_id: payload.client_id,
      user_type: payload.user_type,
      session_id: payload.session_id,
    };
    next();
  } catch {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Token inválido o expirado'));
  }
}

export function requireAdminRuta(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }

  if (req.user.user_type !== 'ADMIN_RUTA' || req.user.client_id !== 0) {
    res.status(403).json(toApiError('FORBIDDEN', 'Requiere rol ADMIN_RUTA'));
    return;
  }

  next();
}

export function requireAdminClient(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }

  if (req.user.user_type !== 'ADMIN_CLIENT' && req.user.user_type !== 'ADMIN_RUTA') {
    res.status(403).json(toApiError('FORBIDDEN', 'Requiere rol ADMIN_CLIENT'));
    return;
  }

  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Autenticación requerida'));
    return;
  }
  next();
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
