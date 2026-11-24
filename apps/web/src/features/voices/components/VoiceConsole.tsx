import { LANGUAGES, languageName } from '@parlante/shared';
import type { LanguageCode, Voice } from '@parlante/shared';
import { listStockAvatars } from '@parlante/renderer';
import {
  Clapperboard,
  Copy,
  Cpu,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ProviderBadge } from '@/components/ProviderBadge';
import { api, useApiMutation } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Button,
  Input,
  Select,
  Slider,
  Textarea,
  VoiceBars,
  cn,
  toast,
  useConfirm,
  useErrorText,
  useServerMessage,
} from '@/ui';
import { AvatarStage, Callout, useStartVideo } from '@/features/avatars/kit';
import type { SpeechPreview } from '@/features/avatars/kit';
import {
  PITCH_RANGE,
  PREVIEW_TEXT_MAX,
  SPEED_RANGE,
  formatPitch,
  formatSpeed,
  sampleText,
} from '../lib/voices';

/** Settings of the preview, owned by the page so they survive changing voice. */
export interface PreviewSettings {
  /** null = the sample sentence of the preview language. */
  text: string | null;
  speed: number;
  pitch: number;
  /** Language for multilingual voices (null = follow the list filter / the voice). */
  language: LanguageCode | null;
}

export const DEFAULT_PREVIEW: PreviewSettings = { text: null, speed: 1, pitch: 0, language: null };

/** The stock character that lip-syncs the preview: same gender as the voice when possible. */
function presenterFor(voice: Voice) {
  const all = listStockAvatars();
  const match = all.find((avatar) => avatar.gender === voice.gender) ?? all[0];
  return match ? { id: match.id, rendering: 'instant' as const } : null;
}

function RenameVoice({ voice, onDone }: { voice: Voice; onDone: () => void }) {
  const { t } = useTranslation('voices');
  const describe = useErrorText();
  const [name, setName] = useState(voice.name);
  const rename = useApiMutation(api.voiceClones.update, {
    invalidates: [api.voices.list, api.voices.get],
    onSuccess: () => {
      toast.success(t('console.renamed'));
      onDone();
    },
    onError: (error) =>
      toast.error(t('console.renameFailed'), { description: describe(error).title }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === voice.name) return onDone();
    rename.mutate({ params: { voiceId: voice.id }, body: { name: trimmed } });
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <Input
        label={t('console.nameLabel')}
        value={name}
        maxLength={60}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        wrapperClassName="min-w-0 flex-1 basis-40"
      />
      <Button type="submit" variant="solid" loading={rename.isPending}>
        {t('console.save')}
      </Button>
      <Button type="button" variant="ghost" onClick={onDone}>
        {t('console.cancel')}
      </Button>
    </form>
  );
}

export interface VoiceConsoleProps {
  voice: Voice;
  /** Language the preview is spoken in (resolved by the page). */
  language: LanguageCode;
  settings: PreviewSettings;
  onSettings: (next: PreviewSettings) => void;
  speech: SpeechPreview;
  onPlay: (voice: Voice) => void;
  /** Called after the voice was deleted. */
  onDeleted?: () => void;
  className?: string;
}

/**
 * The listening desk of the voice library: your own text, speed and pitch, a play button, a
 * character that lip-syncs the result with the renderer, and — always — which provider
 * produced the audio and whether that is the local "basic mode".
 */
export function VoiceConsole({
  voice,
  language,
  settings,
  onSettings,
  speech,
  onPlay,
  onDeleted,
  className,
}: VoiceConsoleProps) {
  const { t, i18n } = useTranslation('voices');
  const serverMessage = useServerMessage();
  const format = useFormat();
  const session = useSession();
  const describe = useErrorText();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const uiLocale = i18n.language.startsWith('en') ? 'en' : 'es';

  const mine = speech.activeKey === voice.id;
  const loading = mine && speech.status === 'loading';
  const playing = mine && speech.status === 'playing';
  const failed = mine && speech.status === 'error';
  const result = speech.resultKey === voice.id ? speech.result : null;
  const presenter = presenterFor(voice);
  const ready = voice.status === 'ready';
  const text = settings.text ?? sampleText(language);
  const cloned = voice.kind === 'cloned';
  const basic = voice.provider.quality === 'basic';

  const startVideo = useStartVideo({
    onCreated: () => toast.success(t('console.videoCreated')),
    onError: (error) =>
      toast.error(t('console.videoFailed'), { description: describe(error).title }),
  });
  const remove = useApiMutation(api.voiceClones.remove, {
    invalidates: [api.voices.list],
    onSuccess: () => {
      toast.success(t('console.deleted'));
      onDeleted?.();
    },
    onError: (error) =>
      toast.error(t('console.deleteFailed'), { description: describe(error).title }),
  });

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(voice.id);
      toast.success(t('console.idCopied'));
    } catch {
      toast.error(t('console.idCopyFailed'));
    }
  };
  const askDelete = async () => {
    const ok = await confirm({
      title: t('console.deleteTitle', { name: voice.name }),
      description: t('console.deleteText'),
      confirmLabel: t('console.delete'),
      tone: 'danger',
    });
    if (ok) remove.mutate({ params: { voiceId: voice.id } });
  };

  return (
    <section
      aria-label={t('console.label', { name: voice.name })}
      className={cn(
        'overflow-hidden rounded-xl border border-line bg-surface shadow-sm',
        className,
      )}
    >
      {/* ---- meter bridge: always dark ---- */}
      <div className="relative flex items-center gap-3.5 bg-media px-4 py-4 text-on-media [--ring:var(--saffron)] sm:px-5">
        {presenter && (
          <div className="relative size-[4.5rem] shrink-0 overflow-hidden rounded-full bg-on-media/10 ring-2 ring-on-media/15">
            <AvatarStage
              avatar={presenter}
              mode={playing ? 'speech' : 'idle'}
              runtime={result?.runtime ?? null}
              clock={speech.clock}
              framing="closeup"
              label={t('console.presenter')}
              className="absolute inset-0"
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="eyebrow text-on-media/60">{t('console.eyebrow')}</p>
          <h2 className="display truncate text-2xl leading-tight">{voice.name}</h2>
          <p className="truncate text-sm text-on-media/70">
            {voice.multilingual ? t('multilingual') : languageName(voice.language, uiLocale)}
            {' · '}
            {t(`gender.${voice.gender}`)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => (playing || loading ? speech.stop() : onPlay(voice))}
          disabled={!ready || text.trim() === ''}
          aria-label={
            playing || loading ? t('console.stop') : t('console.play', { name: voice.name })
          }
          className={cn(
            'flex size-14 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg shadow-edge transition-[background-color,transform] duration-150',
            'hover:bg-accent-hover active:translate-y-px disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          {loading ? (
            <VoiceBars size="sm" label={null} className="text-accent-fg" />
          ) : playing ? (
            <Square aria-hidden="true" className="size-5 fill-current" />
          ) : (
            <Play aria-hidden="true" className="ml-0.5 size-6 fill-current" />
          )}
        </button>
      </div>
      <p
        role="status"
        className="nums flex min-h-9 items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-xs text-fg-muted sm:px-5"
      >
        {playing && <VoiceBars size="sm" label={null} />}
        {loading
          ? t('console.status.loading')
          : playing
            ? t('console.status.playing')
            : failed
              ? t('console.status.error')
              : result
                ? t('console.status.done', {
                    time: format.duration(result.runtime.audioDurationMs),
                  })
                : ready
                  ? t('console.status.idle')
                  : t(`console.status.${voice.status}`)}
      </p>

      <div className="flex flex-col gap-5 p-4 sm:p-5">
        {voice.status === 'failed' && (
          <Callout
            tone="danger"
            role="alert"
            icon={<TriangleAlert />}
            title={t('console.failedTitle')}
          >
            {serverMessage(voice.error?.message, {
              code: voice.error?.code,
              reason: voice.error?.reason,
            }) || t('console.failedText')}
          </Callout>
        )}
        {failed && speech.error && (
          <Callout
            tone="danger"
            role="alert"
            icon={<TriangleAlert />}
            title={describe(speech.error).title}
          >
            {describe(speech.error).message}
          </Callout>
        )}

        <Textarea
          label={t('console.text')}
          rows={4}
          maxLength={PREVIEW_TEXT_MAX}
          showCount
          value={text}
          disabled={!ready}
          lang={language}
          onChange={(event) => onSettings({ ...settings, text: event.target.value })}
          hint={
            settings.text !== null ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 font-semibold text-fg underline"
                onClick={() => onSettings({ ...settings, text: null })}
              >
                <RotateCcw aria-hidden="true" className="size-3.5" />
                {t('console.restore')}
              </button>
            ) : (
              t('console.textHint')
            )
          }
        />

        {voice.multilingual && (
          <Select
            label={t('console.language')}
            hint={t('console.languageHint')}
            value={language}
            onValueChange={(value) => onSettings({ ...settings, language: value, text: null })}
            options={LANGUAGES.map((entry) => ({
              value: entry.code,
              label: uiLocale === 'en' ? entry.englishName : entry.name,
            }))}
          />
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          <Slider
            label={t('console.speed')}
            value={settings.speed}
            min={SPEED_RANGE.min}
            max={SPEED_RANGE.max}
            step={SPEED_RANGE.step}
            disabled={!ready}
            formatValue={(value) => formatSpeed(value, format.locale)}
            onValueChange={(speed) => onSettings({ ...settings, speed })}
          />
          <Slider
            label={t('console.pitch')}
            value={settings.pitch}
            min={PITCH_RANGE.min}
            max={PITCH_RANGE.max}
            step={PITCH_RANGE.step}
            disabled={!ready}
            formatValue={formatPitch}
            onValueChange={(pitch) => onSettings({ ...settings, pitch })}
          />
        </div>
        {(settings.speed !== 1 || settings.pitch !== 0) && (
          <button
            type="button"
            className="-mt-2 inline-flex items-center gap-1 self-start text-sm font-semibold underline"
            onClick={() => onSettings({ ...settings, speed: 1, pitch: 0 })}
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            {t('console.resetTone')}
          </button>
        )}

        {/* ---- honesty: who makes the sound ---- */}
        <div className="rounded-lg border border-line bg-surface-2 p-3.5">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-sm">
            <dt className="text-fg-muted">{t('console.voiceProvider')}</dt>
            <dd className="justify-self-end">
              <ProviderBadge provider={voice.provider} size="sm" />
            </dd>
            {result && (
              <>
                <dt className="text-fg-muted">{t('console.audioProvider')}</dt>
                <dd className="justify-self-end">
                  <ProviderBadge provider={result.provider} size="sm" />
                </dd>
              </>
            )}
          </dl>
          {basic && (
            <p className="mt-3 flex gap-2 border-t border-line pt-3 text-xs text-pretty text-fg-muted">
              <Cpu aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              {cloned ? t('console.basicCloned') : t('console.basicStock')}
            </p>
          )}
        </div>

        {cloned && voice.profile && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-fg-muted">{t('console.profile.base')}</dt>
              <dd className="font-mono text-xs">{voice.profile.baseVoiceId}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">{t('console.profile.f0')}</dt>
              <dd className="nums">
                {voice.profile.meanF0Hz === null
                  ? t('console.profile.unknown')
                  : `${format.number(voice.profile.meanF0Hz)} Hz`}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">{t('console.profile.pitch')}</dt>
              <dd className="nums">{formatPitch(voice.profile.pitchSemitones)}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">{t('console.profile.speed')}</dt>
              <dd className="nums">{formatSpeed(voice.profile.speed, format.locale)}</dd>
            </div>
          </dl>
        )}

        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <Button
            variant="primary"
            leftIcon={<Clapperboard aria-hidden="true" />}
            disabled={!ready || !session.can('editor') || !startVideo.canOpen}
            loading={startVideo.isPending}
            onClick={() =>
              startVideo.start({
                title: t('console.videoTitle', { name: voice.name }),
                text: sampleText(language),
                locale: uiLocale,
                voice: { id: voice.id, language },
              })
            }
          >
            {t('console.use')}
          </Button>
          <Button
            variant="ghost"
            leftIcon={<Copy aria-hidden="true" />}
            onClick={() => void copyId()}
          >
            {t('console.copyId')}
          </Button>
        </div>

        {cloned && session.can('editor') && (
          <div className="border-t border-line pt-4">
            {renaming ? (
              <RenameVoice voice={voice} onDone={() => setRenaming(false)} />
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  leftIcon={<Pencil aria-hidden="true" />}
                  onClick={() => setRenaming(true)}
                >
                  {t('console.rename')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger-text"
                  leftIcon={<Trash2 aria-hidden="true" />}
                  loading={remove.isPending}
                  onClick={() => void askDelete()}
                >
                  {t('console.delete')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
