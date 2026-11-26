import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parityProblems, usageProblems } from '../videos/testing/i18nScan';
import manifest from './index';
import { translations } from './i18n';

const here = dirname(fileURLToPath(import.meta.url));

describe('assets translations', () => {
  it('has the same keys, variables and no empty strings in Spanish and English', () => {
    expect(parityProblems(translations.es, translations.en)).toEqual([]);
  });

  it('defines every key the feature uses', () => {
    expect(usageProblems(here, 'assets', translations.es)).toEqual([]);
  });

  it('registers the library route and its navigation entry', () => {
    expect(manifest.id).toBe('assets');
    expect(manifest.i18n).toBe(translations);
    // Plus the development-only picker playground (vitest runs in dev mode).
    expect(manifest.routes.map((route) => route.path)).toEqual(['/assets', '/dev/asset-picker']);
    expect(manifest.nav?.[0]).toMatchObject({ to: '/assets', section: 'library' });
  });
});
