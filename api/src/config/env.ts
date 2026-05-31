import dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config({ path: resolve(process.cwd(), '..', '.env') });

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3001', 10),
  HOST: process.env.HOST || '0.0.0.0',
  DATABASE_URL: process.env.DATABASE_URL || '',
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  JWT_ACCESS_TOKEN_LIFETIME_MINUTES: parseInt(
    process.env.JWT_ACCESS_TOKEN_LIFETIME_MINUTES || '15', 10
  ),
  JWT_REFRESH_TOKEN_LIFETIME_DAYS: parseInt(
    process.env.JWT_REFRESH_TOKEN_LIFETIME_DAYS || '7', 10
  ),
  WOMPI_PUBLIC_KEY: process.env.WOMPI_PUBLIC_KEY || '',
  WOMPI_PRIVATE_KEY: process.env.WOMPI_PRIVATE_KEY || '',
  WOMPI_WEBHOOK_SECRET: process.env.WOMPI_WEBHOOK_SECRET || '',
  CORS_ORIGINS: process.env.CORS_ORIGINS || 'http://localhost:3002,http://localhost:3003',
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
