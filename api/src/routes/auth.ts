import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { loginSchema, loginRutaAdminSchema, refreshSessionSchema, logoutSchema } from '@orkoruta/shared';
import { authService } from '../services/auth.service.js';
import { requireAuth } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

type AuthService = typeof authService;

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  full_name: z.string().min(1).max(200).optional(),
  phone: z.string().min(1).max(50).optional(),
  document_type: z.string().min(1).max(20).optional(),
  document_number: z.string().min(1).max(50).optional(),
  client_slug: z.string().min(1),
});

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
};

function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie('access_token', accessToken, {
    ...COOKIE_OPTIONS,
    maxAge: 15 * 60 * 1000,
  });
  res.cookie('refresh_token', refreshToken, {
    ...COOKIE_OPTIONS,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/auth/refresh',
  });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie('access_token', { ...COOKIE_OPTIONS });
  res.clearCookie('refresh_token', { ...COOKIE_OPTIONS, path: '/auth/refresh' });
}

function authResponse(result: Awaited<ReturnType<AuthService['login']>>) {
  return {
    user_id: result.user.id,
    client_id: result.user.client_id,
    user_type: result.user.user_type,
    email: result.user.email,
    expires_in_seconds: result.expiresInSeconds,
    access_token: result.accessToken,
    user: result.user,
  };
}

function requestContext(req: Request) {
  return {
    ip: req.ip,
    userAgent: req.header('user-agent'),
  };
}

export function createAuthRouter(service: AuthService = authService): Router {
  const router = Router();

  router.post('/register', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = registerSchema.parse(req.body);
      const result = await service.register(
        {
          email: input.email,
          password: input.password,
          full_name: input.full_name,
          phone: input.phone,
          document_type: input.document_type,
          document_number: input.document_number,
          client_slug: input.client_slug,
        },
        requestContext(req)
      );
      setAuthCookies(res, result.accessToken, result.refreshToken);
      res.status(201).json(authResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = loginSchema.parse(req.body);
      const result = await service.login(
        { email: input.email, password: input.password, client_slug: input.client_slug },
        requestContext(req)
      );
      setAuthCookies(res, result.accessToken, result.refreshToken);
      res.json(authResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.post('/ruta-admin/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = loginRutaAdminSchema.parse(req.body);
      const result = await service.loginRutaAdmin(
        { email: input.email, password: input.password },
        requestContext(req)
      );
      setAuthCookies(res, result.accessToken, result.refreshToken);
      res.json(authResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = refreshSessionSchema.parse(req.body);
      const refreshToken = body.refresh_token ?? (req.cookies?.refresh_token as string | undefined);

      if (!refreshToken) {
        res.status(401).json({ code: 'AUTHENTICATION_REQUIRED', message: 'Refresh token requerido' });
        return;
      }

      const result = await service.refresh({ refreshToken }, requestContext(req));
      setAuthCookies(res, result.accessToken, result.refreshToken);
      res.json(authResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = logoutSchema.parse(req.body);
      await service.logout(req.user as AuthenticatedUser, {
        allSessions: body.all_sessions,
        sessionId: (req.user as AuthenticatedUser).session_id,
      });
      clearAuthCookies(res);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const authRouter = createAuthRouter();
