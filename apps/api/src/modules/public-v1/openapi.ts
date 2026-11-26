import { PLANS, PLAN_IDS } from '@parlante/shared';
import { V1_RATE_LIMITS, V1_RATE_WINDOW_MS } from './rate-limit';

/* -------------------------------------------------------------------------------------------
 * OpenAPI document of the PUBLIC API only (`/v1/*`), derived from the document the app
 * generates from the route table — so it can never drift from what the routes validate — and
 * completed with what a developer integrating from outside needs: authentication, limits,
 * errors, asynchronous rendering and webhooks.
 * ----------------------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Names of the `#/components/schemas/…` referenced anywhere inside `node`. */
function collectSchemaRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaRefs(item, into);
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      const match = /^#\/components\/schemas\/(.+)$/.exec(value);
      if (match?.[1]) into.add(match[1]);
    } else {
      collectSchemaRefs(value, into);
    }
  }
}

const RATE_HEADERS: Json = {
  'RateLimit-Limit': {
    description: 'Requests this API key may make per window',
    schema: { type: 'integer' },
  },
  'RateLimit-Remaining': {
    description: 'Requests left in the current window',
    schema: { type: 'integer' },
  },
  'RateLimit-Reset': {
    description: 'Seconds until the current window ends',
    schema: { type: 'integer' },
  },
};

function description(): string {
  const windowSec = V1_RATE_WINDOW_MS / 1000;
  const limits = PLAN_IDS.map((plan) => `| ${PLANS[plan].name} | ${V1_RATE_LIMITS[plan]} |`).join(
    '\n',
  );
  return [
    'Create talking-avatar videos from your own systems: send a script, a template with',
    'variables or a full Composition document and receive an MP4 with subtitles.',
    '',
    '## Authentication',
    'Create an API key in **Settings → API keys** and send it on every request:',
    '',
    '```',
    'Authorization: Bearer plk_…',
    '```',
    '',
    'A key belongs to one workspace and acts with editor permissions on it. The key is shown',
    'once; only its hash is stored. Revoking a key takes effect immediately.',
    '',
    '## Rendering is asynchronous',
    '`POST /v1/videos` answers `202` with the video in `queued` state. Then either poll',
    '`GET /v1/videos/{videoId}` (`status`, `progress`) or register a webhook endpoint in',
    '**Settings → Webhooks** to receive `video.completed` / `video.failed`. The webhook body is',
    '`{ id, type, createdAt, workspaceId, data: { video } }` where `video` has exactly the shape',
    'this API returns, and it is signed:',
    '',
    '```',
    'Parlante-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>',
    '```',
    '',
    'Videos with photorealistic avatars (`real_…`, `avt_…`) are animated by a neural engine and',
    'take much longer than instant 2D avatars (`stock_…`); such videos carry `aiGenerated: true`.',
    '',
    '## Variables',
    'Texts may contain `{{name}}` placeholders. `input.variables` gives their values for this',
    'video; a placeholder without a value uses the default declared by the template. A request',
    'with unknown variable names, or with a placeholder that has neither value nor default, is',
    'rejected with `422 UNPROCESSABLE` (`details.missing`, `details.unknown`).',
    '',
    '## Credits and plan limits',
    'A render reserves credits when it is queued and is settled to the real duration when it',
    'finishes; failed renders are refunded. `402 INSUFFICIENT_CREDITS` and',
    '`403 PLAN_LIMIT_EXCEEDED` mean nothing was created or charged.',
    '',
    '## Rate limits',
    `Requests are counted per API key in windows of ${windowSec} seconds. Every response carries`,
    '`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; beyond the limit the API',
    'answers `429 RATE_LIMITED` with `Retry-After`.',
    '',
    `| Plan | Requests per ${windowSec} s |`,
    '| --- | --- |',
    limits,
    '',
    '## Errors',
    'Every error has the same shape: `{ "error": { "code", "message", "details"? } }`. Rely on',
    '`code`, not on the message. A resource of another workspace answers `404 NOT_FOUND`.',
    '',
    '## Files',
    'File URLs (`videoUrl`, `downloadUrl`, `thumbnailUrl`, `srtUrl`, `vttUrl`) are signed and',
    'expire after a few hours (7 days inside webhooks): download the file or ask for the video',
    'again instead of storing the URL. `downloadUrl` serves the MP4 as an attachment named after',
    'the title.',
    '',
    '## Language',
    'Built-in templates and catalogue texts are written in Spanish and English. Send',
    '`Accept-Language: en` to get the English version (default: Spanish).',
  ].join('\n');
}

export interface V1DocumentOptions {
  publicApiUrl: string;
}

/** Keep the `/v1/*` paths of the app document and everything they reference. */
export function buildV1Document(full: unknown, options: V1DocumentOptions): Json {
  const source = isObject(full) ? full : {};
  const allPaths = isObject(source.paths) ? source.paths : {};
  const paths: Json = {};
  const tags = new Set<string>();
  for (const [path, item] of Object.entries(allPaths)) {
    if (!path.startsWith('/v1/') || !isObject(item)) continue;
    const operations: Json = {};
    for (const [method, operation] of Object.entries(item)) {
      if (!isObject(operation)) {
        operations[method] = operation;
        continue;
      }
      const responses: Json = {};
      for (const [status, response] of Object.entries(
        isObject(operation.responses) ? operation.responses : {},
      )) {
        responses[status] = isObject(response)
          ? {
              ...response,
              headers: {
                ...(isObject(response.headers) ? response.headers : {}),
                ...RATE_HEADERS,
                ...(status === '429'
                  ? {
                      'Retry-After': {
                        description: 'Seconds to wait before retrying',
                        schema: { type: 'integer' },
                      },
                    }
                  : {}),
              },
            }
          : response;
      }
      for (const tag of Array.isArray(operation.tags) ? operation.tags : []) {
        if (typeof tag === 'string') tags.add(tag);
      }
      operations[method] = { ...operation, responses, security: [{ apiKey: [] }] };
    }
    paths[path] = operations;
  }

  // Schemas referenced by the kept paths, transitively.
  const components = isObject(source.components) ? source.components : {};
  const allSchemas = isObject(components.schemas) ? components.schemas : {};
  const wanted = new Set<string>();
  collectSchemaRefs(paths, wanted);
  const schemas: Json = {};
  const pending = [...wanted];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (name in schemas || !(name in allSchemas)) continue;
    schemas[name] = allSchemas[name];
    const nested = new Set<string>();
    collectSchemaRefs(allSchemas[name], nested);
    pending.push(...nested);
  }

  const securitySchemes = isObject(components.securitySchemes) ? components.securitySchemes : {};
  const info = isObject(source.info) ? source.info : {};
  return {
    openapi: typeof source.openapi === 'string' ? source.openapi : '3.0.3',
    info: {
      title: 'Parlante API v1',
      version: typeof info.version === 'string' ? info.version : '1',
      description: description(),
    },
    servers: [{ url: options.publicApiUrl.replace(/\/+$/, '') }],
    tags: [...tags].map((name) => ({ name })),
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: { apiKey: securitySchemes.apiKey },
      ...(Object.keys(schemas).length > 0 ? { schemas } : {}),
    },
  };
}

/**
 * Human-readable reference: Swagger UI (the assets the app already serves under `/docs`)
 * pointed at the v1 document.
 */
export function v1DocsPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Parlante API v1</title>
    <link rel="stylesheet" href="/docs/static/swagger-ui.css" />
    <link rel="stylesheet" href="/docs/static/index.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/static/swagger-ui-bundle.js"></script>
    <script src="/docs/static/swagger-ui-standalone-preset.js"></script>
    <script>
      window.onload = function () {
        window.ui = SwaggerUIBundle({
          url: '/v1/openapi.json',
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          layout: 'BaseLayout',
        });
      };
    </script>
  </body>
</html>
`;
}
