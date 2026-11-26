import type { Role } from '@parlante/shared';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { useSessionState } from '@/lib/session';
import { EmptyState, ErrorState } from '@/ui/States';
import { VoiceBars } from '@/ui/Spinner';
import { PATHS, loginPathFor, safeNextPath } from './paths';

/** Full-page wait while the session is being read. */
export function SplashScreen() {
  const { t } = useTranslation('shell');
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg text-fg">
      <Logo size="lg" />
      <VoiceBars label={t('session.loading')} />
    </div>
  );
}

/** Children render only with a session; anonymous visitors go to the login page and back. */
export function RequireSession({ children }: { children: ReactNode }) {
  const session = useSessionState();
  const location = useLocation();
  if (session.status === 'loading') return <SplashScreen />;
  if (session.status === 'error') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <ErrorState error={session.error} onRetry={() => void session.refresh()} />
      </div>
    );
  }
  if (session.status === 'anonymous') {
    return <Navigate to={loginPathFor(location.pathname + location.search)} replace />;
  }
  return <>{children}</>;
}

/** Login / register pages: a signed-in visitor is sent to `?next=` or home. */
export function GuestOnly({ children }: { children: ReactNode }) {
  const session = useSessionState();
  const [params] = useSearchParams();
  if (session.status === 'loading') return <SplashScreen />;
  if (session.status === 'authenticated') {
    return <Navigate to={safeNextPath(params.get('next'))} replace />;
  }
  return <>{children}</>;
}

/** Where to go after a successful login / registration (reads `?next=`). */
export function useNextPath(fallback: string = PATHS.home): string {
  const [params] = useSearchParams();
  return safeNextPath(params.get('next'), fallback);
}

/** Children render only when the caller role in the active workspace is at least `min`. */
export function RequireRole({ min, children }: { min: Role | undefined; children: ReactNode }) {
  const { t } = useTranslation('shell');
  const session = useSessionState();
  if (!min || session.can(min)) return <>{children}</>;
  return (
    <EmptyState
      icon={<Lock />}
      title={t('guard.forbiddenTitle')}
      description={t('guard.forbiddenText', {
        role: t(`roles.${min}`),
        current: session.role ? t(`roles.${session.role}`) : '—',
      })}
    />
  );
}
