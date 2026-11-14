import { registerTranslations } from '@/lib/i18n';
import { collectFeatures } from './features';
import type { FeatureManifest } from './features';

/* Autoload: every src/features/<name>/index.ts(x). Manifests are tiny and eager; pages are
 * code-split through `lazy`. Adding a folder is all it takes to add a feature.
 *
 * Folders whose name starts with `_` (examples, playgrounds) are development-only: the literal
 * `import.meta.env.DEV` check keeps them out of production bundles altogether. */
type ManifestModule = { default?: FeatureManifest; feature?: FeatureManifest };

const modules = {
  ...import.meta.glob<ManifestModule>(['../features/*/index.{ts,tsx}', '!../features/_*/**'], {
    eager: true,
  }),
  ...(import.meta.env.DEV
    ? import.meta.glob<ManifestModule>('../features/_*/index.{ts,tsx}', { eager: true })
    : {}),
};

export const registry = collectFeatures(modules, { dev: import.meta.env.DEV });

for (const feature of registry.features) {
  if (feature.i18n) registerTranslations(feature.id, feature.i18n);
}

if (registry.problems.length > 0) {
  console.error(
    `[features] ${registry.problems.length} manifest problem(s):\n- ${registry.problems.join('\n- ')}`,
  );
}
