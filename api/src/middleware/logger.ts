import pino from 'pino';
import type { Request, Response, NextFunction } from 'express';

const isDev = process.env.NODE_ENV === 'development';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {
        formatters: {
          level: (label: string) => ({ level: label }),
        },
      }),
});

/**
 * Middleware que agrega request_id y trace_id a cada request y loggea entrada/salida.
 * También incluye client_id, user_id y user_type cuando el usuario está autenticado.
 */
export function loggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.headers['x-request-id'] as string || crypto.randomUUID();
  const traceId = crypto.randomUUID();

  req.requestId = requestId;
  req.traceId = traceId;
  res.setHeader('X-Request-Id', requestId);

  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      requestId,
      trace_id: traceId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: duration,
      userAgent: req.headers['user-agent'],
      client_id: req.user?.client_id ?? null,
      user_id: req.user?.id ?? null,
      user_type: req.user?.user_type ?? null,
    }, `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
}

// Extender Request type
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      traceId: string;
    }
  }
}
