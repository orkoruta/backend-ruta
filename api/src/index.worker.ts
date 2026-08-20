import { validateEnv } from './config/env.js';
import { logger } from './lib/logger.js';
import { initMaintenanceJobs } from './jobs/maintenance_boss.js';

validateEnv();

initMaintenanceJobs()
  .then(() => {
    logger.info('RUTA worker running — maintenance jobs active');
  })
  .catch((err) => {
    /*
     * El worker existe **solo** para correr los jobs y no expone HTTP, así que
     * no hay `/healthz/jobs` que consultar aquí: si no puede arrancarlos, lo
     * honesto es morir y que la plataforma lo reinicie, que además se ve en el
     * panel de Render. Es la diferencia con la API, que sí debe seguir en pie y
     * reintentar por dentro.
     */
    logger.error({ err }, 'Worker: no se pudieron arrancar los jobs, saliendo para que se reinicie');
    process.exit(1);
  });
