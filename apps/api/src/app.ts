import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Providers } from '@parlante/shared';
import { createDb } from '@parlante/db';
import type { Db } from '@parlante/db';
import { createFileUrlBuilder, createQueueClient } from '@parlante/jobs';
import type { QueueClient } from '@parlante/jobs';
import { createProviders } from '@parlante/providers';
import { allowedOrigins, loadConfig } from './config';
import type { ApiConfig } from './config';
import { loadModules } from './lib/modules';
import type { ApiModule } from './lib/modules';
import { API_VERSION, registerCoreRoutes } from './plugins/core-routes';
import { registerErrorHandling } from './plugins/errors';
import './types';

export interface BuildAppOptions {
  config?: ApiConfig;
  /** Inject dependencies (tests). When omitted they are created from the config. */
  db?: Db;
  queues?: QueueClient;
  providers?: Providers;
  /** Modules to register instead of autoloading `src/modules/*` (tests). */
  modules?: ApiModule[];
  /** Extra modules registered after the autoloaded ones (tests). */
  extraModules?: ApiModule[];
}

/**
 * Build the Fastify application (not listening). Order matters:
 * decorators → security plugins → OpenAPI → core routes → autoloaded modules.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
            ...(config.NODE_ENV === 'development'
              ? {
                  transport: {
                    target: 'pino-pretty',
                    options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
                  },
                }
              : {}),
          },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024, // JSON bodies; uploads go through multipart limits
    routerOptions: { maxParamLength: 500 },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  /* ---------- decorators: config, db, queues, providers, file URLs ---------- */
  app.decorate('config', config);
  if (options.db) {
    app.decorate('db', options.db);
  } else {
    const handle = createDb(config.DATABASE_URL, { applicationName: 'parlante-api' });
    app.decorate('db', handle.db);
    app.addHook('onClose', async () => handle.close());
  }
  if (options.queues) {
    app.decorate('queues', options.queues);
  } else {
    const queues = createQueueClient({ redisUrl: config.REDIS_URL, prefix: config.QUEUE_PREFIX });
    app.decorate('queues', queues);
    app.addHook('onClose', async () => queues.close());
  }
  const providers = options.providers ?? createProviders(config);
  app.decorate('providers', providers);
  app.decorate(
    'fileUrl',
    createFileUrlBuilder({
      storage: providers.storage,
      appSecret: config.APP_SECRET,
      publicApiUrl: config.PUBLIC_API_URL,
    }),
  );
  app.decorateRequest('auth', null);

  /* ---------- security ---------- */
  await app.register(helmet, {
    // The API serves JSON and media consumed by the web app on another origin.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // Swagger UI (/docs) needs its own scripts, styles and inline bootstrap.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
      },
    },
  });
  await app.register(cors, {
    origin: allowedOrigins(config),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 20 },
  });
  if (config.RATE_LIMIT_ENABLED) {
    await app.register(rateLimit, {
      global: true,
      max: config.RATE_LIMIT_MAX,
      timeWindow: 60_000,
      allowList: (request) => request.url === '/health',
    });
  }

  /* ---------- OpenAPI ---------- */
  if (config.OPENAPI_ENABLED) {
    await app.register(swagger, {
      openapi: {
        openapi: '3.0.3',
        info: {
          title: 'Parlante API',
          version: API_VERSION,
          description:
            'REST API of Parlante. `/v1/*` is the public developer API (API key). `/api/*` is the first-party application API (session cookie). Errors always have the shape `{ error: { code, message, details? } }`.',
        },
        servers: [{ url: config.PUBLIC_API_URL }],
        components: {
          securitySchemes: {
            apiKey: {
              type: 'http',
              scheme: 'bearer',
              description: 'API key: `Authorization: Bearer plk_…`',
            },
            sessionCookie: { type: 'apiKey', in: 'cookie', name: config.SESSION_COOKIE_NAME },
          },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
    app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  }

  /* ---------- routes ---------- */
  registerCoreRoutes(app);
  const modules = options.modules ?? (await loadModules());
  const seen = new Set<string>();
  for (const mod of [...modules, ...(options.extraModules ?? [])]) {
    if (seen.has(mod.name)) throw new Error(`Duplicate API module name "${mod.name}"`);
    seen.add(mod.name);
    await mod.register(app);
    app.log.debug({ module: mod.name }, 'module registered');
  }

  return app;
}
