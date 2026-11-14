import { BuiltinTemplateSchema, CompositionSchema } from '@parlante/shared';
import type { BuiltinTemplate, Template, TemplateDetail, UiLocale } from '@parlante/shared';
import { explainerTemplate } from './builtin/explainer';

/**
 * Registry of built-in templates. Owner: content.
 * Add a template = create `builtin/<slug>.ts` and append it to this array.
 */
const BUILTIN: readonly BuiltinTemplate[] = [explainerTemplate];

const byId = new Map(BUILTIN.map((t) => [t.id, t]));

export function listBuiltinTemplates(): BuiltinTemplate[] {
  return [...BUILTIN];
}

/** Deep copy, so callers can mutate the composition freely. */
export function getBuiltinTemplate(id: string): BuiltinTemplate | null {
  const found = byId.get(id);
  return found ? structuredClone(found) : null;
}

/** API list item for a built-in template in the given UI language. */
export function toTemplateDto(template: BuiltinTemplate, locale: UiLocale = 'es'): Template {
  return {
    id: template.id,
    kind: 'builtin',
    workspaceId: null,
    name: template.name[locale],
    description: template.description[locale],
    category: template.category,
    aspect: template.composition.canvas.aspect,
    tags: template.tags,
    sceneCount: template.composition.scenes.length,
    thumbnailUrl: null,
    createdAt: null,
  };
}

export function toTemplateDetailDto(
  template: BuiltinTemplate,
  locale: UiLocale = 'es',
): TemplateDetail {
  return { ...toTemplateDto(template, locale), composition: structuredClone(template.composition) };
}

/** Throws when any built-in template is invalid (run by the package tests). */
export function validateBuiltinTemplates(): void {
  const ids = new Set<string>();
  for (const template of BUILTIN) {
    BuiltinTemplateSchema.parse(template);
    CompositionSchema.parse(template.composition);
    if (ids.has(template.id)) throw new Error(`Duplicate template id ${template.id}`);
    ids.add(template.id);
  }
}
