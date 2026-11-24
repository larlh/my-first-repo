import { AlertTriangle, Globe, Mic, MicOff, Square } from 'lucide-react';
import { Popper } from 'radix-ui/internal';
import { useCallback, useEffect, useId, useRef } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useInRouterContext } from 'react-router-dom';
import { ProviderBadge } from '@/components/ProviderBadge';
import { cn } from '@/lib/cn';
import { dictation } from '@/lib/dictation/controller';
import type { DictationFieldState, DictationTarget } from '@/lib/dictation/controller';
import { chooseEngine } from '@/lib/dictation/engine-choice';
import { useDictationField, useDictationState } from '@/lib/dictation/hooks';
import { exclusionOf } from '@/lib/dictation/insert';
import type { DictationElement, FieldTraits } from '@/lib/dictation/insert';
import { useDictationErrorText } from '@/lib/dictation/text';
import { Badge } from './Badge';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Spinner, VoiceBars } from './Spinner';
import { Tooltip } from './Tooltip';

/* -------------------------------------------------------------------------------------------
 * Dictation control of the kit: the microphone button every free-text field carries, and the
 * small status panel that hangs from the field while it is in use.
 *
 *   <Input label="Título" />                         button included (default)
 *   <Input label="Título" dictation={false} />       no button for this field
 *   <Textarea dictationLanguage={voice.language} />  speech in another language
 *   <DictationButton target={ref} />                 next to a field that is not from the kit
 *
 * One implementation for the whole application: the engines, the rules (one field at a time,
 * Escape stops, where the text goes) and the preferences live in `@/lib/dictation`.
 * ----------------------------------------------------------------------------------------- */

/** Path of the dictation preferences (settings feature). */
export const DICTATION_PREFERENCES_PATH = '/settings/preferences#dictation';

/**
 * Whether a field shows the microphone: somebody is signed in, the user did not hide the
 * buttons, the field did not opt out and it is a free-text field (see `exclusionOf`).
 */
export function useDictationOffered(traits: FieldTraits, enabled: boolean | undefined): boolean {
  const { ready, preferences } = useDictationState();
  if (enabled === false || !ready || !preferences.showButtons) return false;
  return exclusionOf(traits) === null;
}

export type DictationButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_SIZES: Record<DictationButtonSize, string> = {
  sm: 'size-6 [&_svg]:size-3.5',
  md: 'size-7 [&_svg]:size-4',
  lg: 'size-8 [&_svg]:size-[1.125rem]',
};

export interface DictationButtonProps {
  /** The field the dictated text goes to. */
  target: RefObject<DictationElement | null>;
  /** Language spoken into the field (`es`, `en-GB`…). Default: the user's dictation language. */
  language?: string | undefined;
  size?: DictationButtonSize;
  /** Element the status panel hangs from (default: the button). */
  anchor?: RefObject<HTMLElement | null> | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

/**
 * Microphone toggle. Renders nothing while dictation is not offered at all (signed out, or
 * buttons hidden in the preferences); callers that need to reserve space ask
 * `useDictationOffered` first — `Input` and `Textarea` do.
 */
export function DictationButton({
  target,
  language,
  size = 'md',
  anchor,
  className,
  style,
}: DictationButtonProps) {
  const { t } = useTranslation('shell');
  const id = useId();
  const global = useDictationState();
  const field = useDictationField(id);
  const touched = useRef(false);

  // Forget this field when it goes away: nothing may be written into a removed control.
  useEffect(() => () => dictation.release(id), [id]);

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const mark = () => {
      touched.current = true;
    };
    element.addEventListener('focus', mark);
    return () => element.removeEventListener('focus', mark);
  }, [target]);

  const targetOf = useCallback((): DictationTarget | null => {
    const element = target.current;
    return element ? { id, element, language } : null;
  }, [id, language, target]);

  if (!global.ready || !global.preferences.showButtons) return null;

  const active = field.phase === 'listening' || field.phase === 'requesting';
  const choice = chooseEngine({
    preference: global.preferences.engine,
    local: global.capabilities?.local ?? null,
    browserSupported: global.browserSupported,
    browserConsent: global.preferences.browserConsentAt !== null,
  });
  // Known to be impossible right now: the button says so instead of looking ready.
  const unavailable =
    !active &&
    global.capabilities !== null &&
    choice.engine === null &&
    choice.blocked !== 'browser_needs_consent';
  const label = active
    ? t('dictation.stopButton')
    : unavailable
      ? t('dictation.unavailable')
      : t('dictation.button');

  const onClick = () => {
    const current = targetOf();
    if (!current) return;
    if (active) {
      dictation.stop();
      return;
    }
    const { element } = current;
    if (element.ownerDocument.activeElement !== element) {
      // The text goes where the caret was. A field that was never visited — or whose whole
      // content got selected just by tabbing through it — gets the text at the end instead
      // of having its content replaced.
      const length = element.value.length;
      const wholeSelected =
        length > 0 && element.selectionStart === 0 && element.selectionEnd === length;
      const collapse = !touched.current || wholeSelected;
      element.focus();
      if (collapse) {
        try {
          element.setSelectionRange(length, length);
        } catch {
          // Not a text selection (cannot happen for the fields that carry the button).
        }
      }
    }
    dictation.toggle(current);
  };

  // Keep the focus (and the caret) in the field when the button is clicked with a pointer.
  const keepFocus = (event: MouseEvent) => {
    if (target.current && target.current.ownerDocument.activeElement === target.current) {
      event.preventDefault();
    }
  };

  const open = field.phase !== 'idle' || field.error !== null;
  const level = field.phase === 'listening' ? (field.level ?? 0.5) : 0;

  const button = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={unavailable ? undefined : active}
      aria-expanded={unavailable ? field.error !== null : undefined}
      data-dictation-button=""
      data-state={field.error ? 'error' : unavailable ? 'unavailable' : field.phase}
      data-engine={field.engine ?? undefined}
      onMouseDown={keepFocus}
      onClick={onClick}
      style={{ ...style, '--dictation-level': level } as CSSProperties}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full text-fg-muted select-none',
        'transition-[background-color,color,box-shadow] duration-150 ease-standard',
        // A comfortable touch target around the small glyph.
        'before:absolute before:-inset-1.5 before:content-[""]',
        'hover:bg-fg/8 hover:text-fg',
        BUTTON_SIZES[size],
        field.phase === 'listening' &&
          'bg-accent text-accent-fg shadow-[0_0_0_calc(2px+var(--dictation-level)*5px)_var(--accent-soft)] hover:bg-accent-hover hover:text-accent-fg',
        field.phase === 'requesting' && 'bg-surface-3 text-fg',
        field.phase === 'transcribing' && 'text-fg',
        unavailable && 'text-fg-subtle',
        field.error && field.phase === 'idle' && 'text-danger-text',
        className,
      )}
    >
      {field.phase === 'requesting' || field.phase === 'transcribing' ? (
        <Spinner size="sm" label={null} />
      ) : unavailable ? (
        <MicOff aria-hidden="true" />
      ) : (
        <Mic aria-hidden="true" />
      )}
    </button>
  );

  return (
    <Popper.Root>
      {anchor ? (
        <>
          <Popper.Anchor virtualRef={anchor as RefObject<HTMLElement>} />
          <Tooltip content={label}>{button}</Tooltip>
        </>
      ) : (
        <Popper.Anchor asChild>
          <span className="inline-flex">
            <Tooltip content={label}>{button}</Tooltip>
          </span>
        </Popper.Anchor>
      )}
      {open && (
        <Popper.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          role="group"
          aria-label={t('dictation.panel')}
          data-dictation-panel=""
          data-state={field.error ? 'error' : field.phase}
          className="z-[65] w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-line bg-surface p-3 text-sm text-fg shadow-lg"
        >
          <DictationPanel
            field={field}
            onStop={() => dictation.stop()}
            onDismiss={() => dictation.dismiss(id)}
            onUseBrowser={() => {
              const current = targetOf();
              if (current) dictation.requestBrowserEngine(current);
            }}
            onUseLocal={() => {
              const current = targetOf();
              if (current) dictation.useLocalEngine(current);
            }}
            onRetry={() => {
              const current = targetOf();
              if (!current) return;
              dictation.dismiss(id);
              void dictation.start(current);
            }}
          />
        </Popper.Content>
      )}
      <BrowserDictationNotice
        open={field.consentPrompt}
        onCancel={() => dictation.dismiss(id)}
        onAccept={() => dictation.acceptBrowserEngine(targetOf())}
      />
    </Popper.Root>
  );
}

/** Input level as five bars; `level` is 0..1. */
function LevelMeter({ level, label }: { level: number; label: string }) {
  const lit = Math.round(level * 5);
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
      data-dictation-level={level}
      className="inline-flex h-5 shrink-0 items-end gap-[3px]"
    >
      {[0, 1, 2, 3, 4].map((bar) => (
        <span
          key={bar}
          style={{ height: `${40 + bar * 15}%` }}
          className={cn(
            'w-1 rounded-full transition-colors duration-100',
            bar < lit ? 'bg-accent' : 'bg-surface-3',
          )}
        />
      ))}
    </span>
  );
}

function EngineLine({ field }: { field: DictationFieldState }) {
  const { t } = useTranslation('shell');
  if (field.engine === 'browser') {
    return (
      <div className="mt-2.5 flex flex-col items-start gap-1 border-t border-line pt-2.5">
        <Badge tone="warning" size="sm" icon={<Globe aria-hidden="true" />} data-dictation-engine>
          {t('dictation.engine.browserBadge')}
        </Badge>
        <p className="text-xs text-fg-muted">{t('dictation.engine.browserPrivacy')}</p>
      </div>
    );
  }
  if (field.engine === 'local') {
    return (
      <div className="mt-2.5 flex flex-col items-start gap-1 border-t border-line pt-2.5">
        {field.provider ? (
          <span data-dictation-engine="">
            <ProviderBadge provider={field.provider} size="sm" />
          </span>
        ) : (
          <Badge variant="outline" size="sm" data-dictation-engine>
            {t('dictation.engine.local')}
          </Badge>
        )}
        <p className="text-xs text-fg-muted">{t('dictation.engine.localPrivacy')}</p>
      </div>
    );
  }
  return null;
}

function PreferencesLink({ children }: { children: ReactNode }) {
  const inRouter = useInRouterContext();
  const className = 'text-sm font-medium text-accent-text underline-offset-4 hover:underline';
  return inRouter ? (
    <Link to={DICTATION_PREFERENCES_PATH} className={className}>
      {children}
    </Link>
  ) : (
    <a href={DICTATION_PREFERENCES_PATH} className={className}>
      {children}
    </a>
  );
}

interface DictationPanelProps {
  field: DictationFieldState;
  onStop: () => void;
  onDismiss: () => void;
  onUseBrowser: () => void;
  onUseLocal: () => void;
  onRetry: () => void;
}

/** What the field is doing, who is transcribing, and the ways out of an error. */
function DictationPanel({
  field,
  onStop,
  onDismiss,
  onUseBrowser,
  onUseLocal,
  onRetry,
}: DictationPanelProps) {
  const { t } = useTranslation('shell');
  const errorText = useDictationErrorText();

  if (field.phase === 'idle' && field.error) {
    const { error } = field;
    const structural =
      error.code === 'engine_unavailable' ||
      error.code === 'no_engine' ||
      error.code === 'browser_unsupported';
    return (
      <div data-dictation-error={error.code}>
        <div className="flex items-start gap-2.5">
          <AlertTriangle
            aria-hidden="true"
            className={cn(
              'mt-0.5 size-4 shrink-0',
              error.code === 'limit_reached' ? 'text-warning-text' : 'text-danger-text',
            )}
          />
          <p className="min-w-0 flex-1 text-sm">{errorText(error)}</p>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          {structural && <PreferencesLink>{t('dictation.actions.preferences')}</PreferencesLink>}
          {error.offerBrowser && (
            <Button size="sm" variant="secondary" onClick={onUseBrowser}>
              {t('dictation.actions.useBrowser')}
            </Button>
          )}
          {error.offerLocal && (
            <Button size="sm" variant="secondary" onClick={onUseLocal}>
              {t('dictation.actions.useLocal')}
            </Button>
          )}
          {!structural && error.code !== 'limit_reached' && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              {t('dictation.actions.retry')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t('dictation.close')}
          </Button>
        </div>
      </div>
    );
  }

  if (field.phase === 'requesting') {
    return (
      <div className="flex items-start gap-2.5">
        <Spinner size="sm" label={null} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{t('dictation.state.requesting')}</p>
          <p className="mt-0.5 text-xs text-fg-muted">{t('dictation.state.requestingHint')}</p>
        </div>
      </div>
    );
  }

  if (field.phase === 'transcribing') {
    return (
      <>
        <div className="flex items-center gap-2.5">
          <Spinner size="sm" label={null} />
          <p className="min-w-0 flex-1 font-semibold">
            {field.pending > 0
              ? t('dictation.state.pending', { count: field.pending })
              : t('dictation.state.transcribing')}
          </p>
        </div>
        <EngineLine field={field} />
      </>
    );
  }

  // Listening.
  return (
    <>
      <div className="flex items-center gap-2.5">
        {field.level === null ? (
          <VoiceBars size="sm" label={null} />
        ) : (
          <LevelMeter level={field.level} label={t('dictation.state.level')} />
        )}
        <p className="min-w-0 flex-1 font-semibold">{t('dictation.state.listening')}</p>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<Square aria-hidden="true" />}
          onClick={onStop}
        >
          {t('dictation.stop')}
        </Button>
      </div>
      {field.interim !== '' && (
        <p data-dictation-interim="" className="mt-2 text-sm text-fg-muted italic">
          {field.interim}
        </p>
      )}
      <p className="mt-2 text-xs text-fg-muted">
        {field.pending > 0 ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-fg">
            <Spinner size="xs" label={null} />
            {t('dictation.state.pending', { count: field.pending })}
          </span>
        ) : field.engine === 'browser' ? (
          t('dictation.state.listeningHintBrowser')
        ) : (
          t('dictation.state.listeningHintLocal')
        )}
        <span className="mt-0.5 block text-fg-subtle">{t('dictation.escHint')}</span>
      </p>
      <EngineLine field={field} />
    </>
  );
}

export interface BrowserDictationNoticeProps {
  open: boolean;
  onAccept: () => void;
  onCancel: () => void;
}

/**
 * The notice that must be accepted once before the browser engine is used: with it, the audio
 * leaves the machine (in Chrome it goes to Google). Shown by the microphone button and by the
 * dictation preferences — never skipped, and the engine is never selected on the user's behalf.
 */
export function BrowserDictationNotice({ open, onAccept, onCancel }: BrowserDictationNoticeProps) {
  const { t } = useTranslation('shell');
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={t('dictation.consent.title')}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-autofocus="">
            {t('dictation.consent.cancel')}
          </Button>
          <Button variant="solid" onClick={onAccept}>
            {t('dictation.consent.accept')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm" data-dictation-consent="">
        <p>{t('dictation.consent.intro')}</p>
        <p className="rounded-md border border-warning bg-warning-soft p-3 font-medium text-warning-text">
          {t('dictation.consent.leaves')}
        </p>
        <p className="text-fg-muted">{t('dictation.consent.policy')}</p>
        <p className="text-fg-muted">{t('dictation.consent.alternative')}</p>
        <p className="text-fg-muted">{t('dictation.consent.remember')}</p>
      </div>
    </Dialog>
  );
}
