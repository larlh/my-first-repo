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

/**
 * Parse the text of a `.env` file into key/value pairs:
 *  - blank lines and lines starting with `#` are ignored; an optional `export ` prefix too;
 *  - a value may be wrapped in single or double quotes (kept verbatim, `#` included);
 *  - in an unquoted value, a `#` at the start or after whitespace begins a comment — the
 *    shipped `.env.example` documents every variable that way, and it must work when copied
 *    as is (it did not: the comment became part of the value and nothing started);
 *  - `KEY=` (no value) means "not set", so the default of the schema applies instead of an
 *    empty string failing validation (e.g. `APP_SECRET=` in development).
 */
export function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    const closing = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1;
    if (closing > 0) {
      value = value.slice(1, closing);
    } else {
      const comment = value.search(/(^|\s)#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    if (value !== '') values[key] = value;
  }
  return values;
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
  const values = parseDotEnv(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
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
  if (data.NODE_ENV === 'production') {
    const problem = weakSecretReason(data.APP_SECRET ?? '');
    if (problem) {
      throw new EnvValidationError(
        `APP_SECRET must be set to a private, random value in production (${problem}). Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
      );
    }
  }
  return result.data;
}

/**
 * Why a value must not be used as APP_SECRET in production, or null when it is acceptable.
 * APP_SECRET signs every file link and encrypts stored webhook secrets: the development
 * default or a value with almost no variety (`aaaa…`, `changemechangeme…`) is as good as public.
 */
export function weakSecretReason(secret: string): string | null {
  if (secret === DEV_APP_SECRET) return 'it is the public development default';
  if (new Set(secret).size < 12) return 'it has fewer than 12 different characters';
  return null;
}

/**
 * Switches that exist only to make local development possible (e.g. `ALLOW_PRIVATE_URLS`, which
 * lifts the SSRF guard so a webhook can reach a receiver on localhost). They are off by default
 * and a production process refuses to start with one of them on.
 */
export function refuseDevOnlySwitches(
  config: { NODE_ENV?: string },
  switches: Record<string, boolean>,
): void {
  if (config.NODE_ENV !== 'production') return;
  const on = Object.keys(switches).filter((name) => switches[name] === true);
  if (on.length > 0) {
    throw new EnvValidationError(
      `${on.join(', ')} ${on.length === 1 ? 'is a' : 'are'} development-only switch${on.length === 1 ? '' : 'es'} and cannot be enabled with NODE_ENV=production`,
    );
  }
}
