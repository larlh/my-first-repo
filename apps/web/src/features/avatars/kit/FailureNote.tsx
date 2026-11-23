import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { isApiError } from '@/lib/api';
import { Button } from '@/ui';
import { Callout } from './Callout';
import { creationFailure } from './failure';
import { LIB_ROUTES, useAvailableRoutes } from './routes';

export interface FailureNoteProps {
  /** Anything thrown while uploading / recording consent / creating. */
  error: unknown;
  className?: string;
}

/**
 * Explains a failed creation in plain words, keeps the server's own reason visible (the
 * engine's message is passed through verbatim) and offers the next step when there is one.
 */
export function FailureNote({ error, className }: FailureNoteProps) {
  const { t } = useTranslation('avatars');
  const available = useAvailableRoutes();
  const failure = isApiError(error) ? creationFailure(error) : 'generic';
  const detail = error instanceof Error ? error.message : '';
  return (
    <Callout
      tone="danger"
      role="alert"
      icon={<TriangleAlert />}
      title={t(`kit.failure.${failure}.title`)}
      className={className}
      action={
        failure === 'credits' && available.billing ? (
          <Button asChild size="sm">
            <Link to={LIB_ROUTES.billing}>{t('kit.failure.buyCredits')}</Link>
          </Button>
        ) : failure === 'limit' && available.billing ? (
          <Button asChild size="sm">
            <Link to={LIB_ROUTES.billing}>{t('kit.failure.seePlans')}</Link>
          </Button>
        ) : undefined
      }
    >
      <p>{t(`kit.failure.${failure}.text`)}</p>
      {detail !== '' && (
        <p className="mt-1.5 font-mono text-xs break-words opacity-80">
          {t('kit.failure.detail', { detail })}
        </p>
      )}
    </Callout>
  );
}
