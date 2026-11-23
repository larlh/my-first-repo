import {
  AppError,
  COMPOSITION_LIMITS,
  OK,
  api,
  buildPage,
  checkVariableValues,
  cloneCompositionWithNewIds,
  compositionFromScript,
  listUsedVariables,
  syncVariableDefs,
} from '@parlante/shared';
import type { Composition, RouteDef, UiLocale } from '@parlante/shared';
import { and, cursorOrder, cursorWhere, eq, videos } from '@parlante/db';
import { startRender, toPublicVideo } from '@parlante/jobs';
import type { FastifyRequest } from 'fastify';
import { defineRoute } from '../../lib/define-route';
import type { RouteHandler } from '../../lib/define-route';
import { planLimits } from '../../lib/limits';
import { defineModule } from '../../lib/modules';
import { receiveUpload } from '../../lib/uploads';
import { storeUploadedAsset, toAssetDto } from '../assets/service';
import { listAvatarCatalog } from '../avatars/catalog';
import { listTemplateCatalog, loadTemplateSource, templateDeps } from '../templates/service';
import { createDraftVideo, deleteVideo, findVideo, videoDeps } from '../videos/service';
import { listVoiceCatalog } from '../voices/catalog';
import { buildV1Document, v1DocsPage } from './openapi';
import { KeyRateLimiter, V1_RATE_LIMITS, enforceRateLimit } from './rate-limit';

/* -------------------------------------------------------------------------------------------
 * Public developer API v1 (`/v1/*`, API key). A thin layer: every route reuses the services
 * of the first-party API (video drafts, catalogues, uploads) and `startRender`, so a video
 * created here is moderated, limited, charged and rendered exactly like one made in the app.
 * ----------------------------------------------------------------------------------------- */

/** Language of catalogue texts and built-in templates: `Accept-Language: en…` or Spanish. */
function requestLocale(request: FastifyRequest): UiLocale {
  const header = request.headers['accept-language'];
  return typeof header === 'string' && /^\s*en\b/i.test(header) ? 'en' : 'es';
}

const UNTITLED: Record<UiLocale, string> = { es: 'Vídeo sin título', en: 'Untitled video' };

/** A title for a video described only by its script: the beginning of the text. */
function titleFromText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 59).trimEnd()}…`;
}

/**
 * Check the values sent for the `{{variables}}` of a document and remember them as the
 * defaults of the video: its composition keeps the placeholders, and rendering it again later
 * (from the app, without values) produces the same texts.
 */
function withVariableValues(composition: Composition, values: Record<string, string>): Composition {
  const used = listUsedVariables(composition);
  const check = checkVariableValues(composition, values);
  if (check.missing.length > 0 || check.unknown.length > 0) {
    throw new AppError(
      'UNPROCESSABLE',
      'The variables sent do not match the {{placeholders}} of the video',
      { missing: check.missing, unknown: check.unknown, expected: used },
    );
  }
  if (used.length > COMPOSITION_LIMITS.maxVariables) {
    throw new AppError(
      'UNPROCESSABLE',
      `A video can use at most ${COMPOSITION_LIMITS.maxVariables} different variables`,
      { max: COMPOSITION_LIMITS.maxVariables, value: used.length },
    );
  }
  return {
    ...composition,
    variables: syncVariableDefs(composition).map((def) =>
      Object.prototype.hasOwnProperty.call(values, def.name)
        ? { ...def, defaultValue: values[def.name] ?? '' }
        : def,
    ),
  };
}

export default defineModule({
  name: 'public-v1',
  register(app) {
    const { db, queues, providers, fileUrl, config } = app;
    const videoService = videoDeps(app);
    const templateService = templateDeps(app);
    const limiter = new KeyRateLimiter();

    /**
     * `defineRoute` plus the per-key request limit. It runs after authentication (the counter
     * belongs to a real key) and before the handler does any work.
     */
    function defineV1Route<const R extends RouteDef>(route: R, handler: RouteHandler<R>): void {
      defineRoute(app, route, async (ctx) => {
        const auth = ctx.request.auth;
        if (config.RATE_LIMIT_ENABLED && auth?.kind === 'apiKey') {
          enforceRateLimit(
            ctx.reply,
            limiter.take(auth.apiKey.id, V1_RATE_LIMITS[auth.workspace.plan]),
          );
        }
        return handler(ctx);
      });
    }

    defineV1Route(api.v1.me, async ({ auth }) => {
      return {
        workspace: {
          id: auth.workspace.id,
          name: auth.workspace.name,
          plan: auth.workspace.plan,
          credits: auth.workspace.credits,
        },
        apiKey: { id: auth.apiKey.id, name: auth.apiKey.name, prefix: auth.apiKey.prefix },
      };
    });

    defineV1Route(api.v1.listAvatars, async ({ auth, request }) => {
      const items = await listAvatarCatalog(
        { db, providers, fileUrl, publicApiUrl: config.PUBLIC_API_URL },
        auth.workspaceId,
        requestLocale(request),
      );
      // Only what a video can use right now (avatars still being prepared are left out).
      return { items: items.filter((avatar) => avatar.status === 'ready') };
    });

    defineV1Route(api.v1.listVoices, async ({ auth, query, request }) => {
      const items = await listVoiceCatalog(
        {
          db,
          providers,
          onProviderError: (providerId, err) => {
            request.log.warn({ err, providerId }, 'a voice provider could not list its voices');
          },
        },
        auth.workspaceId,
        { language: query.language },
      );
      return { items: items.filter((voice) => voice.status === 'ready') };
    });

    defineV1Route(api.v1.listTemplates, async ({ auth, request }) => {
      return {
        items: await listTemplateCatalog(templateService, auth.workspaceId, requestLocale(request)),
      };
    });

    defineV1Route(api.v1.createVideo, async ({ auth, body, request }) => {
      const locale = requestLocale(request);
      const { input } = body;
      let title = body.title;
      let composition: Composition;
      let templateId: string | null = null;
      let variables: Record<string, string> = {};
      if (input.type === 'script') {
        composition = compositionFromScript([{ text: input.text }], {
          avatarId: input.avatarId,
          voiceId: input.voiceId,
          language: input.language,
          aspect: input.aspect,
          backgroundColor: input.backgroundColor,
          subtitles: input.subtitles,
        });
        title ??= titleFromText(input.text);
      } else if (input.type === 'template') {
        const template = await loadTemplateSource(db, auth.workspaceId, locale, input.templateId);
        composition = cloneCompositionWithNewIds(template.composition);
        templateId = template.id;
        variables = input.variables;
        title ??= template.name;
      } else {
        composition = input.composition;
        variables = input.variables;
      }

      const row = await createDraftVideo(videoService, {
        workspaceId: auth.workspaceId,
        userId: null,
        title: title ?? UNTITLED[locale],
        composition: withVariableValues(composition, variables),
        source: 'api',
        templateId,
      });
      if (!body.render) return toPublicVideo(row, fileUrl);

      try {
        // Same moderation, reference checks, plan limits and charging as a Studio render.
        const started = await startRender(
          { db, queues, providers },
          {
            workspaceId: auth.workspaceId,
            videoId: row.id,
            resolution: body.resolution,
            createdBy: null,
            variables,
          },
        );
        return await toPublicVideo(started.video, fileUrl);
      } catch (err) {
        // A request that fails leaves nothing behind: no draft, no files, no charge.
        await deleteVideo(videoService, auth.workspaceId, row.id).catch((cleanupError: unknown) => {
          request.log.error(
            { err: cleanupError, videoId: row.id },
            'could not remove the video of a failed request',
          );
        });
        throw err;
      }
    });

    defineV1Route(api.v1.listVideos, async ({ auth, query }) => {
      const rows = await db
        .select()
        .from(videos)
        .where(
          and(
            eq(videos.workspaceId, auth.workspaceId),
            query.status ? eq(videos.status, query.status) : undefined,
            cursorWhere(videos.createdAt, videos.id, query.cursor),
          ),
        )
        .orderBy(...cursorOrder(videos.createdAt, videos.id))
        .limit(query.limit + 1);
      const page = buildPage(rows, query.limit);
      return {
        items: await Promise.all(page.items.map((row) => toPublicVideo(row, fileUrl))),
        nextCursor: page.nextCursor,
      };
    });

    defineV1Route(api.v1.getVideo, async ({ auth, params }) => {
      return toPublicVideo(await findVideo(db, auth.workspaceId, params.videoId), fileUrl);
    });

    defineV1Route(api.v1.deleteVideo, async ({ auth, params }) => {
      await deleteVideo(videoService, auth.workspaceId, params.videoId);
      return OK;
    });

    defineV1Route(api.v1.uploadAsset, async ({ auth, request }) => {
      // Size is enforced while streaming; the type comes from the bytes, not from the client.
      const upload = await receiveUpload(request, {
        maxBytes: planLimits(auth.workspace).maxUploadBytes,
      });
      try {
        const fields = api.v1.uploadAsset.multipart.fields.parse(upload.fields);
        const row = await storeUploadedAsset(
          { db, providers },
          { workspace: auth.workspace, userId: null, upload, name: fields.name },
        );
        return await toAssetDto(fileUrl, row, null);
      } finally {
        await upload.cleanup();
      }
    });

    /* ---------- documentation, served by the API itself ---------- */
    if (config.OPENAPI_ENABLED) {
      app.get('/v1/openapi.json', { schema: { hide: true } }, async () =>
        buildV1Document(app.swagger(), { publicApiUrl: config.PUBLIC_API_URL }),
      );
      app.get('/v1/docs', { schema: { hide: true } }, async (_request, reply) =>
        reply.type('text/html; charset=utf-8').send(v1DocsPage()),
      );
    }
  },
});
