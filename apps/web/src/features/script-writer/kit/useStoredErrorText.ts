import type { StoredError } from '@parlante/shared';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export interface StoredErrorText {
  /** Translated meaning of the error code. */
  title: string;
  /** Message stored by the worker (English, technical) — shown as secondary detail. */
  detail: string;
}

/** Text for the `{ code, message }` a failed job leaves on its row. */
export function useStoredErrorText(): (error: StoredError) => StoredErrorText {
  const { t: tShell, i18n } = useTranslation('shell');
  return useCallback(
    (error) => {
      const key = `errors.${error.code}`;
      return {
        title: i18n.exists(key, { ns: 'shell' }) ? tShell(key) : tShell('errors.generic'),
        detail: error.code === 'INTERNAL' ? '' : error.message,
      };
    },
    [tShell, i18n],
  );
}
