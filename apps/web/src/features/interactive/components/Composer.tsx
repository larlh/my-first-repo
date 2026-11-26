import { SendHorizontal } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Textarea } from '@/ui';
import { MESSAGE_MAX_CHARS } from '../lib/talk';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** The avatar is answering: one turn at a time. */
  busy: boolean;
  personaName: string;
  /** Bumped to move the focus back to the box (after a turn). */
  focusKey: number;
  /** Language of the conversation: the language dictated into the box. */
  language?: string;
}

/** Message box: Enter sends, Shift+Enter breaks the line. */
export function Composer({
  value,
  onChange,
  onSend,
  busy,
  personaName,
  focusKey,
  language,
}: ComposerProps) {
  const { t } = useTranslation('interactive');
  const box = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  useEffect(() => {
    if (focusKey > 0) box.current?.focus();
  }, [focusKey]);

  const canSend = !busy && value.trim() !== '';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSend) onSend();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-end gap-2">
        <Textarea
          ref={box}
          aria-label={t('composer.label', { name: personaName })}
          aria-describedby={hintId}
          placeholder={t('composer.placeholder', { name: personaName })}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          maxLength={MESSAGE_MAX_CHARS}
          dictationLanguage={language}
          wrapperClassName="flex-1"
          className="min-h-[3.75rem] resize-none"
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={!canSend}
          loading={busy}
          leftIcon={<SendHorizontal aria-hidden="true" />}
          className="h-[3.75rem]"
        >
          {t('composer.send')}
        </Button>
      </div>
      <p id={hintId} className="text-xs text-fg-muted">
        {t('composer.hint')}
      </p>
    </form>
  );
}
