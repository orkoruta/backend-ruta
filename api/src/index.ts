import { app } from './app.js';
import { env, validateEnv } from './config/env.js';
import { logger } from './middleware/logger.js';

validateEnv();

app.listen(env.PORT, env.HOST, () => {
  logger.info({ port: env.PORT, host: env.HOST, env: env.NODE_ENV }, 'RUTA API running');
});
