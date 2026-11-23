import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER_REASONS, ROLES } from '@parlante/shared';
import { describe, expect, it } from 'vitest';
import { flatten, parityProblems, usageProblems } from '../videos/testing/i18nScan';
import type { Tree } from '../videos/testing/i18nScan';
import manifest from './index';
import { translations } from './i18n';
import { SECTIONS } from './sections';

const here = dirname(fileURLToPath(import.meta.url));

describe('settings translations', () => {
  it('has the same keys, variables and no empty strings in Spanish and English', () => {
    expect(parityProblems(translations.es, translations.en)).toEqual([]);
  });

  it('defines every key the feature uses', () => {
    expect(usageProblems(here, 'settings', translations.es)).toEqual([]);
  });

  it('labels every section, ledger reason and role that can reach the screen', () => {
    const keys = flatten(translations.es as Tree);
    for (const section of SECTIONS) {
      for (const leaf of ['label', 'title', 'text']) {
        expect(keys[`sections.${section.id}.${leaf}`], `${section.id}.${leaf}`).toBeTruthy();
      }
    }
    for (const reason of LEDGER_REASONS) {
      expect(keys[`billing.ledger.reason.${reason}`], reason).toBeTruthy();
    }
    for (const role of ROLES) expect(keys[`members.roles.${role}`], role).toBeTruthy();
  });

  it('registers one route per section plus the index and the invitation page', () => {
    expect(manifest.id).toBe('settings');
    expect(manifest.i18n).toBe(translations);
    const paths = manifest.routes.map((route) => route.path);
    expect(paths).toEqual([
      '/settings',
      ...SECTIONS.map((section) => section.path),
      '/invite/:token',
    ]);
    // The shell links the sidebar credit balance to this path.
    expect(paths).toContain('/settings/billing');
  });
});
