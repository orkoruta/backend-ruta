import { Router, type Request, type Response } from 'express';
import { prisma } from '@orkoruta/db';
import { toApiError } from '../lib/errors.js';
import { getMaintenanceJobsStatus } from '../jobs/maintenance_boss.js';

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

/**
 * Estado de los jobs de mantenimiento.
 *
 * Va **aparte** de `/healthz/ready` a propósito: si los jobs se caen, la API
 * sigue sirviendo peticiones perfectamente y sacarla del balanceador sería
 * peor que el problema. Pero alguien tiene que enterarse, así que este endpoint
 * responde **503** cuando no están corriendo, para poder monitorizarlo por
 * separado.
 *
 * `disabled` (entorno de test) se considera sano: están apagados a propósito.
 */
healthzRouter.get('/jobs', (_req: Request, res: Response) => {
  const jobs = getMaintenanceJobsStatus();
  const healthy = jobs.state === 'running' || jobs.state === 'disabled';

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    jobs,
    timestamp: new Date().toISOString(),
  });
});
