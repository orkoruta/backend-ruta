import { app } from './app.js';
import { env, validateEnv } from './config/env.js';
import { logger } from './lib/logger.js';
import { initMaintenanceJobs } from './jobs/maintenance_boss.js';

validateEnv();

app.listen(env.PORT, env.HOST, () => {
  logger.info({ port: env.PORT, host: env.HOST, env: env.NODE_ENV }, 'RUTA API running');
  initMaintenanceJobs().catch((err) => {
    logger.error({ err }, 'Failed to initialize maintenance jobs');
  });
});

