import { describe, expect, it } from 'vitest';
import { makeTemplate } from '@/features/avatars/kit/testing/fixtures';
import {
  NO_TEMPLATE_FILTERS,
  aspectShape,
  categoriesOf,
  countByTemplateKind,
  filterTemplates,
  hasActiveTemplateFilters,
  templateFiltersFromParams,
  templateFiltersToParams,
} from './templates';

const templates = [
  makeTemplate('explainer', { name: 'Vídeo explicativo', tags: ['paso a paso'] }),
  makeTemplate('vertical-ad', { name: 'Anuncio vertical', category: 'ad', aspect: '9:16' }),
  makeTemplate('greeting', { name: 'Saludo', category: 'greeting', aspect: '1:1' }),
  makeTemplate('mio', { kind: 'custom', name: 'Mi formación', category: 'training' }),
];

describe('template filters', () => {
  it('filters by kind, category, aspect and search', () => {
    expect(filterTemplates(templates, { ...NO_TEMPLATE_FILTERS, kind: 'custom' })).toHaveLength(1);
    expect(
      filterTemplates(templates, { ...NO_TEMPLATE_FILTERS, category: 'ad' }).map((t) => t.name),
    ).toEqual(['Anuncio vertical']);
    expect(
      filterTemplates(templates, { ...NO_TEMPLATE_FILTERS, aspect: '1:1' }).map((t) => t.name),
    ).toEqual(['Saludo']);
    expect(
      filterTemplates(templates, { ...NO_TEMPLATE_FILTERS, q: 'video PASO' }).map((t) => t.name),
    ).toEqual(['Vídeo explicativo']);
  });

  it('counts per kind for the other filters and lists used categories in order', () => {
    expect(countByTemplateKind(templates, NO_TEMPLATE_FILTERS)).toEqual({
      all: 4,
      builtin: 3,
      custom: 1,
    });
    expect(countByTemplateKind(templates, { ...NO_TEMPLATE_FILTERS, aspect: '16:9' })).toEqual({
      all: 2,
      builtin: 1,
      custom: 1,
    });
    expect(categoriesOf(templates)).toEqual(['explainer', 'ad', 'training', 'greeting']);
    expect(hasActiveTemplateFilters({ ...NO_TEMPLATE_FILTERS, kind: 'custom' })).toBe(false);
    expect(hasActiveTemplateFilters({ ...NO_TEMPLATE_FILTERS, aspect: '9:16' })).toBe(true);
  });

  it('round-trips through the URL and keeps other params', () => {
    const filters = {
      kind: 'builtin' as const,
      category: 'news' as const,
      aspect: '9:16' as const,
      q: 'boletín',
    };
    const params = templateFiltersToParams(filters, new URLSearchParams('template=builtin_news'));
    expect(params.get('template')).toBe('builtin_news');
    expect(templateFiltersFromParams(params)).toEqual(filters);
    expect(templateFiltersFromParams(new URLSearchParams('aspect=4:3&category=x'))).toEqual(
      NO_TEMPLATE_FILTERS,
    );
  });

  it('maps aspects to poster shapes', () => {
    expect(aspectShape('16:9')).toBe('aspect-video');
    expect(aspectShape('9:16')).toBe('aspect-[9/16]');
    expect(aspectShape('1:1')).toBe('aspect-square');
  });
});
