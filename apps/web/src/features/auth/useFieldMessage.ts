import { useCallback } from 'react';
import type { FieldError } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

/**
 * Text of a field error. Client rules store an i18n key of the `auth` namespace
 * (`errors.emailInvalid`); errors that came from the API store the server message as is.
 */
export function useFieldMessage(): (error: FieldError | undefined) => string | undefined {
  const { t, i18n } = useTranslation('auth');
  return useCallback(
    (error) => {
      const message = error?.message;
      if (!message) return undefined;
      return i18n.exists(message, { ns: 'auth' }) ? t(message) : message;
    },
    [t, i18n],
  );
}
