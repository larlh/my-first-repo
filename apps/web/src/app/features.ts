import type { Role } from '@parlante/shared';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { FeatureTranslations } from '@/lib/i18n';

/* -------------------------------------------------------------------------------------------
 * Feature manifests. Every `src/features/<name>/index.ts(x)` default-exports one manifest and
 * the shell mounts it: routes, navigation entries and translations. Features never edit shared
 * files — see apps/web/README.md for the copy-paste pattern.
 * ----------------------------------------------------------------------------------------- */

/**
 *  - `app`:        needs a session; rendered inside the layout with sidebar
 *  - `fullscreen`: needs a session; no chrome at all (Studio, interactive avatar)
 *  - `public`:     no session needed (login, register, shared video, invite)
 */
export type RouteLayout = 'app' | 'fullscreen' | 'public';

export interface FeatureRoute {
  /** Absolute React Router path: `/videos`, `/videos/:videoId`. */
  path: string;
  layout: RouteLayout;
  /** Code-split page: `() => import('./VideosPage')` (the module default-exports the component). */
  lazy?: () => Promise<{ default: ComponentType }>;
  /** Eagerly bundled page (tiny pages only). One of `lazy` / `component` is required. */
  component?: ComponentType;
  /** Minimum workspace role (session layouts). Others see a "no access" state. */
  minRole?: Role;
  /** `public` only: signed-in users are redirected into the app (login, register). */
  guestOnly?: boolean;
  /** i18n key (feature namespace) for the browser tab title. */
  titleKey?: string;
  /**
   * `app` layout only — width of the content column: `default` (readable, 76rem),
   * `wide` (galleries, tables) or `full` (edge to edge, the page pads itself).
   */
  width?: 'default' | 'wide' | 'full';
}

/**
 * Where a navigation entry appears:
 *   main → library → ai → workspace are sidebar groups (in that order);
 *   account goes to the user menu; dev is a sidebar group shown only in development.
 */
export type NavSection = 'main' | 'library' | 'ai' | 'workspace' | 'account' | 'dev';
export const SIDEBAR_SECTIONS = ['main', 'library', 'ai', 'workspace', 'dev'] as const;

export interface NavItem {
  to: string;
  /** i18n key in the feature namespace. */
  labelKey: string;
  icon: LucideIcon;
  section: NavSection;
  /** Position inside the section (ascending; default 100). */
  order?: number;
  /** Hide the entry below this role. */
  minRole?: Role;
  /** Active only on the exact path (not on children). */
  end?: boolean;
  /** Render as THE call-to-action button on top of the sidebar ("Crear vídeo"). One per app. */
  cta?: boolean;
}

export interface FeatureManifest {
  /** Unique, kebab-case. Also the i18n namespace: `useTranslation('<id>')`. */
  id: string;
  routes: FeatureRoute[];
  nav?: NavItem[];
  /** Translations of the feature namespace, both languages. */
  i18n?: FeatureTranslations;
  /** Mount only in development builds (examples, playgrounds). */
  devOnly?: boolean;
}

/** Identity helper that type-checks a manifest. */
export function defineFeature(manifest: FeatureManifest): FeatureManifest {
  return manifest;
}

export interface ResolvedRoute extends FeatureRoute {
  featureId: string;
}
export interface ResolvedNavItem extends NavItem {
  featureId: string;
}

export interface FeatureRegistry {
  features: FeatureManifest[];
  routes: ResolvedRoute[];
  nav: ResolvedNavItem[];
  /** Human-readable manifest problems (also logged). Offending parts are skipped. */
  problems: string[];
}

type FeatureModule = { default?: unknown; feature?: unknown };

function isManifest(value: unknown): value is FeatureManifest {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FeatureManifest).id === 'string' &&
    Array.isArray((value as FeatureManifest).routes)
  );
}

/**
 * Turn the glob result into a registry. Pure (testable): invalid manifests, duplicate ids and
 * duplicate paths are reported in `problems` and skipped instead of breaking the whole app.
 */
export function collectFeatures(
  modules: Record<string, FeatureModule>,
  options: { dev: boolean },
): FeatureRegistry {
  const problems: string[] = [];
  const features: FeatureManifest[] = [];
  const routes: ResolvedRoute[] = [];
  const nav: ResolvedNavItem[] = [];
  const ids = new Set<string>();
  const paths = new Map<string, string>();

  for (const file of Object.keys(modules).sort()) {
    const mod = modules[file];
    const manifest = mod?.default ?? mod?.feature;
    if (!isManifest(manifest)) {
      problems.push(`${file}: must default-export defineFeature({ id, routes })`);
      continue;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(manifest.id)) {
      problems.push(`${file}: id "${manifest.id}" must be kebab-case`);
      continue;
    }
    if (ids.has(manifest.id)) {
      problems.push(`${file}: duplicate feature id "${manifest.id}"`);
      continue;
    }
    if (manifest.devOnly && !options.dev) continue;
    ids.add(manifest.id);
    features.push(manifest);

    for (const route of manifest.routes) {
      if (!route.path.startsWith('/')) {
        problems.push(`${manifest.id}: route path "${route.path}" must be absolute`);
        continue;
      }
      if (!route.lazy && !route.component) {
        problems.push(`${manifest.id}: route "${route.path}" needs \`lazy\` or \`component\``);
        continue;
      }
      const owner = paths.get(route.path);
      if (owner) {
        problems.push(`${manifest.id}: route "${route.path}" is already registered by "${owner}"`);
        continue;
      }
      paths.set(route.path, manifest.id);
      routes.push({ ...route, featureId: manifest.id });
    }
    for (const item of manifest.nav ?? []) nav.push({ ...item, featureId: manifest.id });
  }

  nav.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.to.localeCompare(b.to));
  return { features, routes, nav, problems };
}

/** True when some feature registered exactly this path. */
export function hasRoute(registry: FeatureRegistry, path: string): boolean {
  return registry.routes.some((route) => route.path === path);
}
