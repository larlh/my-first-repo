import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parityProblems, usageProblems } from '@/features/videos/testing/i18nScan';
import manifest from './index';
import { translations } from './i18n';

const here = dirname(fileURLToPath(import.meta.url));

describe('photo-avatar translations', () => {
  it('has the same keys, variables and no empty strings in Spanish and English', () => {
    expect(parityProblems(translations.es, translations.en)).toEqual([]);
  });

  it('defines every key the feature uses', () => {
    expect(usageProblems(here, 'photo-avatar', translations.es)).toEqual([]);
  });

  it('registers both languages in the manifest under its own namespace', () => {
    expect(manifest.id).toBe('photo-avatar');
    expect(manifest.i18n).toBe(translations);
  });
});
