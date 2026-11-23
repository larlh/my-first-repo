import type { ConsentKind, UiLocale } from '@parlante/shared';
import { useCallback, useRef } from 'react';
import { apiClient } from '@/lib/api';
import { consentBody, consentKey } from './consent';
import type { ConsentDraft } from './consent';

/**
 * Records the consent declaration right before the operation that needs it
 * (`POST /api/consents`). A record that was created but not consumed — the operation after it
 * failed — is reused while the declaration is literally the same, so retrying does not leave
 * a trail of unused records. Call `forget()` once the record was consumed or rejected.
 */
export function useConsentRecord(kind: ConsentKind): {
  ensure: (draft: ConsentDraft, locale: UiLocale) => Promise<string>;
  forget: () => void;
} {
  const pending = useRef<{ key: string; id: string } | null>(null);
  const ensure = useCallback(
    async (draft: ConsentDraft, locale: UiLocale) => {
      const key = consentKey(kind, draft, locale);
      if (pending.current?.key === key) return pending.current.id;
      const record = await apiClient.consents.create({ body: consentBody(kind, draft, locale) });
      pending.current = { key, id: record.id };
      return record.id;
    },
    [kind],
  );
  const forget = useCallback(() => {
    pending.current = null;
  }, []);
  return { ensure, forget };
}
