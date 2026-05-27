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
} as const;

export type Env = typeof env;

export function validateEnv(): void {
  const required: Array<keyof Env> = [
    'DATABASE_URL',
  ];

  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}
