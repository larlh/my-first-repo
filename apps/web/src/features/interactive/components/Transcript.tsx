import { CircleAlert, RotateCw, Square, Trash2, Volume2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderName } from '@/components/ProviderBadge';
import { Button, IconButton, Spinner, VoiceBars, cn } from '@/ui';
import type { TalkMessage } from '../lib/talk';

export interface TranscriptProps {
  messages: readonly TalkMessage[];
  personaName: string;
  /** The reply to the last message is on its way. */
  thinking: boolean;
  /** Message whose audio is playing. */
  playingId: string | null;
  /** Message whose audio is being fetched for a replay. */
  loadingId: string | null;
  onListen: (message: TalkMessage) => void;
  onStop: () => void;
  onRetry: (message: TalkMessage) => void;
  onRemove: (message: TalkMessage) => void;
  className?: string;
}

/** Conversation history. New messages are announced politely and scrolled into view. */
export function Transcript({
  messages,
  personaName,
  thinking,
  playingId,
  loadingId,
  onListen,
  onStop,
  onRetry,
  onRemove,
  className,
}: TranscriptProps) {
  const providerName = useProviderName();
  const { t } = useTranslation('interactive');
  const { t: tShell, i18n } = useTranslation('shell');
  const end = useRef<HTMLLIElement>(null);
  const count = messages.length;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [count, thinking]);

  const reason = (code: string | undefined) =>
    code === 'CONTENT_BLOCKED'
      ? t('message.blocked')
      : code === 'INVALID_STATE'
        ? t('message.ended')
        : code && i18n.exists(`errors.${code}`, { ns: 'shell' })
          ? tShell(`errors.${code}`)
          : tShell('errors.generic');

  return (
    <ol
      role="log"
      aria-label={t('transcript.label')}
      aria-live="polite"
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      {messages.map((message) => {
        const mine = message.role === 'user';
        const playing = playingId === message.id;
        const basic = message.providers?.llm?.quality === 'basic';
        return (
          <li
            key={message.id}
            data-role={message.role}
            className={cn('flex min-w-0 flex-col gap-1', mine ? 'items-end' : 'items-start')}
          >
            <span className="eyebrow text-fg-subtle">
              {mine ? t('transcript.you') : personaName}
            </span>
            <div
              className={cn(
                'max-w-[min(100%,34rem)] rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap',
                mine
                  ? 'rounded-br-md bg-inverse text-inverse-fg'
                  : 'rounded-bl-md border border-line bg-surface text-fg',
                message.pending && 'opacity-70',
                message.failed && 'border border-danger bg-danger-soft text-danger-text',
              )}
            >
              {message.text}
            </div>

            {message.failed && (
              <div
                role="alert"
                className="flex max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-danger-text"
              >
                <span className="inline-flex items-center gap-1.5">
                  <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                  {reason(message.errorCode)}
                </span>
                {message.errorCode !== 'CONTENT_BLOCKED' &&
                  message.errorCode !== 'INVALID_STATE' && (
                    <Button
                      variant="link"
                      size="sm"
                      leftIcon={<RotateCw aria-hidden="true" />}
                      onClick={() => onRetry(message)}
                    >
                      {t('message.retry')}
                    </Button>
                  )}
                <Button
                  variant="link"
                  size="sm"
                  leftIcon={<Trash2 aria-hidden="true" />}
                  onClick={() => onRemove(message)}
                >
                  {t('message.remove')}
                </Button>
              </div>
            )}

            {!mine && (
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
                {playing ? (
                  <>
                    <VoiceBars size="sm" label={null} className="text-accent-text" />
                    <IconButton label={t('message.stop')} size="sm" onClick={onStop}>
                      <Square aria-hidden="true" />
                    </IconButton>
                  </>
                ) : loadingId === message.id ? (
                  <Spinner size="sm" label={t('message.loadingAudio')} />
                ) : (
                  <IconButton
                    label={t('message.listen')}
                    size="sm"
                    onClick={() => onListen(message)}
                  >
                    <Volume2 aria-hidden="true" />
                  </IconButton>
                )}
                {message.providers?.llm && (
                  <span>
                    {basic
                      ? t('message.byBasic')
                      : t('message.by', { name: providerName(message.providers.llm) })}
                  </span>
                )}
                {message.speech === null && <span>· {t('message.noAudio')}</span>}
              </div>
            )}
          </li>
        );
      })}

      {thinking && (
        <li className="flex flex-col items-start gap-1" data-role="thinking">
          <span className="eyebrow text-fg-subtle">{personaName}</span>
          <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3 text-sm text-fg-muted">
            <span className="flex gap-1" aria-hidden="true">
              <span className="size-1.5 animate-pulse rounded-full bg-fg-subtle" />
              <span className="size-1.5 animate-pulse rounded-full bg-fg-subtle [animation-delay:200ms]" />
              <span className="size-1.5 animate-pulse rounded-full bg-fg-subtle [animation-delay:400ms]" />
            </span>
            {t('transcript.thinking')}
          </div>
        </li>
      )}
      <li ref={end} aria-hidden="true" className="h-px" />
    </ol>
  );
}
