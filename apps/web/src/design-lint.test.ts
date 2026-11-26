import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from './lib/i18n/locales/en';
import { es } from './lib/i18n/locales/es';
import { ERROR_CODES } from '@parlante/shared';

/* Guards of the design system, enforced for the shell AND for every feature:
 *  1. No raw Tailwind palette classes: colours come from the semantic tokens of
 *     styles/tokens.css, otherwise dark mode and the brand break.
 *  2. The tokens keep WCAG AA contrast in both themes.
 *  3. Shell translations are complete in both languages.
 * Escape hatch for a deliberate exception: put `design-lint-ignore` on the same line. */

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const UTIL =
  'bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|shadow|accent|caret|placeholder';
const RAW_COLOR = new RegExp(
  `(?<![\\w-])(?:[a-z-]+:)*(?:${UTIL})-(?:(?:${PALETTE})-\\d{2,3}|white|black)(?![\\w-])`,
  'g',
);

describe('design system guards', () => {
  it('recognises raw palette classes and leaves tokens alone', () => {
    const hits = (text: string) => text.match(RAW_COLOR) ?? [];
    expect(hits('bg-white hover:bg-slate-100 dark:text-gray-400 border-red-500/40')).toHaveLength(
      4,
    );
    expect(
      hits('bg-surface text-fg-muted border-line bg-accent-soft text-on-media to-transparent'),
    ).toEqual([]);
  });

  it('uses semantic colour tokens instead of raw Tailwind palette classes', () => {
    const offences: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith('.css')) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (line.includes('design-lint-ignore')) return;
          const hits = line.match(RAW_COLOR);
          if (hits) offences.push(`${relative(SRC, file)}:${index + 1}  ${hits.join(' ')}`);
        });
    }
    expect(
      offences,
      'Raw palette classes found. Use tokens (bg-surface, text-fg, text-fg-muted, border-line, bg-accent text-accent-fg, ' +
        'bg-media text-on-media, bg-scrim…). See apps/web/README.md → "Sistema de diseño".',
    ).toEqual([]);
  });
});

/* ---------- token contrast ---------- */

function parseTheme(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Selector ${selector} not found in tokens.css`);
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  const vars: Record<string, string> = {};
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    vars[match[1] as string] = (match[2] as string).toLowerCase();
  }
  return vars;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground, background, minimum ratio] */
const PAIRS: [string, string, number][] = [
  ['fg', 'bg', 7],
  ['fg', 'surface', 7],
  ['fg-muted', 'bg', 4.5],
  ['fg-muted', 'surface-2', 4.5],
  ['fg-muted', 'surface-3', 4.5],
  ['fg-subtle', 'bg', 4.5],
  ['fg-subtle', 'surface', 4.5],
  ['fg-subtle', 'surface-2', 4.5],
  ['accent-fg', 'accent', 4.5],
  ['accent-fg', 'accent-hover', 4.5],
  ['accent-text', 'bg', 4.5],
  ['accent-text', 'surface', 4.5],
  ['accent-text', 'accent-soft', 4.5],
  ['saffron-fg', 'saffron', 4.5],
  ['saffron-text', 'saffron-soft', 4.5],
  ['success-text', 'success-soft', 4.5],
  ['warning-text', 'warning-soft', 4.5],
  ['danger-text', 'danger-soft', 4.5],
  ['danger-text', 'surface', 4.5],
  ['info-text', 'info-soft', 4.5],
  ['danger-fg', 'danger', 4.5],
  ['inverse-fg', 'inverse', 7],
  ['sidebar-fg', 'sidebar', 7],
  ['sidebar-fg-muted', 'sidebar', 4.5],
  ['sidebar-fg-muted', 'sidebar-2', 4.5],
  ['sidebar-fg', 'sidebar-3', 4.5],
  // non-text: control boundaries and the focus ring need 3:1
  ['line-control', 'surface', 3],
  ['line-control', 'bg', 3],
  ['ring', 'bg', 3],
  ['ring', 'surface', 3],
  ['accent', 'sidebar', 3],
  ['saffron', 'sidebar', 3],
];

describe('design tokens', () => {
  const css = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
  const themes = {
    light: parseTheme(css, "[data-theme='light'] {"),
    dark: parseTheme(css, "[data-theme='dark'] {"),
  };

  it('defines the same colour tokens in both themes', () => {
    const light = Object.keys(themes.light).sort();
    const dark = Object.keys(themes.dark).sort();
    // media colours are theme-independent and only declared once
    expect(dark).toEqual(light.filter((name) => name !== 'media' && name !== 'on-media'));
  });

  for (const [name, vars] of Object.entries(themes)) {
    it(`keeps WCAG contrast in the ${name} theme`, () => {
      const failures: string[] = [];
      for (const [fg, bg, min] of PAIRS) {
        const a = vars[fg];
        const b = vars[bg];
        if (!a || !b) {
          failures.push(`${fg} / ${bg}: token missing`);
          continue;
        }
        const ratio = contrast(a, b);
        if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
      }
      expect(failures).toEqual([]);
    });
  }
});

/* ---------- translations ---------- */

function leafKeys(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? leafKeys(value as object, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe('shell translations', () => {
  it('has the same keys in Spanish and English, none empty', () => {
    expect(leafKeys(en).sort()).toEqual(leafKeys(es).sort());
    const empty = [...Object.entries({ es, en })].flatMap(([lang, tree]) =>
      leafKeys(tree)
        .filter((key) => {
          const value = key
            .split('.')
            .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
          return typeof value !== 'string' || value.trim() === '';
        })
        .map((key) => `${lang}:${key}`),
    );
    expect(empty).toEqual([]);
  });

  it('translates every API error code', () => {
    for (const code of Object.keys(ERROR_CODES)) {
      expect(es.errors, code).toHaveProperty(code);
      expect(en.errors, code).toHaveProperty(code);
    }
  });
});
