/* Public surface of the shell for feature code. Import from '@/shell'.
 *
 *   import { defineFeature, PATHS, useNextPath, AuthShell } from '@/shell';
 *
 * Related entry points: '@/ui' (component kit), '@/lib/api' (typed client + hooks),
 * '@/lib/session', '@/lib/format', '@/lib/jobs', '@/lib/i18n', '@/lib/theme',
 * '@/components/*' (Logo, VideoPlayer, JobStatus, ProviderBadge). */
export { defineFeature } from './app/features';
export type {
  FeatureManifest,
  FeatureRoute,
  NavItem,
  NavSection,
  RouteLayout,
} from './app/features';
export { PATHS, loginPathFor, safeNextPath } from './app/paths';
export { RequireRole, useNextPath } from './app/guards';
export { AuthShell, PublicPreferences } from './app/layouts/AuthShell';
export { DocumentTitle, PageLoader } from './app/pages/SystemPages';
