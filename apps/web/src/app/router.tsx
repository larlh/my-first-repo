import { Suspense, lazy } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, createBrowserRouter } from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';
import type { FeatureRegistry, ResolvedRoute } from './features';
import { GuestOnly, RequireRole, RequireSession, SplashScreen } from './guards';
import { AppLayout, FullscreenLayout } from './layouts/AppLayout';
import type { RouteHandle } from './layouts/AppLayout';
import {
  DocumentTitle,
  IndexRedirect,
  NotFoundPage,
  PageLoader,
  RouteErrorBoundary,
} from './pages/SystemPages';
import { PATHS } from './paths';

/* Development-only pages. The literal `import.meta.env.DEV` check lets the bundler drop these
 * imports (and everything they pull in) from production builds. */
const devPages = import.meta.env.DEV
  ? {
      ui: () => import('./dev/UiGallery'),
      auth: () => import('./dev/AuthPreview'),
    }
  : null;

function FeaturePage({ route, Page }: { route: ResolvedRoute; Page: ComponentType }) {
  const { t } = useTranslation(route.featureId);
  const page: ReactNode = (
    <Suspense fallback={<PageLoader />}>
      <Page />
    </Suspense>
  );
  return (
    <>
      <DocumentTitle title={route.titleKey ? t(route.titleKey) : null} />
      {route.layout === 'public' ? (
        route.guestOnly ? (
          <GuestOnly>{page}</GuestOnly>
        ) : (
          page
        )
      ) : (
        <RequireRole min={route.minRole}>{page}</RequireRole>
      )}
    </>
  );
}

function toRouteObject(route: ResolvedRoute): RouteObject {
  // The lazy component is created once per route, never during render.
  const Page = route.component ?? lazy(route.lazy as NonNullable<ResolvedRoute['lazy']>);
  const handle: RouteHandle = { width: route.width };
  return {
    path: route.path,
    element: <FeaturePage route={route} Page={Page} />,
    errorElement: <RouteErrorBoundary />,
    handle,
  };
}

/**
 * Route tree built from the feature registry:
 *   public routes · session routes inside the app layout · session routes full screen ·
 *   development-only pages · 404.
 */
export function buildRoutes(registry: FeatureRegistry, options: { dev: boolean }): RouteObject[] {
  const of = (layout: ResolvedRoute['layout']) =>
    registry.routes.filter((route) => route.layout === layout).map(toRouteObject);

  const appRoutes = of('app');
  const ownsHome = registry.routes.some((route) => route.path === PATHS.home);
  if (!ownsHome) {
    appRoutes.push({
      path: PATHS.home,
      element: <IndexRedirect />,
      errorElement: <RouteErrorBoundary />,
    });
  }

  const devRoutes: RouteObject[] =
    options.dev && devPages
      ? [
          {
            path: PATHS.devUi,
            lazy: async () => ({ Component: (await devPages.ui()).default }),
            errorElement: <RouteErrorBoundary />,
          },
          {
            path: PATHS.devAuth,
            lazy: async () => ({ Component: (await devPages.auth()).default }),
            errorElement: <RouteErrorBoundary />,
          },
        ]
      : [];

  return [
    {
      element: <Outlet />,
      errorElement: <RouteErrorBoundary />,
      hydrateFallbackElement: <SplashScreen />,
      children: [
        ...of('public'),
        {
          element: (
            <RequireSession>
              <AppLayout />
            </RequireSession>
          ),
          children: appRoutes,
        },
        {
          element: (
            <RequireSession>
              <FullscreenLayout />
            </RequireSession>
          ),
          children: of('fullscreen'),
        },
        ...devRoutes,
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ];
}

export function createAppRouter(registry: FeatureRegistry) {
  return createBrowserRouter(buildRoutes(registry, { dev: import.meta.env.DEV }));
}
