import { z } from 'zod';
import type { ErrorCode } from '../errors';
import type { Role } from '../plans';

/* -------------------------------------------------------------------------------------------
 * Typed route table. One `RouteDef` per endpoint is the single source of truth for:
 *   - the API (apps/api `defineRoute` helper registers it with validation + OpenAPI + auth)
 *   - the web client (typed fetch built from the same object)
 *   - tests and docs
 *
 * URL spaces
 *   /api/...   first-party app API, session cookie auth (`auth: 'session'`) or public
 *   /v1/...    public developer API, API key auth (`Authorization: Bearer plk_…`)
 *
 * Every success body is JSON matching `response` (except `binary` routes). Every error is
 * `{ error: { code, message, details? } }` with the status mapped in ERROR_CODES.
 * ----------------------------------------------------------------------------------------- */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 *  - session: logged-in user (cookie). Workspace = session's current workspace.
 *  - apiKey:  `Authorization: Bearer <key>`. Workspace = the key's workspace, role = editor.
 *  - public:  no authentication (may still be protected by a signed token in the URL).
 */
export type RouteAuth = 'session' | 'apiKey' | 'public';

export interface MultipartSpec {
  /** Name of the file field. */
  fileField: string;
  /** Extra text fields accepted next to the file. */
  fields: z.ZodType;
  description: string;
}

export interface RouteDef {
  method: HttpMethod;
  /** Fastify-style path with `:params`, e.g. `/api/videos/:videoId`. */
  path: string;
  auth: RouteAuth;
  /** Minimum workspace role (session auth). Defaults to `viewer`. */
  minRole?: Role;
  /** Product feature number from the master prompt scope (1–16); 0 = infrastructure. */
  feature: number;
  summary: string;
  tag: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Set instead of `body` for multipart/form-data uploads. */
  multipart?: MultipartSpec;
  response: z.ZodType;
  /** HTTP status of the success response (default 200). */
  status?: 200 | 201 | 202;
  /** The success response is a file/stream, not JSON (`response` is ignored for validation). */
  binary?: boolean;
  /** Domain error codes this route may return besides the generic ones. */
  errors?: ErrorCode[];
  /** Stricter per-route rate limit (per client IP) on top of the global one. */
  rateLimit?: { max: number; windowSec: number };
}

/** Identity helper that preserves the exact schema types of a route definition. */
export function route<const T extends RouteDef>(def: T): T {
  return def;
}

type InputOf<T> = T extends z.ZodType ? z.input<T> : undefined;
type OutputOf<T> = T extends z.ZodType ? z.output<T> : undefined;
type Prop<R, K extends string> = R extends Record<K, infer V> ? V : undefined;

/* What a CLIENT sends (schema input types: defaults optional). */
export type RouteParamsInput<R extends RouteDef> = InputOf<Prop<R, 'params'>>;
export type RouteQueryInput<R extends RouteDef> = InputOf<Prop<R, 'query'>>;
export type RouteBodyInput<R extends RouteDef> = InputOf<Prop<R, 'body'>>;
/* What a HANDLER receives (schema output types: defaults applied). */
export type RouteParams<R extends RouteDef> = OutputOf<Prop<R, 'params'>>;
export type RouteQuery<R extends RouteDef> = OutputOf<Prop<R, 'query'>>;
export type RouteBody<R extends RouteDef> = OutputOf<Prop<R, 'body'>>;
/* What the handler returns / the client receives. */
export type RouteResponse<R extends RouteDef> = z.output<R['response']>;
export type RouteResponseInput<R extends RouteDef> = z.input<R['response']>;

/** Uniform body for actions without a meaningful result (deletes, logout…). */
export const OkSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof OkSchema>;
export const OK: Ok = { ok: true };

/** Non-paginated list wrapper (small collections). */
export function listOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item) });
}

/**
 * Fill `:params` in a route path and append the query string.
 * `buildPath('/api/videos/:videoId', { videoId: 'vid_1' }, { limit: 5 })`
 */
export function buildPath(
  path: string,
  params?: Record<string, string | number> | undefined,
  query?: Record<string, unknown> | undefined,
): string {
  let out = path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`Missing path param "${name}" for ${path}`);
    return encodeURIComponent(String(value));
  });
  if (query) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const v of value) search.append(key, String(v));
      } else {
        search.set(key, String(value));
      }
    }
    const qs = search.toString();
    if (qs) out += `?${qs}`;
  }
  return out;
}
