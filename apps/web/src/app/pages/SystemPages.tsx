import { Compass, RotateCw } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { useSession } from '@/lib/session';
import { Button, EmptyState, ErrorState, VoiceBars } from '@/ui';
import { PATHS } from '../paths';
import { useRegistry } from '../RegistryContext';

/** Suspense fallback while a page chunk loads. */
export function PageLoader() {
  return (
    <div className="flex min-h-[40dvh] items-center justify-center">
      <VoiceBars />
    </div>
  );
}

/** Sets the browser tab title for the current route. */
export function DocumentTitle({ title }: { title: string | null }) {
  useEffect(() => {
    document.title = title ? `${title} · Parlante` : 'Parlante';
  }, [title]);
  return null;
}

/** Catch-all route. */
export function NotFoundPage() {
  const { t } = useTranslation('shell');
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <DocumentTitle title={t('notFound.title')} />
      <header className="p-5 sm:px-10">
        <Link to={PATHS.home} aria-label={t('nav.home')} className="inline-flex rounded-sm">
          <Logo />
        </Link>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-6 pb-24 text-center">
        <p
          aria-hidden="true"
          className="display nums text-[7rem] leading-none text-accent sm:text-[10rem]"
        >
          404
        </p>
        <h1 className="display mt-2 text-3xl sm:text-4xl">{t('notFound.title')}</h1>
        <p className="mt-3 max-w-md text-base text-fg-muted">{t('notFound.text')}</p>
        <Button asChild variant="primary" className="mt-8">
          <Link to={PATHS.home}>{t('notFound.action')}</Link>
        </Button>
      </main>
    </div>
  );
}

/** Error boundary of every route: a crashed page never takes the layout down with it. */
export function RouteErrorBoundary() {
  const { t } = useTranslation('shell');
  const error = useRouteError();
  useEffect(() => {
    console.error('[route error]', error);
  }, [error]);

  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;

  const message = error instanceof Error ? error.message : '';
  // A deploy replaced the chunks this tab knows about: only a reload fixes it.
  const staleChunk =
    /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(
      message,
    );
  return (
    <div className="flex min-h-[60dvh] items-center justify-center">
      <ErrorState
        title={staleChunk ? t('routeError.staleTitle') : t('routeError.title')}
        description={staleChunk ? t('routeError.staleText') : t('routeError.text')}
        action={
          <Button
            variant="primary"
            leftIcon={<RotateCw aria-hidden="true" />}
            onClick={() => window.location.reload()}
          >
            {t('routeError.reload')}
          </Button>
        }
      />
    </div>
  );
}

/** `/` when no feature owns it: go to the first navigation entry, or explain the empty app. */
export function IndexRedirect() {
  const { t } = useTranslation('shell');
  const session = useSession();
  const registry = useRegistry();
  const first = registry.nav.find(
    (item) => item.section !== 'account' && (!item.minRole || session.can(item.minRole)),
  );
  if (first) return <Navigate to={first.to} replace />;
  return (
    <EmptyState
      icon={<Compass />}
      title={t('index.emptyTitle', { name: session.user.name })}
      description={t('index.emptyText')}
    />
  );
}
