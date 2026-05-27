import { Router, type Request, type Response } from 'express';
import { prisma } from '@orkoruta/db';
import { toApiError } from '../lib/errors.js';

export const healthzRouter: Router = Router();

healthzRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0',
  });
});

healthzRouter.get('/ready', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ready',
      database: 'ok',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json(toApiError('DATABASE_UNAVAILABLE', 'Base de datos no disponible'));
  }
});
