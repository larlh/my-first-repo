import { matchPath } from 'react-router-dom';
import { useMemo } from 'react';
import { useRegistry } from '@/app/RegistryContext';

/* Paths of the AI tools (script writer, translation, batch, interactive avatar) and of the
 * sections of other features they link to. Links to other features are only offered when some
 * feature actually registered a matching route, so a missing section never produces a 404. */

export const TOOL_ROUTES = {
  scriptWriter: '/script-writer',
  translate: '/translate',
  translateNew: '/translate/new',
  translation: (translationId: string) => `/translate/${translationId}`,
  batch: '/batch',
  batchNew: '/batch/new',
  batchJob: (batchId: string) => `/batch/${batchId}`,
  interactive: '/interactive',
  interactiveSession: (sessionId: string) => `/interactive/${sessionId}`,
  // Owned by other features.
  studio: (videoId: string) => `/studio/${videoId}`,
  video: (videoId: string) => `/videos/${videoId}`,
  videosOfBatch: (batchId: string) => `/videos?batchJobId=${batchId}`,
  billing: '/settings/billing',
  templates: '/templates',
} as const;

const PROBES = {
  studio: TOOL_ROUTES.studio('vid_probe'),
  video: TOOL_ROUTES.video('vid_probe'),
  videos: '/videos',
  billing: TOOL_ROUTES.billing,
  templates: TOOL_ROUTES.templates,
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
      video: routeExists(patterns, PROBES.video),
      videos: routeExists(patterns, PROBES.videos),
      billing: routeExists(patterns, PROBES.billing),
      templates: routeExists(patterns, PROBES.templates),
    };
  }, [registry]);
}

/** Where a draft opens: the Studio when it is mounted, else the video page, else nowhere. */
export function draftPath(available: AvailableRoutes, videoId: string): string | null {
  if (available.studio) return TOOL_ROUTES.studio(videoId);
  if (available.video) return TOOL_ROUTES.video(videoId);
  return null;
}
