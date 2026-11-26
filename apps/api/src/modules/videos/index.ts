import { isDeepStrictEqual } from 'node:util';
import {
  AppError,
  OK,
  api,
  applyBrandKit,
  buildPage,
  cloneCompositionWithNewIds,
  createComposition,
} from '@parlante/shared';
import type { Composition, UiLocale } from '@parlante/shared';
import {
  and,
  assets,
  brandKits,
  cursorOrder,
  cursorWhere,
  desc,
  eq,
  ilike,
  renderJobs,
  sql,
  videos,
} from '@parlante/db';
import type { VideoRow } from '@parlante/db';
import { startRender } from '@parlante/jobs';
import { defineRoute } from '../../lib/define-route';
import { defineModule } from '../../lib/modules';
import { withDefaultVoices } from '../voices/defaults';
import {
  createCustomTemplate,
  loadTemplateSource,
  toCustomTemplateDetailDto,
} from '../templates/service';
import {
  MAX_TITLE_LENGTH,
  cancelRender,
  createDraftVideo,
  deleteVideo,
  findVideo,
  loadVideoExtras,
  refreshDraftPoster,
  restoreDraftPoster,
  toRenderJobDto,
  toVideoDto,
  toVideoSummaryDto,
  videoDeps,
} from './service';

/** `%` and `_` typed by the user are literal characters, not LIKE wildcards. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const DEFAULT_TITLE: Record<UiLocale, string> = {
  es: 'Vídeo sin título',
  en: 'Untitled video',
};
const FIRST_SCENE_NAME: Record<UiLocale, string> = { es: 'Escena 1', en: 'Scene 1' };
const COPY_SUFFIX: Record<UiLocale, string> = { es: ' (copia)', en: ' (copy)' };

export default defineModule({
  name: 'videos',
  register(app) {
    const deps = videoDeps(app);
    const { db, fileUrl } = deps;

    /**
     * Store a new title and/or composition as ONE revision. The UPDATE repeats the revision
     * it read, so two writers can never both win: the loser gets REVISION_CONFLICT (when it
     * sent `baseRevision`) or is applied on top of the fresh row (last write wins).
     */
    async function saveChanges(
      current: VideoRow,
      changes: { title?: string | undefined; composition?: Composition | undefined },
      baseRevision: number | undefined,
    ): Promise<VideoRow> {
      let row = current;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (baseRevision !== undefined && baseRevision !== row.revision) {
          throw new AppError(
            'REVISION_CONFLICT',
            'This video was changed somewhere else. Reload it before saving',
            { currentRevision: row.revision },
          );
        }
        const title = changes.title !== undefined && changes.title !== row.title;
        const composition =
          changes.composition !== undefined &&
          !isDeepStrictEqual(changes.composition, row.composition);
        // Nothing to store: an identical autosave must not make the render look outdated.
        if (!title && !composition) return row;

        const next = composition && changes.composition ? changes.composition : row.composition;
        const thumbnailKey = composition
          ? await refreshDraftPoster(deps, row, next)
          : row.thumbnailKey;
        const [updated] = await db
          .update(videos)
          .set({
            ...(title ? { title: changes.title } : {}),
            ...(composition ? { composition: next, aspect: next.canvas.aspect } : {}),
            thumbnailKey,
            revision: sql`${videos.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(videos.id, row.id),
              eq(videos.workspaceId, row.workspaceId),
              eq(videos.revision, row.revision),
            ),
          )
          .returning();
        if (updated) return updated;
        // Someone else saved in between (or deleted the video → 404).
        row = await findVideo(db, row.workspaceId, row.id);
        if (composition) await restoreDraftPoster(deps, row);
      }
      throw new AppError(
        'REVISION_CONFLICT',
        'This video is being changed somewhere else. Reload it before saving',
        { currentRevision: row.revision },
      );
    }

    defineRoute(app, api.videos.list, async ({ auth, query }) => {
      const rows = await db
        .select()
        .from(videos)
        .where(
          and(
            eq(videos.workspaceId, auth.workspaceId),
            query.status ? eq(videos.status, query.status) : undefined,
            query.batchJobId ? eq(videos.batchJobId, query.batchJobId) : undefined,
            query.q ? ilike(videos.title, likePattern(query.q)) : undefined,
            cursorWhere(videos.createdAt, videos.id, query.cursor),
          ),
        )
        .orderBy(...cursorOrder(videos.createdAt, videos.id))
        .limit(query.limit + 1);
      const page = buildPage(rows, query.limit);
      const extras = await loadVideoExtras(db, auth.workspaceId, page.items);
      return {
        items: await Promise.all(
          page.items.map((row) => toVideoSummaryDto(fileUrl, row, extras.get(row.id))),
        ),
        nextCursor: page.nextCursor,
      };
    });

    defineRoute(app, api.videos.create, async ({ auth, body }) => {
      const locale = auth.user.locale;
      let title = body.title;
      let composition: Composition;
      let templateId: string | null = null;
      if (body.templateId) {
        const template = await loadTemplateSource(db, auth.workspaceId, locale, body.templateId);
        composition = cloneCompositionWithNewIds(template.composition);
        // A built-in template is written with the always-available local voices: a video
        // created from it starts with the voices this server recommends (voices/defaults.ts).
        if (template.kind === 'builtin') {
          composition = await withDefaultVoices(
            { db, providers: app.providers },
            auth.workspaceId,
            composition,
          );
        }
        templateId = template.id;
        title ??= template.name;
      } else if (body.composition) {
        composition = body.composition;
      } else {
        composition = createComposition({
          ...(body.aspect ? { aspect: body.aspect } : {}),
          scenes: [{ name: FIRST_SCENE_NAME[locale] }],
        });
      }
      const row = await createDraftVideo(deps, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        title: title ?? DEFAULT_TITLE[locale],
        composition,
        source: templateId ? 'template' : (body.source ?? 'studio'),
        templateId,
      });
      return toVideoDto(deps, row);
    });

    defineRoute(app, api.videos.get, async ({ auth, params }) => {
      return toVideoDto(deps, await findVideo(db, auth.workspaceId, params.videoId));
    });

    defineRoute(app, api.videos.update, async ({ auth, params, body }) => {
      const current = await findVideo(db, auth.workspaceId, params.videoId);
      const row = await saveChanges(
        current,
        { title: body.title, composition: body.composition },
        body.baseRevision,
      );
      return toVideoDto(deps, row);
    });

    defineRoute(app, api.videos.remove, async ({ auth, params }) => {
      await deleteVideo(deps, auth.workspaceId, params.videoId);
      return OK;
    });

    defineRoute(app, api.videos.duplicate, async ({ auth, params }) => {
      const source = await findVideo(db, auth.workspaceId, params.videoId);
      const suffix = COPY_SUFFIX[auth.user.locale];
      const row = await createDraftVideo(deps, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        title: `${source.title.slice(0, MAX_TITLE_LENGTH - suffix.length)}${suffix}`,
        composition: cloneCompositionWithNewIds(source.composition),
        source: 'studio',
        templateId: source.templateId,
      });
      return toVideoDto(deps, row);
    });

    defineRoute(
      app,
      api.videos.render,
      async ({ auth, params, body, app: { queues, providers } }) => {
        // Moderation, plan limits, reference checks, charging and queueing all live in
        // `startRender` (shared with the public API and the batch job).
        const started = await startRender(
          { db, queues, providers },
          {
            workspaceId: auth.workspaceId,
            videoId: params.videoId,
            resolution: body.resolution,
            createdBy: auth.userId,
          },
        );
        return {
          video: await toVideoDto(deps, started.video),
          renderJob: toRenderJobDto(started.renderJob),
        };
      },
    );

    defineRoute(app, api.videos.cancelRender, async ({ auth, params }) => {
      const video = await findVideo(db, auth.workspaceId, params.videoId);
      return toVideoDto(deps, await cancelRender(deps, video));
    });

    defineRoute(app, api.videos.renderJobs, async ({ auth, params }) => {
      await findVideo(db, auth.workspaceId, params.videoId);
      const rows = await db
        .select()
        .from(renderJobs)
        .where(
          and(eq(renderJobs.videoId, params.videoId), eq(renderJobs.workspaceId, auth.workspaceId)),
        )
        .orderBy(desc(renderJobs.createdAt), desc(renderJobs.id))
        .limit(200);
      return { items: rows.map(toRenderJobDto) };
    });

    defineRoute(app, api.videos.saveAsTemplate, async ({ auth, params, body }) => {
      const video = await findVideo(db, auth.workspaceId, params.videoId);
      const row = await createCustomTemplate(
        deps,
        {
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          name: body.name,
          description: body.description,
          category: body.category,
          // Its own ids: the template and the video never share scene or layer ids.
          composition: cloneCompositionWithNewIds(video.composition),
        },
        (err) => {
          app.log.warn({ err, videoId: video.id }, 'template poster could not be rendered');
        },
      );
      return toCustomTemplateDetailDto(fileUrl, row);
    });

    defineRoute(app, api.videos.applyBrandKit, async ({ auth, params, body }) => {
      const video = await findVideo(db, auth.workspaceId, params.videoId);
      const [kit] = await db
        .select()
        .from(brandKits)
        .where(and(eq(brandKits.id, body.brandKitId), eq(brandKits.workspaceId, auth.workspaceId)));
      if (!kit) throw AppError.notFound('Brand kit');
      // The logo is only applied while it still is an image of this workspace.
      const [logo] = kit.logoAssetId
        ? await db
            .select({ id: assets.id })
            .from(assets)
            .where(
              and(
                eq(assets.id, kit.logoAssetId),
                eq(assets.workspaceId, auth.workspaceId),
                eq(assets.kind, 'image'),
              ),
            )
        : [];
      const composition = applyBrandKit(video.composition, {
        id: kit.id,
        logoAssetId: logo?.id ?? null,
        colors: kit.colors,
        fonts: kit.fonts,
      });
      return toVideoDto(deps, await saveChanges(video, { composition }, undefined));
    });
  },
});
