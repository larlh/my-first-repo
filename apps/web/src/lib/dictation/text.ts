import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { DictationError } from './types';

/**
 * `(error) => sentence in the UI language`. Every `DictationErrorCode` has its own text; when
 * the local engine is the problem, the reason the server gave (`reasonCode`) is spelled out —
 * including what to run to fix it.
 */
export function useDictationErrorText(): (error: DictationError) => string {
  const { t } = useTranslation('shell');
  return useCallback(
    (error) => {
      if (error.code === 'engine_unavailable' || error.code === 'no_engine') {
        const reason = t(`dictation.reasons.${error.reasonCode ?? 'unknown'}`);
        return error.code === 'no_engine' ? t('dictation.errors.no_engine', { reason }) : reason;
      }
      if (error.code === 'limit_reached') {
        return t('dictation.errors.limit_reached', { count: error.maxLength ?? 0 });
      }
      return t(`dictation.errors.${error.code}`);
    },
    [t],
  );
}
