import { z } from 'zod';
import { baseEnvSchema, envBoolean, parseEnv } from '@parlante/shared/node';
import { providerEnvSchema } from '@parlante/providers';

/**
 * API configuration = shared base variables + provider variables + API-specific ones.
 * Everything is validated at start-up; documented in `.env.example`.
 */
export const apiEnvSchema = baseEnvSchema.extend(providerEnvSchema.shape).extend({
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Comma-separated origins allowed by CORS and the CSRF origin check. */
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_COOKIE_NAME: z.string().default('parlante_session'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** `auto` = secure cookies in production only. */
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  /** Trust X-Forwarded-* headers (set when running behind a reverse proxy). */
  TRUST_PROXY: envBoolean(false),
  RATE_LIMIT_ENABLED: envBoolean(true),
  /** Global limit: requests per minute per client IP. */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  /** Hard cap for any upload (plans may be lower). */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(4096).default(1024),
  /** Directory for upload temp files (default: OS temp dir). */
  UPLOAD_TMP_DIR: z.string().optional(),
  /** Allow webhook URLs / script URLs that point to private addresses (local development). */
  ALLOW_PRIVATE_URLS: envBoolean(false),
  OPENAPI_ENABLED: envBoolean(true),
});

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ApiConfig {
  return parseEnv(apiEnvSchema, source);
}

export function allowedOrigins(config: Pick<ApiConfig, 'WEB_ORIGIN' | 'PUBLIC_WEB_URL'>): string[] {
  const list = config.WEB_ORIGIN.split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o !== '');
  const web = config.PUBLIC_WEB_URL.replace(/\/+$/, '');
  return list.includes(web) ? list : [...list, web];
}

export function cookieSecure(config: Pick<ApiConfig, 'COOKIE_SECURE' | 'NODE_ENV'>): boolean {
  if (config.COOKIE_SECURE === 'auto') return config.NODE_ENV === 'production';
  return config.COOKIE_SECURE === 'true';
}
