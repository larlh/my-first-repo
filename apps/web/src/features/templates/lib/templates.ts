import { AspectRatioSchema, TEMPLATE_CATEGORIES } from '@parlante/shared';
import type { AspectRatio, Template, TemplateCategory } from '@parlante/shared';

/* Filters of the template gallery (client side: the list is small and counts stay visible).
 * State lives in the URL. */

export const TEMPLATE_KINDS = ['all', 'builtin', 'custom'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export interface TemplateFilters {
  kind: TemplateKind;
  category: TemplateCategory | null;
  aspect: AspectRatio | null;
  q: string;
}

export const NO_TEMPLATE_FILTERS: TemplateFilters = {
  kind: 'all',
  category: null,
  aspect: null,
  q: '',
};

export function hasActiveTemplateFilters(filters: TemplateFilters): boolean {
  return filters.category !== null || filters.aspect !== null || filters.q.trim() !== '';
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

function matchesRest(template: Template, filters: TemplateFilters): boolean {
  if (filters.category !== null && template.category !== filters.category) return false;
  if (filters.aspect !== null && template.aspect !== filters.aspect) return false;
  const words = normalize(filters.q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalize([template.name, template.description, ...template.tags].join(' '));
  return words.every((word) => haystack.includes(word));
}

export function filterTemplates(
  templates: readonly Template[],
  filters: TemplateFilters,
): Template[] {
  return templates.filter(
    (template) =>
      (filters.kind === 'all' || template.kind === filters.kind) && matchesRest(template, filters),
  );
}

export function countByTemplateKind(
  templates: readonly Template[],
  filters: TemplateFilters,
): Record<TemplateKind, number> {
  const counts: Record<TemplateKind, number> = { all: 0, builtin: 0, custom: 0 };
  for (const template of templates) {
    if (!matchesRest(template, filters)) continue;
    counts.all += 1;
    counts[template.kind] += 1;
  }
  return counts;
}

/** Categories that have at least one template, in the product's order. */
export function categoriesOf(templates: readonly Template[]): TemplateCategory[] {
  return TEMPLATE_CATEGORIES.filter((category) =>
    templates.some((template) => template.category === category),
  );
}

/** Tailwind aspect class of a poster inside its card. */
export function aspectShape(aspect: AspectRatio): string {
  return aspect === '9:16' ? 'aspect-[9/16]' : aspect === '1:1' ? 'aspect-square' : 'aspect-video';
}

/* ---------- URL ---------- */

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function templateFiltersFromParams(params: URLSearchParams): TemplateFilters {
  return {
    kind: pick(params.get('kind'), TEMPLATE_KINDS) ?? 'all',
    category: pick(params.get('category'), TEMPLATE_CATEGORIES),
    aspect: pick(params.get('aspect'), AspectRatioSchema.options),
    q: params.get('q') ?? '',
  };
}

export function templateFiltersToParams(
  filters: TemplateFilters,
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string | null) => {
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
  };
  set('kind', filters.kind === 'all' ? null : filters.kind);
  set('category', filters.category);
  set('aspect', filters.aspect);
  set('q', filters.q.trim() === '' ? null : filters.q);
  return next;
}
