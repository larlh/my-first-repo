import type { ManifestModule } from './features';

/* Production: every feature manifest in ONE eagerly evaluated chunk (manifests are tiny; the
 * pages behind them are code-split through `lazy`). Folders whose name starts with `_`
 * (examples, playgrounds) are development-only and never get here.
 *
 * This lives in its own module on purpose: an eager glob compiles to static imports, which
 * would run in development too wherever it is written. `registry.ts` imports this file only in
 * production builds and loads features one by one in development (see `loadManifests`). */
export const manifests: Record<string, ManifestModule> = import.meta.glob<ManifestModule>(
  ['../features/*/index.{ts,tsx}', '!../features/_*/**'],
  { eager: true },
);
