import { Suspense, lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Skeleton } from '@/ui';
import { SectionNav } from './components/SectionNav';
import { DEFAULT_SECTION, sectionFromPath } from './sections';
import type { SectionId } from './sections';

/* Each section is its own chunk; the frame (navigation + layout) is shared by every
 * /settings/* route, so moving between sections keeps the navigation mounted and focused. */
const SECTION_PAGES: Record<SectionId, LazyExoticComponent<ComponentType>> = {
  profile: lazy(() => import('./sections/ProfileSection')),
  preferences: lazy(() => import('./sections/PreferencesSection')),
  workspace: lazy(() => import('./sections/WorkspaceSection')),
  members: lazy(() => import('./sections/MembersSection')),
  billing: lazy(() => import('./sections/BillingSection')),
  consents: lazy(() => import('./sections/ConsentsSection')),
  apiKeys: lazy(() => import('./sections/ApiKeysSection')),
  webhooks: lazy(() => import('./sections/WebhooksSection')),
};

function SectionSkeleton() {
  return (
    <div aria-hidden="true">
      <Skeleton className="mb-3 h-9 w-56" />
      <Skeleton className="mb-8 h-4 w-80 max-w-full" />
      <Skeleton className="h-56 rounded-lg" />
    </div>
  );
}

/** Frame of the settings area: section navigation on the left, the active section beside it. */
export default function SettingsPage() {
  const location = useLocation();
  const section = sectionFromPath(location.pathname);
  if (!section) return <Navigate to={DEFAULT_SECTION.path} replace />;
  const Section = SECTION_PAGES[section.id];
  return (
    <div className="grid gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-10">
      <SectionNav />
      <div className="min-w-0">
        <Suspense fallback={<SectionSkeleton />}>
          <Section key={section.id} />
        </Suspense>
      </div>
    </div>
  );
}
