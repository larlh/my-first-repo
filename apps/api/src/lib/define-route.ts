import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiErrorBodySchema, AppError } from '@parlante/shared';
import type {
  RouteBody,
  RouteDef,
  RouteParams,
  RouteQuery,
  RouteResponseInput,
} from '@parlante/shared';
import { allowedOrigins } from '../config';
import type { ApiKeyAuth, SessionAuth } from '../types';
import { requireApiKey, requireRole, requireSession } from './auth';

type AuthFor<R extends RouteDef> = R['auth'] extends 'session'
  ? SessionAuth
  : R['auth'] extends 'apiKey'
    ? ApiKeyAuth
    : null;

export interface RouteContext<R extends RouteDef> {
  /** Validated path params / query / JSON body (defaults applied). */
  params: RouteParams<R>;
  query: RouteQuery<R>;
  body: RouteBody<R>;
  /** Who is calling. `auth.workspaceId` must scope every query. null on public routes. */
  auth: AuthFor<R>;
  request: FastifyRequest;
  reply: FastifyReply;
  app: FastifyInstance;
}

/**
 * Handlers return the response body (validated against `route.response` and serialised).
 * Binary routes send the reply themselves and return `reply`.
 */
export type RouteHandler<R extends RouteDef> = (
  ctx: RouteContext<R>,
) => Promise<RouteResponseInput<R> | FastifyReply>;

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Register a contract route on the app. It wires, from the RouteDef alone:
 *   validation (params / query / body) · response serialisation · OpenAPI entry ·
 *   authentication (session cookie or API key) · minimum role · CSRF origin check ·
 *   per-route rate limit · success status code.
 *
 *   defineRoute(app, api.videos.get, async ({ params, auth, app }) => {
 *     const video = await findVideo(app.db, auth.workspaceId, params.videoId);
 *     return toVideoDto(video);
 *   });
 */
export function defineRoute<const R extends RouteDef>(
  app: FastifyInstance,
  route: R,
  handler: RouteHandler<R>,
): void {
  const origins = allowedOrigins(app.config);
  const errorResponses = Object.fromEntries(
    ['400', '401', '403', '404', '409', '422', '429', '500'].map((status) => [
      status,
      ApiErrorBodySchema,
    ]),
  );
  const successStatus = route.status ?? 200;

  const options: RouteOptions = {
    method: route.method,
    url: route.path,
    schema: {
      tags: [route.tag],
      summary: route.summary,
      description: describe(route),
      ...(route.params ? { params: route.params } : {}),
      ...(route.query ? { querystring: route.query } : {}),
      ...(route.body ? { body: route.body } : {}),
      ...(route.multipart ? { consumes: ['multipart/form-data'] } : {}),
      ...(route.binary
        ? { produces: ['application/octet-stream'] }
        : { response: { [successStatus]: route.response, ...errorResponses } }),
      security:
        route.auth === 'session'
          ? [{ sessionCookie: [] }]
          : route.auth === 'apiKey'
            ? [{ apiKey: [] }]
            : [],
    },
    config: {
      ...(route.rateLimit && app.config.RATE_LIMIT_ENABLED
        ? { rateLimit: { max: route.rateLimit.max, timeWindow: route.rateLimit.windowSec * 1000 } }
        : {}),
    },
    preHandler: async (request) => {
      if (route.auth === 'session') {
        // CSRF defence in depth (cookies are SameSite=Lax): browsers send Origin on
        // state-changing requests; reject origins we do not know.
        const origin = request.headers.origin;
        if (
          UNSAFE_METHODS.has(request.method) &&
          origin &&
          !origins.includes(origin.replace(/\/+$/, ''))
        ) {
          throw AppError.forbidden('Cross-origin request rejected');
        }
        const auth = await requireSession(request);
        requireRole(auth, route.minRole ?? 'viewer');
      } else if (route.auth === 'apiKey') {
        const auth = await requireApiKey(request);
        requireRole(auth, route.minRole ?? 'viewer');
      }
    },
    handler: async (request, reply) => {
      const result = await handler({
        params: request.params as RouteParams<R>,
        query: request.query as RouteQuery<R>,
        body: request.body as RouteBody<R>,
        auth: request.auth as AuthFor<R>,
        request,
        reply,
        app,
      });
      if (result === reply || reply.sent) return reply;
      return reply.status(successStatus).send(result);
    },
  };
  app.withTypeProvider<ZodTypeProvider>().route(options);
}

function describe(route: RouteDef): string {
  const parts: string[] = [];
  if (route.auth === 'session')
    parts.push(`Auth: session cookie${route.minRole ? ` · role ≥ ${route.minRole}` : ''}.`);
  if (route.auth === 'apiKey') parts.push('Auth: `Authorization: Bearer <API key>`.');
  if (route.auth === 'public') parts.push('Auth: none.');
  if (route.multipart) parts.push(route.multipart.description);
  if (route.errors?.length) parts.push(`Domain errors: ${route.errors.join(', ')}.`);
  if (route.rateLimit)
    parts.push(`Rate limit: ${route.rateLimit.max} requests / ${route.rateLimit.windowSec} s.`);
  return parts.join(' ');
}

/** Re-export for modules that build ad-hoc schemas next to their routes. */
export { z };
