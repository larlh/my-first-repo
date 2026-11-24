import { api } from '@parlante/shared';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useApiQuery } from '../api/hooks';
import { apiClient } from '../api/instance';
import { currentLocale } from '../i18n';
import { useSessionState } from '../session';
import { dictation } from './controller';
import { useDictationState } from './hooks';
import { useDictationErrorText } from './text';

/**
 * Connects the dictation controller to the application: it exists while somebody is signed in
 * (the local engine is a session route and the preferences belong to a user), follows the
 * `capabilities` of the server and voices state changes in a polite live region, so screen
 * reader users hear "listening", "stopped" and errors wherever the focus is.
 * Mounted once, next to the session provider.
 */
export function DictationRuntime() {
  const session = useSessionState();
  const userId = session.status === 'authenticated' ? (session.user?.id ?? null) : null;
  const capabilities = useApiQuery(api.system.capabilities, undefined, {
    enabled: userId !== null,
    staleTime: 60_000,
  });
  const { refetch } = capabilities;

  useEffect(() => {
    if (userId === null) return;
    dictation.connect({
      userId,
      uiLanguage: currentLocale,
      loadCapabilities: async () => {
        const result = await refetch();
        if (!result.data) throw result.error ?? new Error('Capabilities unavailable');
        return result.data.dictation;
      },
      transcribe: (wav, language, signal) =>
        apiClient.dictation.transcribe(
          { file: wav, fileName: 'phrase.wav', fields: language ? { language } : {} },
          { signal },
        ),
    });
    return () => dictation.disconnect();
  }, [userId, refetch]);

  const reported = capabilities.data?.dictation ?? null;
  useEffect(() => {
    if (userId !== null && reported) dictation.setCapabilities(reported);
  }, [userId, reported]);

  return <DictationAnnouncer />;
}

function DictationAnnouncer() {
  const { t } = useTranslation('shell');
  const { announcement } = useDictationState();
  const errorText = useDictationErrorText();
  let text = '';
  if (announcement) {
    if (announcement.kind === 'listening') {
      text = t(
        announcement.engine === 'browser'
          ? 'dictation.announce.listeningBrowser'
          : 'dictation.announce.listeningLocal',
      );
    } else if (announcement.kind === 'stopped') {
      text = t('dictation.announce.stopped');
    } else if (announcement.error) {
      text = t('dictation.announce.error', { message: errorText(announcement.error) });
    }
  }
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-dictation-live=""
      className="sr-only"
    >
      {/* The key makes the same sentence announce again. */}
      {text && <span key={announcement?.serial}>{text}</span>}
    </div>
  );
}
