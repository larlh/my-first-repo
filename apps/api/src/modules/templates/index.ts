import { AppError, OK, api, cloneCompositionWithNewIds } from '@parlante/shared';
import { and, eq, templates } from '@parlante/db';
import { getBuiltinTemplate } from '@parlante/templates';
import { sendPublicBinary } from '../../lib/binary';
import { defineRoute } from '../../lib/define-route';
import { defineModule } from '../../lib/modules';
import { renderPoster } from '../../lib/poster';
import { createDraftVideo, posterDocument, toVideoDto, videoDeps } from '../videos/service';
import { withDefaultVoices } from '../voices/defaults';
import {
  deleteCustomTemplate,
  findCustomTemplate,
  getTemplateDetail,
  isBuiltinTemplateId,
  listTemplateCatalog,
  loadTemplateSource,
  templateDeps,
  toCustomTemplateDto,
} from './service';

/** Width of the posters of built-in templates (cards of the gallery, also on HiDPI screens). */
const BUILTIN_POSTER_WIDTH = 640;

/** Built-in templates cannot be changed: unknown ones are 404, existing ones 403. */
function assertCustom(templateId: string): void {
  if (!isBuiltinTemplateId(templateId)) return;
  if (!getBuiltinTemplate(templateId)) throw AppError.notFound('Template');
  throw AppError.forbidden('Built-in templates are read-only');
}

export default defineModule({
  name: 'templates',
  register(app) {
    const deps = templateDeps(app);
    const { db, fileUrl } = deps;
    const videos = videoDeps(app);

    /**
     * Posters of built-in templates never change while the process lives (the templates are
     * code): each is rendered once, on first request. A failed render is not remembered.
     */
    const posters = new Map<string, Promise<Buffer>>();
    function builtinPoster(templateId: string): Promise<Buffer> {
      const cached = posters.get(templateId);
      if (cached) return cached;
      const template = getBuiltinTemplate(templateId);
      if (!template) return Promise.reject(AppError.notFound('Template'));
      const rendering = renderPoster(deps, posterDocument(template.composition), {
        workspaceId: null,
        width: BUILTIN_POSTER_WIDTH,
      });
      posters.set(templateId, rendering);
      void rendering.catch(() => posters.delete(templateId));
      return rendering;
    }

    defineRoute(app, api.templates.list, async ({ auth, query }) => {
      return {
        items: await listTemplateCatalog(deps, auth.workspaceId, auth.user.locale, query),
      };
    });

    defineRoute(app, api.templates.get, async ({ auth, params }) => {
      return getTemplateDetail(deps, auth.workspaceId, auth.user.locale, params.templateId);
    });

    defineRoute(app, api.templates.thumbnail, async ({ params, reply }) => {
      return sendPublicBinary(reply, {
        bytes: await builtinPoster(params.templateId),
        mimeType: 'image/jpeg',
      });
    });

    defineRoute(app, api.templates.use, async ({ auth, params, body }) => {
      const template = await loadTemplateSource(
        db,
        auth.workspaceId,
        auth.user.locale,
        params.templateId,
      );
      const row = await createDraftVideo(videos, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        title: body.title ?? template.name,
        // Fresh ids: videos created from the same template never share scene or layer ids.
        // A built-in template starts with the voices this server recommends (voices/defaults.ts).
        composition:
          template.kind === 'builtin'
            ? await withDefaultVoices(
                { db, providers: app.providers },
                auth.workspaceId,
                cloneCompositionWithNewIds(template.composition),
              )
            : cloneCompositionWithNewIds(template.composition),
        source: 'template',
        templateId: template.id,
      });
      return toVideoDto(videos, row);
    });

    defineRoute(app, api.templates.update, async ({ auth, params, body }) => {
      assertCustom(params.templateId);
      const current = await findCustomTemplate(db, auth.workspaceId, params.templateId);
      const [updated] = await db
        .update(templates)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          updatedAt: new Date(),
        })
        // The workspace filter is repeated on the write: never update by id alone.
        .where(and(eq(templates.id, current.id), eq(templates.workspaceId, auth.workspaceId)))
        .returning();
      if (!updated) throw AppError.notFound('Template');
      return toCustomTemplateDto(fileUrl, updated);
    });

    defineRoute(app, api.templates.remove, async ({ auth, params }) => {
      assertCustom(params.templateId);
      await deleteCustomTemplate(deps, auth.workspaceId, params.templateId);
      return OK;
    });
  },
});
