import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/* Static checks of a feature's translations, used by each feature's i18n test:
 *  - both languages have the same keys, no empty strings and the same {{variables}}
 *  - every `t('literal.key')` in the feature's source exists
 *  - every t(`prefix.${dynamic}`) points at an existing branch
 *  - `t` always comes from the feature's own namespace (other namespaces use another name) */

export interface Tree {
  [key: string]: string | Tree;
}

export function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

function variablesOf(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1] as string).sort();
}

/** Problems between two languages of one namespace (empty array = fine). */
export function parityProblems(es: Tree, en: Tree): string[] {
  const a = flatten(es);
  const b = flatten(en);
  const problems: string[] = [];
  for (const key of Object.keys(a)) {
    if (!(key in b)) problems.push(`en is missing "${key}"`);
    else if (variablesOf(a[key] as string).join() !== variablesOf(b[key] as string).join()) {
      problems.push(`"${key}" uses different {{variables}} in es and en`);
    }
    if ((a[key] as string).trim() === '') problems.push(`es "${key}" is empty`);
    if (key.includes(':')) problems.push(`"${key}" contains ":" (i18next namespace separator)`);
  }
  for (const key of Object.keys(b)) {
    if (!(key in a)) problems.push(`es is missing "${key}"`);
    else if ((b[key] as string).trim() === '') problems.push(`en "${key}" is empty`);
  }
  return problems;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'testing') out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'i18n.ts') {
      out.push(path);
    }
  }
  return out;
}

const PLURAL = ['_one', '_other'];

/** Problems between the source of a feature folder and its Spanish tree. */
export function usageProblems(featureDir: string, namespace: string, es: Tree): string[] {
  const keys = flatten(es);
  const has = (key: string) => key in keys || PLURAL.every((suffix) => `${key}${suffix}` in keys);
  const hasBranch = (prefix: string) => Object.keys(keys).some((key) => key.startsWith(prefix));
  const problems: string[] = [];
  let used = 0;

  for (const file of sourceFiles(featureDir)) {
    const source = readFileSync(file, 'utf8');
    const name = relative(featureDir, file);
    // `const { t } = useTranslation('<ns>')` must be this feature's namespace.
    for (const match of source.matchAll(
      /const \{ t(?:, i18n)? \} = useTranslation\((?:'([^']*)')?\)/g,
    )) {
      if (match[1] !== namespace) {
        problems.push(
          `${name}: \`t\` is bound to "${match[1] ?? '(default)'}", expected "${namespace}"`,
        );
      }
    }
    for (const match of source.matchAll(/(?<![\w.])t\(\s*'([^']+)'/g)) {
      used += 1;
      if (!has(match[1] as string)) problems.push(`${name}: unknown key "${match[1]}"`);
    }
    for (const match of source.matchAll(/(?<![\w.])t\(\s*`([^`$]*)\$\{/g)) {
      used += 1;
      if (!hasBranch(match[1] as string)) problems.push(`${name}: no keys under "${match[1]}"`);
    }
    // Keys passed as data (`titleKey: 'titles.list'`, `labelKey: 'nav.videos'`, zod messages).
    for (const match of source.matchAll(/(?:titleKey|labelKey):\s*'([^']+)'/g)) {
      used += 1;
      if (!has(match[1] as string)) problems.push(`${name}: unknown key "${match[1]}"`);
    }
  }
  if (used === 0) problems.push(`no t('…') call found under ${featureDir}: the scanner is broken`);
  return problems;
}
