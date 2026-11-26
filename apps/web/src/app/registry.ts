import { registerTranslations } from '@/lib/i18n';
import { collectFeatures, loadManifests } from './features';
import type { ManifestModule } from './features';

/* Autoload: every src/features/<name>/index.ts(x). Adding a folder is all it takes to add a
 * feature. Manifests are tiny; pages are code-split through `lazy`.
 *
 * - Production: all manifests come eagerly in one chunk (`./manifests`).
 * - Development: each manifest is imported on its own, so a feature whose `index.tsx` is broken
 *   (half-written by someone else, a bad import) is skipped and listed in `registry.problems`
 *   instead of leaving a blank page for everybody. Folders starting with `_` (examples,
 *   playgrounds) are development-only: the literal `import.meta.env.DEV` check keeps them and
 *   the per-feature loaders out of production bundles altogether. */
let modules: Record<string, ManifestModule>;
const loadProblems: string[] = [];

if (import.meta.env.DEV) {
  const loaders = import.meta.glob<ManifestModule>('../features/*/index.{ts,tsx}');
  const loaded = await loadManifests(loaders);
  modules = loaded.modules;
  loadProblems.push(...loaded.problems);
} else {
  modules = (await import('./manifests')).manifests;
}

export const registry = collectFeatures(modules, { dev: import.meta.env.DEV });
registry.problems.unshift(...loadProblems);

for (const feature of registry.features) {
  if (feature.i18n) registerTranslations(feature.id, feature.i18n);
}

if (registry.problems.length > 0) {
  console.error(
    `[features] ${registry.problems.length} manifest problem(s):\n- ${registry.problems.join('\n- ')}`,
  );
}
