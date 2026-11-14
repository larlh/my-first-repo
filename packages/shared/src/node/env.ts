import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Walk up from `start` until a directory containing pnpm-workspace.yaml is found. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

let loaded = false;

/**
 * Load `<repo root>/.env` into process.env once (existing variables win). Safe to call from
 * every entry point; does nothing when the file does not exist.
 */
export function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = path.join(findRepoRoot(), '.env');
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Boolean env var: `1/true/yes/on` → true, `0/false/no/off/''` → false. */
export const envBoolean = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

/** Optional string env var where the empty string counts as "not set". */
export const envOptionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

export const DEV_APP_SECRET = 'dev-only-insecure-secret-change-me-0123456789abcdef';

/**
 * Variables shared by API and worker. Each app extends this schema with its own variables
 * (see apps/api/src/config.ts and apps/worker/src/config.ts). Documented in `.env.example`.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1).default('postgres://parlante:parlante@localhost:5432/parlante'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /** BullMQ key prefix: isolates queues of different environments / test runs. */
  QUEUE_PREFIX: z.string().min(1).max(60).default('parlante'),
  /** Signs file URLs and encrypts stored webhook secrets. ≥ 32 chars, required in production. */
  APP_SECRET: z.string().min(32).default(DEV_APP_SECRET),
  /** Public base URL of the API (used to build absolute file URLs for webhooks / API v1). */
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  /** Public base URL of the web app (share links, invite links). */
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
});
export type BaseEnv = z.infer<typeof baseEnvSchema>;

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validate environment variables with a zod schema. Loads `.env` first.
 * Throws EnvValidationError listing every invalid variable; refuses the development
 * APP_SECRET in production.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.output<T> {
  if (source === process.env) loadDotEnv();
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new EnvValidationError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const data = result.data as { NODE_ENV?: string; APP_SECRET?: string };
  if (data.NODE_ENV === 'production' && data.APP_SECRET === DEV_APP_SECRET) {
    throw new EnvValidationError('APP_SECRET must be set to a private value in production');
  }
  return result.data;
}
