import { useMemo } from 'react';
import { matchPath } from 'react-router-dom';
import { useRegistry } from '@/app/RegistryContext';

/* Paths of the library features (avatars, voices, templates, brand kit, photo avatar, voice
 * clone) and of the sections they link to that belong to other features. Links to the second
 * group are only offered when some feature registered a matching route, so a missing section
 * never becomes a 404. */

export const LIB_ROUTES = {
  avatars: '/avatars',
  /** The library with the card of one avatar open. */
  avatar: (avatarId: string) => `/avatars?avatar=${encodeURIComponent(avatarId)}`,
  newAvatar: '/avatars/new',
  voices: '/voices',
  cloneVoice: '/voices/clone',
  templates: '/templates',
  brandKit: '/brand-kit',
  // Owned by other features.
  studio: (videoId: string) => `/studio/${videoId}`,
  video: (videoId: string) => `/videos/${videoId}`,
  consents: '/settings/consents',
  billing: '/settings/billing',
} as const;

const PROBES = {
  studio: LIB_ROUTES.studio('vid_probe'),
  video: LIB_ROUTES.video('vid_probe'),
  consents: LIB_ROUTES.consents,
  billing: LIB_ROUTES.billing,
  newAvatar: LIB_ROUTES.newAvatar,
  cloneVoice: LIB_ROUTES.cloneVoice,
  avatars: LIB_ROUTES.avatars,
  voices: LIB_ROUTES.voices,
  brandKit: LIB_ROUTES.brandKit,
} as const;

export type ProbedRoute = keyof typeof PROBES;
export type AvailableRoutes = Record<ProbedRoute, boolean>;

/** True when `url` is served by one of the registered route patterns. */
export function routeExists(patterns: readonly string[], url: string): boolean {
  return patterns.some((path) => matchPath({ path, end: true }, url) !== null);
}

/** Which of the linked sections are mounted in this build. */
export function useAvailableRoutes(): AvailableRoutes {
  const registry = useRegistry();
  return useMemo(() => {
    const patterns = registry.routes.map((route) => route.path);
    const out = {} as AvailableRoutes;
    for (const key of Object.keys(PROBES) as ProbedRoute[]) {
      out[key] = routeExists(patterns, PROBES[key]);
    }
    return out;
  }, [registry]);
}

/** Where a freshly created draft opens: the Studio when it exists, else the video page. */
export function draftPath(available: AvailableRoutes, videoId: string): string | null {
  if (available.studio) return LIB_ROUTES.studio(videoId);
  if (available.video) return LIB_ROUTES.video(videoId);
  return null;
}
