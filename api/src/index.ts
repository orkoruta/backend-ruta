import { app } from './app.js';
import { env, validateEnv } from './config/env.js';

validateEnv();

app.listen(env.PORT, env.HOST, () => {
  console.log(`🚀 RUTA API running on http://${env.HOST}:${env.PORT}`);
  console.log(`   Environment: ${env.NODE_ENV}`);
  console.log(`   Health check: http://localhost:${env.PORT}/healthz`);
});
