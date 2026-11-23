import { AppError, COMPOSITION_LIMITS, newId, syncVariableDefs } from '@parlante/shared';
import type {
  AspectRatio,
  Composition,
  Providers,
  Template,
  TemplateCategory,
  TemplateDetail,
  UiLocale,
} from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { and, desc, eq, templates } from '@parlante/db';
import type { Db, TemplateRow } from '@parlante/db';
import type { FileUrlBuilder } from '@parlante/jobs';
import type { FastifyInstance } from 'fastify';
import {
  getBuiltinTemplate,
  listBuiltinTemplates,
  toTemplateDetailDto,
  toTemplateDto,
} from '@parlante/templates';
import { iso } from '../../lib/dto';
import { renderPoster } from '../../lib/poster';
import { posterDocument } from '../videos/service';
import { lockWorkspace } from '../workspaces/service';

/* -------------------------------------------------------------------------------------------
 * Template catalogue shared by `/api/templates`, `POST /api/videos` (templateId),
 * `POST /api/videos/:id/save-as-template` and the public API v1:
 *   builtin_<slug>  built-in templates, data of @parlante/templates (Spanish and English)
 *   tpl_…           custom templates of a workspace (table `templates`)
 * ----------------------------------------------------------------------------------------- */

export interface TemplateDeps {
  db: Db;
  providers: Pick<Providers, 'storage'>;
  fileUrl: FileUrlBuilder;
  /** `config.PUBLIC_API_URL`: posters of built-in templates are served by this API. */
  publicApiUrl: string;
}

/** Dependencies of the template catalogue, taken from the app. */
export function templateDeps(app: FastifyInstance): TemplateDeps {
  return {
    db: app.db,
    providers: app.providers,
    fileUrl: app.fileUrl,
    publicApiUrl: app.config.PUBLIC_API_URL,
  };
}

/** A workspace keeps its custom templates in one unpaginated list, so their number is bounded. */
export const MAX_CUSTOM_TEMPLATES = 200;

export interface TemplateFilters {
  kind?: Template['kind'] | undefined;
  category?: TemplateCategory | undefined;
  aspect?: AspectRatio | undefined;
  /** Free text over name, description and tags (case and accent insensitive). */
  q?: string | undefined;
}

export const isBuiltinTemplateId = (templateId: string): boolean =>
  templateId.startsWith('builtin_');

const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function matches(template: Template, filters: TemplateFilters): boolean {
  if (filters.category && template.category !== filters.category) return false;
  if (filters.aspect && template.aspect !== filters.aspect) return false;
  const q = filters.q ? fold(filters.q.trim()) : '';
  if (q === '') return true;
  return fold([template.name, template.description, ...template.tags].join(' ')).includes(q);
}

/** Built-in posters are served by `GET /api/templates/:templateId/thumbnail` of THIS API. */
function absolute(publicApiUrl: string, pathOrUrl: string | null): string | null {
  if (!pathOrUrl || !pathOrUrl.startsWith('/')) return pathOrUrl;
  return `${publicApiUrl.replace(/\/+$/, '')}${pathOrUrl}`;
}

function builtinDto(deps: Pick<TemplateDeps, 'publicApiUrl'>, dto: Template): Template {
  return { ...dto, thumbnailUrl: absolute(deps.publicApiUrl, dto.thumbnailUrl) };
}

/** Row → DTO in ONE place for custom templates; the poster only as a signed URL. */
export async function toCustomTemplateDto(
  fileUrl: FileUrlBuilder,
  row: TemplateRow,
): Promise<Template> {
  return {
    id: row.id,
    kind: 'custom',
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    category: row.category,
    aspect: row.aspect,
    tags: row.tags,
    sceneCount: row.composition.scenes.length,
    thumbnailUrl: await fileUrl(row.thumbnailKey),
    createdAt: iso(row.createdAt),
  };
}

export async function toCustomTemplateDetailDto(
  fileUrl: FileUrlBuilder,
  row: TemplateRow,
): Promise<TemplateDetail> {
  return { ...(await toCustomTemplateDto(fileUrl, row)), composition: row.composition };
}

/** A custom template of THIS workspace or 404 (a foreign id looks exactly like a missing one). */
export async function findCustomTemplate(
  db: Db,
  workspaceId: string,
  templateId: string,
): Promise<TemplateRow> {
  const [row] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.id, templateId), eq(templates.workspaceId, workspaceId)));
  if (!row) throw AppError.notFound('Template');
  return row;
}

/**
 * Built-in templates (catalogue order, texts in `locale`) followed by the custom templates of
 * the workspace, newest first.
 */
export async function listTemplateCatalog(
  deps: TemplateDeps,
  workspaceId: string,
  locale: UiLocale,
  filters: TemplateFilters = {},
): Promise<Template[]> {
  const items: Template[] = [];
  if (filters.kind !== 'custom') {
    for (const template of listBuiltinTemplates(locale)) {
      const dto = builtinDto(deps, toTemplateDto(template, locale));
      if (matches(dto, filters)) items.push(dto);
    }
  }
  if (filters.kind !== 'builtin') {
    const rows = await deps.db
      .select()
      .from(templates)
      .where(
        and(
          // Workspace scope: another workspace's templates are never listed.
          eq(templates.workspaceId, workspaceId),
          filters.category ? eq(templates.category, filters.category) : undefined,
          filters.aspect ? eq(templates.aspect, filters.aspect) : undefined,
        ),
      )
      .orderBy(desc(templates.createdAt), desc(templates.id))
      .limit(MAX_CUSTOM_TEMPLATES);
    for (const row of rows) {
      const dto = await toCustomTemplateDto(deps.fileUrl, row);
      if (matches(dto, filters)) items.push(dto);
    }
  }
  return items;
}

/** One template with its composition, or 404. */
export async function getTemplateDetail(
  deps: TemplateDeps,
  workspaceId: string,
  locale: UiLocale,
  templateId: string,
): Promise<TemplateDetail> {
  if (isBuiltinTemplateId(templateId)) {
    const template = getBuiltinTemplate(templateId, locale);
    if (!template) throw AppError.notFound('Template');
    const detail = toTemplateDetailDto(template, locale);
    return { ...detail, thumbnailUrl: absolute(deps.publicApiUrl, detail.thumbnailUrl) };
  }
  return toCustomTemplateDetailDto(
    deps.fileUrl,
    await findCustomTemplate(deps.db, workspaceId, templateId),
  );
}

export interface TemplateSource {
  id: string;
  kind: Template['kind'];
  name: string;
  /** A private copy: callers may mutate it. Scene and layer ids are still the template's. */
  composition: Composition;
}

/**
 * What "create a video from this template" needs, for a built-in (in `locale`) or a custom
 * template of the workspace. 404 when it does not exist or belongs to another workspace.
 */
export async function loadTemplateSource(
  db: Db,
  workspaceId: string,
  locale: UiLocale,
  templateId: string,
): Promise<TemplateSource> {
  if (isBuiltinTemplateId(templateId)) {
    const template = getBuiltinTemplate(templateId, locale);
    if (!template) throw AppError.notFound('Template');
    return {
      id: template.id,
      kind: 'builtin',
      name: template.name[locale],
      composition: template.composition,
    };
  }
  const row = await findCustomTemplate(db, workspaceId, templateId);
  return {
    id: row.id,
    kind: 'custom',
    name: row.name,
    composition: structuredClone(row.composition),
  };
}

export interface CreateCustomTemplateInput {
  workspaceId: string;
  /** null for API-key requests. */
  userId: string | null;
  name: string;
  description: string;
  category: TemplateCategory;
  /** Document to keep. The caller passes a copy with fresh ids. */
  composition: Composition;
  tags?: string[];
}

/**
 * "Save as template": stores the document as a custom template of the workspace with its
 * declared variables reconciled with the `{{placeholders}}` actually used, and renders its
 * poster (first scene, same renderer as the Studio) to `storageKeys.templateThumb`.
 * The poster is best effort: a template without thumbnail is still a valid template.
 */
export async function createCustomTemplate(
  deps: Pick<TemplateDeps, 'db' | 'providers'>,
  input: CreateCustomTemplateInput,
  onPosterError?: (error: unknown) => void,
): Promise<TemplateRow> {
  const { db, providers } = deps;
  // Declared variables follow the placeholders in use (unless that would exceed the limit of
  // the document format; then the declaration is kept as it was).
  const variables = syncVariableDefs(input.composition);
  const composition: Composition =
    variables.length <= COMPOSITION_LIMITS.maxVariables
      ? { ...input.composition, variables }
      : input.composition;
  const id = newId('template');

  let thumbnailKey: string | null = null;
  try {
    const poster = await renderPoster({ db, providers }, posterDocument(composition), {
      workspaceId: input.workspaceId,
    });
    thumbnailKey = storageKeys.templateThumb(input.workspaceId, id);
    await providers.storage.put(thumbnailKey, poster, { contentType: 'image/jpeg' });
  } catch (err) {
    thumbnailKey = null;
    onPosterError?.(err);
  }

  try {
    const now = new Date();
    return await db.transaction(async (tx) => {
      // Count and insert under the workspace lock: concurrent requests cannot exceed the cap.
      await lockWorkspace(tx, input.workspaceId);
      const existing = await tx.$count(templates, eq(templates.workspaceId, input.workspaceId));
      if (existing >= MAX_CUSTOM_TEMPLATES) {
        throw new AppError(
          'PLAN_LIMIT_EXCEEDED',
          `A workspace can have at most ${MAX_CUSTOM_TEMPLATES} custom templates`,
          { limit: 'maxCustomTemplates', max: MAX_CUSTOM_TEMPLATES, value: existing + 1 },
        );
      }
      const [row] = await tx
        .insert(templates)
        .values({
          id,
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description,
          category: input.category,
          aspect: composition.canvas.aspect,
          tags: input.tags ?? [],
          composition,
          thumbnailKey,
          createdBy: input.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error('Insert returned no row');
      return row;
    });
  } catch (err) {
    await providers.storage
      .deletePrefix(storageKeys.templatePrefix(input.workspaceId, id))
      .catch(() => {
        // Best effort: the original error is the one worth reporting.
      });
    throw err;
  }
}

/**
 * Delete a custom template of the workspace with its files. The files go first, inside the
 * transaction: if storage fails the row stays and the request can be retried.
 */
export async function deleteCustomTemplate(
  deps: Pick<TemplateDeps, 'db' | 'providers'>,
  workspaceId: string,
  templateId: string,
): Promise<void> {
  const scope = and(eq(templates.id, templateId), eq(templates.workspaceId, workspaceId));
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.select({ id: templates.id }).from(templates).where(scope).for('update');
    if (!row) throw AppError.notFound('Template');
    await deps.providers.storage.deletePrefix(storageKeys.templatePrefix(workspaceId, templateId));
    await tx.delete(templates).where(scope);
  });
}
