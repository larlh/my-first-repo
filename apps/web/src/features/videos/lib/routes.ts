import { matchPath } from 'react-router-dom';
import { useMemo } from 'react';
import { useRegistry } from '@/app/RegistryContext';

/* Paths this feature links to. The first block is ours; the second belongs to other features
 * (Studio, templates, AI script writer, billing). Those links are only offered when some
 * feature actually registered a matching route, so a missing section never produces a 404. */

export const ROUTES = {
  videos: '/videos',
  newVideo: '/videos/new',
  video: (videoId: string) => `/videos/${videoId}`,
  // Owned by other features.
  studio: (videoId: string) => `/studio/${videoId}`,
  templates: '/templates',
  scriptWriter: '/script-writer',
  billing: '/settings/billing',
  /** New translation with this video as the source (the translate feature reads `?video=`). */
  translateVideo: (videoId: string) => `/translate/new?video=${videoId}`,
} as const;

/** Concrete sample URLs used to probe the registry (any param name matches). */
const PROBES = {
  studio: ROUTES.studio('vid_probe'),
  templates: ROUTES.templates,
  scriptWriter: ROUTES.scriptWriter,
  billing: ROUTES.billing,
  translate: '/translate/new',
} as const;

export type ExternalRoute = keyof typeof PROBES;
export type AvailableRoutes = Record<ExternalRoute, boolean>;

/** True when `url` is served by one of the registered route patterns. */
export function routeExists(patterns: readonly string[], url: string): boolean {
  return patterns.some((path) => matchPath({ path, end: true }, url) !== null);
}

/** Which of the sections owned by other features are mounted in this build. */
export function useAvailableRoutes(): AvailableRoutes {
  const registry = useRegistry();
  return useMemo(() => {
    const patterns = registry.routes.map((route) => route.path);
    return {
      studio: routeExists(patterns, PROBES.studio),
      templates: routeExists(patterns, PROBES.templates),
      scriptWriter: routeExists(patterns, PROBES.scriptWriter),
      billing: routeExists(patterns, PROBES.billing),
      translate: routeExists(patterns, PROBES.translate),
    };
  }, [registry]);
}
