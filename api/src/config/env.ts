import dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config({ path: resolve(process.cwd(), '..', '.env') });

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3001', 10),
  HOST: process.env.HOST || '0.0.0.0',
  DATABASE_URL: process.env.DATABASE_URL || '',
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  /*
   * Aquí había `JWT_ACCESS_TOKEN_LIFETIME_MINUTES` y
   * `JWT_REFRESH_TOKEN_LIFETIME_DAYS`. **Las dos eran configuración muerta**:
   * se declaraban y no las leía nadie, así que cambiarlas en el `.env` no
   * tenía ningún efecto y ya generó confusión.
   *
   * La vida de los tokens se decide **por rol** con los parámetros de
   * `client_parameters` (fila global `client_id = 0`), que es donde hay que
   * tocarla:
   *
   *   auth.jwt_lifetime_<rol>_minutes          → access token
   *   auth.refresh_token_lifetime_<rol>_days   → refresh token
   *
   * Los resuelve `services/auth.service.ts`; los valores por defecto del
   * código solo aplican si no existe la fila.
   */
  WOMPI_PUBLIC_KEY: process.env.WOMPI_PUBLIC_KEY || '',
  WOMPI_PRIVATE_KEY: process.env.WOMPI_PRIVATE_KEY || '',
  WOMPI_WEBHOOK_SECRET: process.env.WOMPI_WEBHOOK_SECRET || '',
  CORS_ORIGINS: process.env.CORS_ORIGINS || 'http://localhost:3002,http://localhost:3003',
  /**
   * Clave de servidor para la Geocoding API. Va aquí y no en el frontend porque
   * Google solo permite restringir las claves de web service por IP: expuesta en
   * el navegador sería inacotable.
   */
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',

  /**
   * Correo transaccional (aviso de entrega al comprador).
   *
   * Todas son **opcionales**: sin `EMAIL_API_KEY` el envío se salta con un log
   * y no rompe nada. Se eligió la API HTTP de Resend en vez de SMTP para no
   * añadir dependencia (`nodemailer`) al proyecto; el cliente está aislado en
   * `lib/email_client.ts`, así que cambiar de proveedor es tocar un archivo.
   *
   * `EMAIL_FROM` debe ser de un dominio **verificado** en el proveedor. Con un
   * remitente sin verificar el correo se rechaza o cae en spam, que es peor que
   * no enviarlo: el comprador no lo ve y nadie se entera del fallo.
   */
  EMAIL_API_KEY: process.env.EMAIL_API_KEY || '',
  EMAIL_FROM: process.env.EMAIL_FROM || '',
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME || 'RUTA',
} as const;

export type Env = typeof env;

const DEV_JWT_SECRET = 'dev-secret-change-in-production';

export function validateEnv(): void {
  const required: Array<keyof Env> = [
    'DATABASE_URL',
  ];

  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  if (env.NODE_ENV === 'production' && env.JWT_SECRET === DEV_JWT_SECRET) {
    console.error('FATAL: JWT_SECRET must be set to a secure value in production');
    process.exit(1);
  }
}
