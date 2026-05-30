import type { NextFunction, Request, Response } from 'express';
import { toApiError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/token.js';

/**
 * requireControlView — verifies the request is operating under Vista de Control.
 *
 * Checks the JWT directly for the `impersonating` claim because the base
 * `authenticate` middleware does not forward optional JWT claims to `req.user`.
 * Returns 403 FORBIDDEN if the claim is absent or false.
 */
export async function requireControlView(req: Request, res: Response, next: NextFunction): Promise<void> {
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
    if (!payload.impersonating) {
      res.status(403).json(toApiError('FORBIDDEN', 'Esta operación requiere Vista de Control activa'));
      return;
    }
    next();
  } catch {
    res.status(401).json(toApiError('AUTHENTICATION_REQUIRED', 'Token inválido o expirado'));
  }
}
