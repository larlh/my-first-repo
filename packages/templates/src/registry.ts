import {
  BuiltinTemplateSchema,
  CompositionSchema,
  collectAvatarIds,
  collectMediaRefs,
  collectVoiceIds,
  estimateCompositionDurationMs,
} from '@parlante/shared';
import type {
  AspectRatio,
  BuiltinTemplate,
  Template,
  TemplateCategory,
  TemplateDetail,
  UiLocale,
  VariableDef,
} from '@parlante/shared';
import { explainerTemplate } from './builtin/explainer';
import { greetingTemplate } from './builtin/greeting';
import { TEMPLATE_LOCALES, buildComposition } from './builtin/helpers';
import type { TemplateDefinition, TemplateLocale } from './builtin/helpers';
import { newsTemplate } from './builtin/news';
import { productTemplate } from './builtin/product';
import { quickTipTemplate } from './builtin/quick-tip';
import { teamWelcomeTemplate } from './builtin/team-welcome';
import { trainingTemplate } from './builtin/training';
import { verticalAdTemplate } from './builtin/vertical-ad';

/**
 * Registry of built-in templates. Owner: content.
 * Add a template = create `builtin/<slug>.ts` (see ./builtin/helpers.ts for the conventions)
 * and append it to this array. Ids are stable: never rename or remove a published one.
 *
 * Every template exists in Spanish and in English: same design, script, on-screen texts,
 * variable names and example values in that language. All functions take the language as an
 * optional last argument and default to Spanish (the product default).
 */
const DEFINITIONS: readonly TemplateDefinition[] = [
  explainerTemplate,
  verticalAdTemplate,
  trainingTemplate,
  newsTemplate,
  productTemplate,
  greetingTemplate,
  quickTipTemplate,
  teamWelcomeTemplate,
];

export { TEMPLATE_LOCALES };
export type { TemplateDefinition, TemplateLocale };

function materialise(def: TemplateDefinition, locale: TemplateLocale): BuiltinTemplate {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    category: def.category,
    tags: def.tags[locale],
    composition: buildComposition(def, locale),
  };
}

const BUILT: Record<TemplateLocale, readonly BuiltinTemplate[]> = {
  es: DEFINITIONS.map((def) => materialise(def, 'es')),
  en: DEFINITIONS.map((def) => materialise(def, 'en')),
};

const byId: Record<TemplateLocale, Map<string, BuiltinTemplate>> = {
  es: new Map(BUILT.es.map((t) => [t.id, t])),
  en: new Map(BUILT.en.map((t) => [t.id, t])),
};

const localeOf = (locale: UiLocale | undefined): TemplateLocale => (locale === 'en' ? 'en' : 'es');

/** Ids of every built-in template, in catalogue order. */
export const BUILTIN_TEMPLATE_IDS: readonly string[] = DEFINITIONS.map((def) => def.id);

/** Deep copies of every built-in template, with script and texts in `locale`. */
export function listBuiltinTemplates(locale: UiLocale = 'es'): BuiltinTemplate[] {
  return BUILT[localeOf(locale)].map((template) => structuredClone(template));
}

/** Deep copy (callers can mutate the composition freely), with script and texts in `locale`. */
export function getBuiltinTemplate(id: string, locale: UiLocale = 'es'): BuiltinTemplate | null {
  const found = byId[localeOf(locale)].get(id);
  return found ? structuredClone(found) : null;
}

/** Path of the poster route of a built-in template (`api.templates.thumbnail`). */
export function builtinTemplateThumbnailPath(id: string): string {
  return `/api/templates/${id}/thumbnail`;
}

/**
 * API list item for a built-in template in the given UI language. For registered templates the
 * tags come from the registry in that language; any other object is mapped as given.
 */
export function toTemplateDto(template: BuiltinTemplate, locale: UiLocale = 'es'): Template {
  const registered = byId[localeOf(locale)].get(template.id);
  return {
    id: template.id,
    kind: 'builtin',
    workspaceId: null,
    name: template.name[locale],
    description: template.description[locale],
    category: template.category,
    aspect: template.composition.canvas.aspect,
    tags: [...(registered?.tags ?? template.tags)],
    sceneCount: template.composition.scenes.length,
    thumbnailUrl: registered ? builtinTemplateThumbnailPath(template.id) : null,
    createdAt: null,
  };
}

/**
 * API detail of a built-in template. The composition is the one written for `locale` (script,
 * on-screen texts and variables in that language) whichever language `template` was read in.
 */
export function toTemplateDetailDto(
  template: BuiltinTemplate,
  locale: UiLocale = 'es',
): TemplateDetail {
  const registered = byId[localeOf(locale)].get(template.id);
  return {
    ...toTemplateDto(template, locale),
    composition: structuredClone((registered ?? template).composition),
  };
}

/** What a gallery needs to describe a template without opening its composition. */
export interface BuiltinTemplateMeta {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  /** Format of the canvas. */
  aspect: AspectRatio;
  sceneCount: number;
  /**
   * Duration estimated from the example script with `estimateCompositionDurationMs` (the same
   * estimate used for credits before rendering). The real length depends on the voice.
   */
  estimatedDurationMs: number;
  /** Languages the example script is written in. */
  languages: readonly TemplateLocale[];
  tags: string[];
  /** `{{variables}}` the user personalises, with label and example value in `locale`. */
  variables: VariableDef[];
  avatarIds: string[];
  voiceIds: string[];
  /** Stock assets used: backgrounds and the music bed. */
  stockIds: string[];
  /** Stock id of the music bed, or null. */
  musicStockId: string | null;
  thumbnailUrl: string;
}

function metaOf(template: BuiltinTemplate, locale: TemplateLocale): BuiltinTemplateMeta {
  const { composition } = template;
  const stockIds = collectMediaRefs(composition).flatMap((use) =>
    use.ref.source === 'stock' ? [use.ref.stockId] : [],
  );
  const music = composition.music?.src;
  return {
    id: template.id,
    name: template.name[locale],
    description: template.description[locale],
    category: template.category,
    aspect: composition.canvas.aspect,
    sceneCount: composition.scenes.length,
    estimatedDurationMs: estimateCompositionDurationMs(composition),
    languages: TEMPLATE_LOCALES,
    tags: [...template.tags],
    variables: structuredClone(composition.variables),
    avatarIds: collectAvatarIds(composition),
    voiceIds: collectVoiceIds(composition),
    stockIds: [...new Set(stockIds)],
    musicStockId: music?.source === 'stock' ? music.stockId : null,
    thumbnailUrl: builtinTemplateThumbnailPath(template.id),
  };
}

/** Metadata (format, estimated duration, variables, references) of every built-in template. */
export function listBuiltinTemplateMeta(locale: UiLocale = 'es'): BuiltinTemplateMeta[] {
  const lang = localeOf(locale);
  return BUILT[lang].map((template) => metaOf(template, lang));
}

export function getBuiltinTemplateMeta(
  id: string,
  locale: UiLocale = 'es',
): BuiltinTemplateMeta | null {
  const lang = localeOf(locale);
  const found = byId[lang].get(id);
  return found ? metaOf(found, lang) : null;
}

/** Throws when any built-in template is invalid (run by the package tests). */
export function validateBuiltinTemplates(): void {
  for (const locale of TEMPLATE_LOCALES) {
    const ids = new Set<string>();
    for (const template of BUILT[locale]) {
      BuiltinTemplateSchema.parse(template);
      CompositionSchema.parse(template.composition);
      if (ids.has(template.id)) throw new Error(`Duplicate template id ${template.id}`);
      ids.add(template.id);
    }
  }
}
