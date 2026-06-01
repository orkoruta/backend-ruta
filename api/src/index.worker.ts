import { validateEnv } from './config/env.js';
import { logger } from './lib/logger.js';
import { initMaintenanceJobs } from './jobs/maintenance_boss.js';

validateEnv();

initMaintenanceJobs()
  .then(() => {
    logger.info('RUTA worker running — maintenance jobs active');
  })
  .catch((err) => {
    logger.error({ err }, 'Worker failed to initialize maintenance jobs');
    process.exit(1);
  });
