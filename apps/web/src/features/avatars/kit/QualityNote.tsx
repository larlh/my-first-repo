import type { Avatar, StoredError } from '@parlante/shared';
import { TriangleAlert } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeServerMessage } from '@/lib/api';
import { useServerMessage } from '@/ui';
import { Callout } from './Callout';

/* What the neural engine said about a portrait, in the person's language.
 *  - `Avatar.quality`: verdict of the quality control. An avatar can be `ready` with
 *    `passed: false` (the engine kept its least bad attempt) and the UI must say so next to it.
 *  - `StoredError.reason`: stable cause of a failed job (`no_face`, `engine_unreachable`…).
 * Codes this build does not know are shown as they come, never hidden. */

/** Issues that describe the cut-out, not the face: they do not make the portrait "failed". */
const MATTE_ISSUES = new Set(['matte_fallback', 'no_matte']);

export interface QualityNoteProps {
  quality: Avatar['quality'];
  className?: string;
}

/** Warning under a ready avatar whose portrait did not pass, or passed with remarks. */
export function QualityNote({ quality, className }: QualityNoteProps) {
  const { t, i18n } = useTranslation('avatars');
  if (!quality || (quality.passed && quality.issues.length === 0)) return null;
  const onlyMatte = quality.passed || quality.issues.every((issue) => MATTE_ISSUES.has(issue));
  return (
    <Callout
      tone="warning"
      role="note"
      icon={<TriangleAlert />}
      title={onlyMatte ? t('kit.quality.remarksTitle') : t('kit.quality.failedTitle')}
      className={className}
    >
      {!onlyMatte && (
        <p>
          {quality.attempts && quality.attempts > 1
            ? t('kit.quality.failedText', { count: quality.attempts })
            : t('kit.quality.failedTextOnce')}
        </p>
      )}
      {quality.issues.length > 0 && (
        <ul className="mt-1 list-disc pl-5" data-quality-issues={quality.issues.join(' ')}>
          {quality.issues.map((issue) => (
            <li key={issue}>
              {i18n.exists(`avatars:kit.quality.issues.${issue}`)
                ? t(`kit.quality.issues.${issue}`)
                : issue}
            </li>
          ))}
        </ul>
      )}
    </Callout>
  );
}

/**
 * Text of a failed avatar / engine job: the translated cause when `error.reason` is a code
 * this build knows, else the server's own message, else `fallback`.
 */
export function useFailureReason(): (
  error: StoredError | null | undefined,
  fallback: string,
) => { text: string; detail: string | null } {
  const { t, i18n } = useTranslation('avatars');
  const serverMessage = useServerMessage();
  return useCallback(
    (error, fallback) => {
      const reason = error?.reason;
      if (reason && i18n.exists(`avatars:kit.reasons.${reason}`)) {
        // The cause is already explained in the person's language; the engine's own sentence is
        // only worth repeating where it can be read (English) or has a known translation.
        const detail = localizeServerMessage(error.message, i18n.language, error.code);
        return {
          text: t(`kit.reasons.${reason}`),
          detail: detail.technical || detail.text === '' ? null : detail.text,
        };
      }
      const message = serverMessage(error?.message, { code: error?.code, reason });
      return { text: message || fallback, detail: null };
    },
    [t, i18n, serverMessage],
  );
}
