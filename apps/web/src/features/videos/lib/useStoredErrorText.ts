import type { StoredError } from '@parlante/shared';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerMessage } from '@/ui';

export interface StoredErrorText {
  /** Translated meaning of the error code. */
  title: string;
  /** What the worker said, in the language of the interface when it is known (else labelled). */
  detail: string;
}

/** Text for the `{ code, message }` a failed render leaves on the video. */
export function useStoredErrorText(): (error: StoredError) => StoredErrorText {
  const { t: tShell, i18n } = useTranslation('shell');
  const serverMessage = useServerMessage();
  return useCallback(
    (error) => {
      const key = `errors.${error.code}`;
      return {
        title: i18n.exists(key, { ns: 'shell' }) ? tShell(key) : tShell('errors.generic'),
        detail:
          error.code === 'INTERNAL'
            ? ''
            : serverMessage(error.message, { code: error.code, reason: error.reason }),
      };
    },
    [tShell, i18n, serverMessage],
  );
}
