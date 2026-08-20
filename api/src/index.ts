import { app } from './app.js';
import { env, validateEnv } from './config/env.js';
import { logger } from './lib/logger.js';
import { initMaintenanceJobs } from './jobs/maintenance_boss.js';

validateEnv();

app.listen(env.PORT, env.HOST, () => {
  logger.info({ port: env.PORT, host: env.HOST, env: env.NODE_ENV }, 'RUTA API running');
  /*
   * La API sigue sirviendo aunque los jobs no arranquen: sacarla de servicio
   * por eso sería peor que el problema. El fallo no se pierde — se reintenta
   * con backoff dentro de `initMaintenanceJobs` y queda expuesto en
   * `GET /healthz/jobs`, que responde 503 mientras no estén corriendo.
   */
  initMaintenanceJobs().catch((err) => {
    logger.error({ err }, 'Jobs de mantenimiento sin arrancar; se reintentará en segundo plano');
  });
});

