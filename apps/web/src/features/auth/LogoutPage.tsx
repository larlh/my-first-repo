import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { useSessionState } from '@/lib/session';
import { PATHS } from '@/shell';
import { ErrorState, VoiceBars } from '@/ui';

/**
 * `/logout` — ends the session and lands on the login page with a short confirmation. The
 * user menu of the sidebar does the same in place; this route makes sign-out linkable.
 */
export default function LogoutPage() {
  const { t } = useTranslation('auth');
  const session = useSessionState();
  const { status, logout } = session;
  const started = useRef(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (status !== 'authenticated' || started.current) return;
    started.current = true;
    logout().catch((error: unknown) => {
      started.current = false;
      setFailure(error);
    });
  }, [status, logout, attempt]);

  if (status === 'anonymous') {
    return <Navigate to={PATHS.login} replace state={{ signedOut: true }} />;
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg px-6 text-fg">
      <Logo size="lg" />
      {status === 'error' ? (
        <ErrorState error={session.error} onRetry={() => void session.refresh()} />
      ) : failure !== null ? (
        <ErrorState
          title={t('logout.failed')}
          error={failure}
          onRetry={() => {
            setFailure(null);
            setAttempt((count) => count + 1);
          }}
        />
      ) : (
        <VoiceBars label={t('logout.working')} />
      )}
    </main>
  );
}
