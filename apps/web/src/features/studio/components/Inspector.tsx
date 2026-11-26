import {
  COMPOSITION_LIMITS,
  SUBTITLE_PRESETS,
  TRANSITION_TYPES,
  FONT_FAMILY_NAMES,
  applyBrandKit,
  avatarRenderingOf,
  pickDefaultVoiceId,
  mediaRefKey,
} from '@parlante/shared';
import type { Background, Fit, MediaRef, Scene, Script } from '@parlante/shared';
import {
  AudioLines,
  Film,
  ImageIcon,
  Layers,
  Music,
  Palette,
  RefreshCw,
  Trash2,
  UserRound,
  Volume2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ProviderBadge, useProviderName } from '@/components/ProviderBadge';
import { formatFixed, useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Button,
  Input,
  SegmentedControl,
  Select,
  Slider,
  Spinner,
  Switch,
  Tabs,
  TabPanel,
  Textarea,
  toast,
  useErrorText,
} from '@/ui';
import { defaultAvatarBox } from '../model/editor';
import { sceneDurationInfo, wordCount } from '../model/timing';
import {
  selectComposition,
  selectScene,
  useEditor,
  usePreviewState,
  useStudio,
} from '../state/context';
import { ColorField, NumberField, Pair, Section } from './controls';
import { LayerInspector } from './LayerInspector';
import {
  AvatarPickerDialog,
  AvatarThumb,
  MediaPickerDialog,
  PhotorealNotice,
  VoicePickerDialog,
} from './pickers';

const FITS: Fit[] = ['cover', 'contain', 'fill'];
const pct = (value: number) => `${Math.round(value * 100)} %`;

/** Button-like row that shows the chosen media file and opens the picker. */
function MediaSlot({
  src,
  kind,
  onPick,
  label,
}: {
  src: MediaRef | null;
  kind: 'image' | 'video' | 'audio';
  onPick: (ref: MediaRef) => void;
  label: string;
}) {
  const { t } = useTranslation('studio');
  const { library } = useStudio();
  const [open, setOpen] = useState(false);
  const key = src ? mediaRefKey(src) : null;
  const name = key ? library.mediaName(key) : null;
  const missing =
    key !== null && name === null && !library.assets.isPending && !library.stock.isPending;
  const Icon = kind === 'image' ? ImageIcon : kind === 'video' ? Film : Music;
  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={() => setOpen(true)}
        className="flex h-10 w-full items-center gap-2.5 rounded-md border border-line-control bg-surface px-2.5 text-left text-sm hover:bg-surface-2"
      >
        <Icon className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {src === null ? (
            <span className="text-fg-muted">{t('media.choose')}</span>
          ) : missing ? (
            <span className="text-danger-text">{t('media.missing')}</span>
          ) : (
            (name ?? t('media.loading'))
          )}
        </span>
        <span className="text-xs font-semibold text-accent-text">
          {src === null ? t('media.pick') : t('media.change')}
        </span>
      </button>
      <MediaPickerDialog
        kind={kind}
        open={open}
        onOpenChange={setOpen}
        onPick={(picked) => {
          onPick(picked.ref);
          setOpen(false);
        }}
      />
    </>
  );
}

/* ---------- scene: script ---------- */

function ScriptSection({ scene }: { scene: Scene }) {
  const providerName = useProviderName();
  const { t } = useTranslation('studio');
  const format = useFormat();
  const describe = useErrorText();
  const { store, engine, library } = useStudio();
  const { runtime } = usePreviewState();
  const { apply, seal } = store.getState();
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const script = scene.script;
  const info = sceneDurationInfo(scene, runtime.scenes[scene.id]);
  const narration = engine.narrationFor(scene.id);
  const patch = (value: Parameters<typeof apply>[0] & { type: 'scene.scriptPatch' }, key: string) =>
    apply(value, `${scene.id}:${key}`);

  const setKind = (kind: Script['kind']) => {
    if (kind === script.kind) return;
    if (kind === 'none')
      return apply({ type: 'scene.script', sceneId: scene.id, script: { kind } });
    if (kind === 'tts') {
      // Reuse the voice of a neighbouring scene so the video keeps one narrator.
      const other = store
        .getState()
        .history.present.composition.scenes.find((s) => s.script.kind === 'tts')?.script;
      const base = other?.kind === 'tts' ? other : null;
      return apply({
        type: 'scene.script',
        sceneId: scene.id,
        script: {
          kind: 'tts',
          text: script.kind === 'audio' ? script.transcript : '',
          // No narrator yet: the voice the server recommends (a local neural one if installed).
          voiceId: base?.voiceId ?? pickDefaultVoiceId(library.voices.items, 'es'),
          language: base?.language ?? 'es',
          speed: base?.speed ?? 1,
          pitch: base?.pitch ?? 0,
        },
      });
    }
    setAudioOpen(true);
  };

  const voice = script.kind === 'tts' ? library.voiceById(script.voiceId) : undefined;
  const failure = narration.status === 'error' ? describe(narration.error) : null;

  return (
    <Section
      title={t('script.title')}
      aside={
        <span className="nums font-mono text-2xs text-fg-muted" data-testid="scene-duration">
          {info.estimated ? '≈ ' : ''}
          {format.timecode(info.durationMs)}
        </span>
      }
    >
      <SegmentedControl
        aria-label={t('script.kind')}
        size="sm"
        block
        value={script.kind}
        onValueChange={setKind}
        options={[
          { value: 'tts', label: t('script.kindTts') },
          { value: 'audio', label: t('script.kindAudio') },
          { value: 'none', label: t('script.kindNone') },
        ]}
      />
      {script.kind === 'tts' && (
        <>
          <Textarea
            label={t('script.text')}
            rows={6}
            maxLength={COMPOSITION_LIMITS.maxScriptChars}
            placeholder={t('script.placeholder')}
            value={script.text}
            dictationLanguage={script.language}
            onChange={(event) =>
              patch(
                {
                  type: 'scene.scriptPatch',
                  sceneId: scene.id,
                  patch: { text: event.target.value },
                },
                'script',
              )
            }
            onBlur={seal}
            hint={t('script.variablesHint', { open: '{{', close: '}}' })}
          />
          <div className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
            <span className="nums" data-testid="script-counter">
              {t('script.words', { count: wordCount(script.text) })}
              {' · '}
              {info.narrationMs > 0
                ? info.estimated
                  ? t('script.estimated', { time: format.duration(info.narrationMs) })
                  : t('script.measured', { time: format.duration(info.narrationMs) })
                : t('script.silent')}
            </span>
            {narration.status === 'loading' && script.text.trim() !== '' && (
              <span className="flex items-center gap-1" role="status">
                <Spinner size="xs" label={null} />
                {t('script.synthesising')}
              </span>
            )}
            {narration.status === 'ready' && narration.provider && (
              <ProviderBadge provider={narration.provider} size="sm" />
            )}
          </div>
          {failure && (
            <div role="alert" className="rounded-md bg-danger-soft p-2.5 text-xs text-danger-text">
              <p className="font-semibold">{t('script.failed')}</p>
              <p className="mt-0.5 break-words">{failure.message ?? failure.title}</p>
              <Button
                size="sm"
                variant="link"
                className="mt-1 text-xs"
                leftIcon={<RefreshCw aria-hidden="true" />}
                onClick={() => engine.retryNarrationFor(scene.id)}
              >
                {t('common.retry')}
              </Button>
            </div>
          )}

          <div>
            <p className="mb-1.5 text-sm font-medium">{t('voice.title')}</p>
            <button
              type="button"
              onClick={() => setVoiceOpen(true)}
              aria-label={t('voice.change')}
              className="flex w-full items-center gap-2.5 rounded-md border border-line-control bg-surface px-2.5 py-2 text-left hover:bg-surface-2"
            >
              <Volume2 className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold" data-testid="voice-name">
                  {voice?.name ?? script.voiceId}
                </span>
                <span className="block truncate text-xs text-fg-muted">
                  {voice
                    ? `${providerName(voice.provider)} · ${script.language}`
                    : library.voices.isPending
                      ? t('common.loading')
                      : t('voice.unknown')}
                </span>
              </span>
              <span className="text-xs font-semibold text-accent-text">{t('media.change')}</span>
            </button>
          </div>
          <Slider
            label={t('voice.speed')}
            min={0.5}
            max={2}
            step={0.05}
            value={script.speed}
            formatValue={(value) => `${formatFixed(value, 2)}×`}
            onValueChange={(speed) =>
              patch({ type: 'scene.scriptPatch', sceneId: scene.id, patch: { speed } }, 'speed')
            }
            onValueCommit={seal}
          />
          <Slider
            label={t('voice.pitch')}
            // A voice may honour a shorter range than the document allows (neural voices).
            min={voice?.pitchRange?.minSemitones ?? -12}
            max={voice?.pitchRange?.maxSemitones ?? 12}
            step={1}
            value={Math.min(
              voice?.pitchRange?.maxSemitones ?? 12,
              Math.max(voice?.pitchRange?.minSemitones ?? -12, script.pitch),
            )}
            formatValue={(value) => t('voice.semitones', { count: value })}
            onValueChange={(pitch) =>
              patch({ type: 'scene.scriptPatch', sceneId: scene.id, patch: { pitch } }, 'pitch')
            }
            onValueCommit={seal}
          />
          {voice?.pitchRange?.resampled && (
            <p className="-mt-1 text-xs text-pretty text-fg-muted" data-testid="pitch-note">
              {t('voice.pitchResampled', { max: voice.pitchRange.maxSemitones })}
            </p>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => {
              apply({ type: 'voice.applyAll', fromSceneId: scene.id });
              toast.success(t('voice.appliedAll'));
            }}
          >
            {t('voice.applyAll')}
          </Button>
          <VoicePickerDialog
            open={voiceOpen}
            onOpenChange={setVoiceOpen}
            value={script.voiceId}
            language={script.language}
            onPick={(picked) => {
              apply({
                type: 'scene.scriptPatch',
                sceneId: scene.id,
                patch: {
                  voiceId: picked.id,
                  language: picked.multilingual ? script.language : picked.language,
                },
              });
              setVoiceOpen(false);
            }}
          />
        </>
      )}
      {script.kind === 'audio' && (
        <>
          <button
            type="button"
            onClick={() => setAudioOpen(true)}
            className="flex h-10 w-full items-center gap-2.5 rounded-md border border-line-control bg-surface px-2.5 text-left text-sm hover:bg-surface-2"
          >
            <AudioLines className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              {library.mediaName(`asset:${script.assetId}`) ?? t('media.loading')}
            </span>
            <span className="text-xs font-semibold text-accent-text">{t('media.change')}</span>
          </button>
          <Textarea
            label={t('script.transcript')}
            rows={4}
            maxLength={COMPOSITION_LIMITS.maxScriptChars}
            value={script.transcript}
            hint={t('script.transcriptHint')}
            onChange={(event) =>
              patch(
                {
                  type: 'scene.scriptPatch',
                  sceneId: scene.id,
                  patch: { transcript: event.target.value },
                },
                'transcript',
              )
            }
            onBlur={seal}
          />
          {narration.silent && <p className="text-xs text-warning-text">{t('script.noDecode')}</p>}
        </>
      )}
      {script.kind === 'none' && <p className="text-sm text-fg-muted">{t('script.noneText')}</p>}
      <MediaPickerDialog
        kind="audio"
        uploadsOnly
        title={t('script.pickAudio')}
        open={audioOpen}
        onOpenChange={setAudioOpen}
        onPick={(picked) => {
          if (picked.ref.source !== 'asset') return;
          apply({
            type: 'scene.script',
            sceneId: scene.id,
            script: {
              kind: 'audio',
              assetId: picked.ref.assetId,
              transcript:
                script.kind === 'audio'
                  ? script.transcript
                  : script.kind === 'tts'
                    ? script.text
                    : '',
              language: script.kind === 'none' ? undefined : script.language,
            },
          });
          setAudioOpen(false);
        }}
      />
    </Section>
  );
}

/* ---------- scene: avatar shortcut ---------- */

function AvatarSection({ scene }: { scene: Scene }) {
  const { t } = useTranslation('studio');
  const { store, library } = useStudio();
  const canvas = useEditor((state) => state.history.present.composition.canvas);
  const [open, setOpen] = useState(false);
  const { apply, select } = store.getState();
  const layer = scene.layers.find((l) => l.type === 'avatar');
  const avatar = layer ? library.avatarById(layer.avatarId) : undefined;
  const photoreal = layer ? avatarRenderingOf(layer.avatarId) === 'photoreal' : false;
  return (
    <Section title={t('avatar.title')}>
      {layer ? (
        <div className="flex items-center gap-3">
          <AvatarThumb avatar={avatar ?? layer.avatarId} className="size-14 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold" data-testid="avatar-name">
              {avatar?.name ?? layer.name ?? layer.avatarId}
            </p>
            <p className="text-xs text-fg-muted">
              {photoreal ? t('avatar.photorealBadge') : t('avatar.instantBadge')}
            </p>
            <div className="mt-1 flex gap-3">
              <Button size="sm" variant="link" className="text-xs" onClick={() => setOpen(true)}>
                {t('avatar.change')}
              </Button>
              <Button
                size="sm"
                variant="link"
                className="text-xs"
                onClick={() => select({ layerId: layer.id })}
              >
                {t('avatar.adjust')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          className="self-start"
          leftIcon={<UserRound aria-hidden="true" />}
          onClick={() => setOpen(true)}
        >
          {t('avatar.add')}
        </Button>
      )}
      {photoreal && <PhotorealNotice />}
      <AvatarPickerDialog
        open={open}
        onOpenChange={setOpen}
        value={layer?.avatarId ?? null}
        onPick={(picked) => {
          if (layer) {
            apply({
              type: 'layer.patch',
              sceneId: scene.id,
              layerId: layer.id,
              patch: { avatarId: picked.id, name: picked.name.slice(0, 80) },
            });
          } else {
            apply({
              type: 'layer.add',
              sceneId: scene.id,
              layer: {
                type: 'avatar',
                name: picked.name.slice(0, 80),
                avatarId: picked.id,
                box: defaultAvatarBox(canvas),
              },
            });
          }
          setOpen(false);
        }}
      />
    </Section>
  );
}

/* ---------- scene: background, transition, duration ---------- */

function BackgroundSection({ scene }: { scene: Scene }) {
  const { t } = useTranslation('studio');
  const { store } = useStudio();
  const { apply, seal } = store.getState();
  const background = scene.background;
  const [pick, setPick] = useState<'image' | 'video' | null>(null);
  const set = (next: Background, key?: string) =>
    apply(
      { type: 'scene.background', sceneId: scene.id, background: next },
      key ? `${scene.id}:bg:${key}` : undefined,
    );

  const setType = (type: Background['type']) => {
    if (type === background.type) return;
    if (type === 'color') {
      const color =
        background.type === 'gradient'
          ? (background.gradient.stops[0]?.color ?? '#101322')
          : '#101322';
      return set({ type: 'color', color });
    }
    if (type === 'gradient') {
      const from = background.type === 'color' ? background.color : '#1b1424';
      return set({
        type: 'gradient',
        gradient: {
          kind: 'linear',
          angle: 135,
          stops: [
            { offset: 0, color: from },
            { offset: 1, color: '#ff5b2e' },
          ],
        },
      });
    }
    setPick(type);
  };

  return (
    <Section title={t('background.title')}>
      <SegmentedControl
        aria-label={t('background.type')}
        size="sm"
        block
        value={background.type}
        onValueChange={setType}
        options={[
          { value: 'color', label: t('background.color') },
          { value: 'gradient', label: t('background.gradient') },
          { value: 'image', label: t('background.image') },
          { value: 'video', label: t('background.video') },
        ]}
      />
      {background.type === 'color' && (
        <ColorField
          label={t('background.colorLabel')}
          value={background.color}
          onChange={(color) => set({ ...background, color }, 'color')}
        />
      )}
      {background.type === 'gradient' && (
        <>
          <div className="flex items-end gap-2">
            {background.gradient.stops.map((stop, index) => (
              <ColorField
                key={index}
                compact
                label={t('background.stop', { number: index + 1 })}
                value={stop.color}
                onChange={(color) =>
                  set(
                    {
                      ...background,
                      gradient: {
                        ...background.gradient,
                        stops: background.gradient.stops.map((s, i) =>
                          i === index ? { ...s, color } : s,
                        ),
                      },
                    },
                    `stop${index}`,
                  )
                }
              />
            ))}
            <Select
              size="sm"
              aria-label={t('background.gradientKind')}
              wrapperClassName="flex-1"
              value={background.gradient.kind}
              onValueChange={(kind) =>
                set({ ...background, gradient: { ...background.gradient, kind } })
              }
              options={[
                { value: 'linear', label: t('background.linear') },
                { value: 'radial', label: t('background.radial') },
              ]}
            />
          </div>
          {background.gradient.kind === 'linear' && (
            <Slider
              label={t('background.angle')}
              min={0}
              max={360}
              step={5}
              value={background.gradient.angle}
              formatValue={(value) => `${value}°`}
              onValueChange={(angle) =>
                set({ ...background, gradient: { ...background.gradient, angle } }, 'angle')
              }
              onValueCommit={seal}
            />
          )}
        </>
      )}
      {(background.type === 'image' || background.type === 'video') && (
        <>
          <MediaSlot
            kind={background.type}
            src={background.src}
            label={t('background.pick')}
            onPick={(src) => set({ ...background, src })}
          />
          <Select
            size="sm"
            label={t('fit.label')}
            value={background.fit}
            onValueChange={(fit) => set({ ...background, fit })}
            options={FITS.map((fit) => ({ value: fit, label: t(`fit.${fit}`) }))}
          />
          {background.type === 'image' && (
            <Slider
              label={t('background.blur')}
              min={0}
              max={0.1}
              step={0.005}
              value={background.blur}
              formatValue={(value) => pct(value * 10)}
              onValueChange={(blur) => set({ ...background, blur }, 'blur')}
              onValueCommit={seal}
            />
          )}
          <Slider
            label={t('background.dim')}
            min={0}
            max={1}
            step={0.05}
            value={background.dim}
            formatValue={pct}
            onValueChange={(dim) => set({ ...background, dim }, 'dim')}
            onValueCommit={seal}
          />
          {background.type === 'video' && (
            <>
              <Slider
                label={t('background.volume')}
                min={0}
                max={1}
                step={0.05}
                value={background.volume}
                formatValue={(value) => (value === 0 ? t('common.muted') : pct(value))}
                onValueChange={(volume) => set({ ...background, volume }, 'volume')}
                onValueCommit={seal}
              />
              <Switch
                size="sm"
                labelPosition="start"
                label={t('common.loop')}
                checked={background.loop}
                onCheckedChange={(loop) => set({ ...background, loop })}
              />
            </>
          )}
        </>
      )}
      <MediaPickerDialog
        kind={pick ?? 'image'}
        open={pick !== null}
        onOpenChange={(open) => !open && setPick(null)}
        onPick={(picked) => {
          set(
            pick === 'video'
              ? {
                  type: 'video',
                  src: picked.ref,
                  fit: 'cover',
                  loop: true,
                  volume: 0,
                  trimStartMs: 0,
                  dim: 0,
                }
              : { type: 'image', src: picked.ref, fit: 'cover', blur: 0, dim: 0 },
          );
          setPick(null);
        }}
      />
    </Section>
  );
}

function TimingSection({ scene, first }: { scene: Scene; first: boolean }) {
  const { t } = useTranslation('studio');
  const { store } = useStudio();
  const { apply, seal } = store.getState();
  const { runtime } = usePreviewState();
  const info = sceneDurationInfo(scene, runtime.scenes[scene.id]);
  const fixed = scene.duration.mode === 'fixed';
  return (
    <>
      <Section title={t('transition.title')}>
        {first ? (
          <p className="text-sm text-fg-muted">{t('transition.first')}</p>
        ) : (
          <>
            <Select
              size="sm"
              aria-label={t('transition.title')}
              value={scene.transition.type}
              onValueChange={(type) =>
                apply({ type: 'scene.transition', sceneId: scene.id, patch: { type } })
              }
              options={TRANSITION_TYPES.map((type) => ({
                value: type,
                label: t(`transition.type.${type}`),
              }))}
            />
            {scene.transition.type !== 'none' && (
              <Slider
                label={t('transition.duration')}
                min={100}
                max={2000}
                step={50}
                value={scene.transition.durationMs}
                formatValue={(value) => `${formatFixed(value / 1000, 2)} s`}
                onValueChange={(durationMs) =>
                  apply(
                    { type: 'scene.transition', sceneId: scene.id, patch: { durationMs } },
                    `${scene.id}:transition`,
                  )
                }
                onValueCommit={seal}
              />
            )}
          </>
        )}
      </Section>
      <Section title={t('duration.title')}>
        <SegmentedControl
          aria-label={t('duration.mode')}
          size="sm"
          block
          value={scene.duration.mode}
          onValueChange={(mode) =>
            apply({
              type: 'scene.patch',
              sceneId: scene.id,
              patch: {
                duration:
                  mode === 'auto'
                    ? { mode }
                    : { mode, seconds: Math.max(0.5, Math.round(info.durationMs / 100) / 10) },
              },
            })
          }
          options={[
            { value: 'auto', label: t('duration.auto') },
            { value: 'fixed', label: t('duration.fixed') },
          ]}
        />
        {scene.duration.mode === 'fixed' ? (
          <NumberField
            label={t('duration.seconds')}
            min={0.5}
            max={COMPOSITION_LIMITS.maxFixedSceneSeconds}
            step={0.5}
            digits={1}
            suffix="s"
            value={scene.duration.seconds}
            onChange={(seconds) =>
              apply(
                {
                  type: 'scene.patch',
                  sceneId: scene.id,
                  patch: { duration: { mode: 'fixed', seconds } },
                },
                `${scene.id}:seconds`,
              )
            }
            onCommit={seal}
          />
        ) : (
          <p className="text-xs text-fg-muted">{t('duration.autoText')}</p>
        )}
        {fixed && info.narrationMs + scene.paddingStartMs > info.durationMs && (
          <p className="text-xs text-warning-text">{t('duration.cut')}</p>
        )}
        <Pair>
          <NumberField
            label={t('duration.padStart')}
            min={0}
            max={10}
            step={0.1}
            digits={1}
            scale={0.001}
            suffix="s"
            value={scene.paddingStartMs}
            onChange={(ms) =>
              apply(
                {
                  type: 'scene.patch',
                  sceneId: scene.id,
                  patch: { paddingStartMs: Math.round(ms) },
                },
                `${scene.id}:padStart`,
              )
            }
            onCommit={seal}
          />
          <NumberField
            label={t('duration.padEnd')}
            min={0}
            max={10}
            step={0.1}
            digits={1}
            scale={0.001}
            suffix="s"
            value={scene.paddingEndMs}
            onChange={(ms) =>
              apply(
                { type: 'scene.patch', sceneId: scene.id, patch: { paddingEndMs: Math.round(ms) } },
                `${scene.id}:padEnd`,
              )
            }
            onCommit={seal}
          />
        </Pair>
      </Section>
    </>
  );
}

function SceneTab() {
  const { t } = useTranslation('studio');
  const { store } = useStudio();
  const scene = useEditor(selectScene);
  const first = useEditor(
    (state) => selectComposition(state).scenes[0]?.id === state.selection.sceneId,
  );
  if (!scene) return null;
  const { apply, seal } = store.getState();
  return (
    <>
      <div className="border-b border-line px-4 py-3">
        <Input
          size="sm"
          label={t('scenes.name')}
          maxLength={80}
          value={scene.name}
          onChange={(event) =>
            apply(
              { type: 'scene.patch', sceneId: scene.id, patch: { name: event.target.value } },
              `${scene.id}:name`,
            )
          }
          onBlur={seal}
        />
      </div>
      <ScriptSection key={scene.id} scene={scene} />
      <AvatarSection scene={scene} />
      <BackgroundSection scene={scene} />
      <TimingSection scene={scene} first={first} />
    </>
  );
}

/* ---------- video: subtitles, music, brand kit, variables ---------- */

function VideoTab() {
  const { t } = useTranslation('studio');
  const format = useFormat();
  const session = useSession();
  const { store, library } = useStudio();
  const composition = useEditor(selectComposition);
  const { timeline } = usePreviewState();
  const { apply, seal } = store.getState();
  const { subtitles, music } = composition;
  const [kitId, setKitId] = useState<string | undefined>(undefined);
  const kits = library.brandKits;
  const chosenKit =
    kits.items.find((kit) => kit.id === (kitId ?? composition.brandKitId)) ??
    kits.items.find((kit) => kit.isDefault) ??
    kits.items[0];
  const sub = (patch: Partial<typeof subtitles>, key?: string) =>
    apply({ type: 'subtitles.patch', patch }, key ? `subtitles:${key}` : undefined);
  const maxSec = session.plan.limits.maxVideoDurationSec;

  return (
    <>
      {timeline.totalMs > maxSec * 1000 && (
        <p
          role="alert"
          className="border-b border-line bg-warning-soft px-4 py-2.5 text-xs text-warning-text"
        >
          {t('video.tooLong', {
            duration: format.duration(timeline.totalMs),
            max: format.duration(maxSec * 1000),
            plan: session.plan.name,
          })}
        </p>
      )}
      <Section
        title={t('subtitles.title')}
        aside={
          <Switch
            size="sm"
            aria-label={t('subtitles.enabled')}
            checked={subtitles.enabled}
            onCheckedChange={(enabled) => sub({ enabled })}
          />
        }
      >
        {subtitles.enabled ? (
          <>
            <Select
              size="sm"
              label={t('subtitles.preset')}
              value={subtitles.preset}
              onValueChange={(preset) => sub({ preset })}
              options={SUBTITLE_PRESETS.map((preset) => ({
                value: preset,
                label: t(`subtitles.presets.${preset}`),
                description: t(`subtitles.presetHints.${preset}`),
              }))}
            />
            <Pair>
              <Select
                size="sm"
                label={t('subtitles.position')}
                value={subtitles.position}
                onValueChange={(position) => sub({ position })}
                options={(['top', 'middle', 'bottom'] as const).map((position) => ({
                  value: position,
                  label: t(`subtitles.positions.${position}`),
                }))}
              />
              <Select
                size="sm"
                label={t('text.font')}
                value={subtitles.fontFamily}
                onValueChange={(fontFamily) => sub({ fontFamily })}
                options={FONT_FAMILY_NAMES.map((family) => ({ value: family, label: family }))}
              />
            </Pair>
            <Slider
              label={t('text.size')}
              min={0.02}
              max={0.1}
              step={0.0025}
              value={subtitles.fontSize}
              formatValue={(value) => `${formatFixed(value * 100, 1)} %`}
              onValueChange={(fontSize) => sub({ fontSize }, 'size')}
              onValueCommit={seal}
            />
            <div className="flex items-end gap-2">
              <ColorField
                compact
                label={t('subtitles.color')}
                value={subtitles.color}
                onChange={(color) => sub({ color }, 'color')}
              />
              {subtitles.preset === 'karaoke' && (
                <ColorField
                  compact
                  label={t('subtitles.highlight')}
                  value={subtitles.highlightColor}
                  onChange={(highlightColor) => sub({ highlightColor }, 'highlight')}
                />
              )}
              {(subtitles.preset === 'boxed' || subtitles.preset === 'karaoke') && (
                <ColorField
                  compact
                  label={t('subtitles.box')}
                  value={subtitles.backgroundColor}
                  onChange={(backgroundColor) => sub({ backgroundColor }, 'box')}
                />
              )}
              <Switch
                size="sm"
                className="ml-auto"
                label={t('text.uppercase')}
                checked={subtitles.uppercase}
                onCheckedChange={(uppercase) => sub({ uppercase })}
              />
            </div>
          </>
        ) : (
          <p className="text-sm text-fg-muted">{t('subtitles.off')}</p>
        )}
      </Section>

      <Section
        title={t('music.title')}
        aside={
          music && (
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Trash2 aria-hidden="true" />}
              onClick={() => apply({ type: 'music.set', music: null })}
            >
              {t('music.remove')}
            </Button>
          )
        }
      >
        <MediaSlot
          kind="audio"
          src={music?.src ?? null}
          label={t('music.pick')}
          onPick={(src) =>
            apply({
              type: 'music.set',
              music: music
                ? { ...music, src }
                : { src, volume: 0.18, ducking: true, fadeInMs: 500, fadeOutMs: 1500, loop: true },
            })
          }
        />
        {music ? (
          <>
            <Slider
              label={t('music.volume')}
              min={0}
              max={1}
              step={0.01}
              value={music.volume}
              formatValue={pct}
              onValueChange={(volume) =>
                apply({ type: 'music.patch', patch: { volume } }, 'music:volume')
              }
              onValueCommit={seal}
            />
            <Switch
              size="sm"
              labelPosition="start"
              label={t('music.ducking')}
              description={t('music.duckingHint')}
              checked={music.ducking}
              onCheckedChange={(ducking) => apply({ type: 'music.patch', patch: { ducking } })}
            />
            <Switch
              size="sm"
              labelPosition="start"
              label={t('common.loop')}
              checked={music.loop}
              onCheckedChange={(loop) => apply({ type: 'music.patch', patch: { loop } })}
            />
          </>
        ) : (
          <p className="text-xs text-fg-muted">{t('music.none')}</p>
        )}
      </Section>

      <Section title={t('brand.title')}>
        {kits.isPending ? (
          <Spinner label={t('common.loading')} />
        ) : kits.error ? (
          <p className="text-xs text-danger-text">{t('brand.error')}</p>
        ) : !chosenKit ? (
          <p className="text-sm text-fg-muted">{t('brand.empty')}</p>
        ) : (
          <>
            <Select
              size="sm"
              aria-label={t('brand.choose')}
              value={chosenKit.id}
              onValueChange={setKitId}
              options={kits.items.map((kit) => ({ value: kit.id, label: kit.name }))}
            />
            <div className="flex items-center gap-1.5" aria-hidden="true">
              {Object.values(chosenKit.colors).map((color, index) => (
                <span
                  key={index}
                  className="size-5 rounded-full border border-line-strong"
                  style={{ background: color }}
                />
              ))}
              <span className="ml-1 truncate text-xs text-fg-muted">
                {chosenKit.fonts.heading} / {chosenKit.fonts.body}
              </span>
            </div>
            <Button
              size="sm"
              className="self-start"
              leftIcon={<Palette aria-hidden="true" />}
              onClick={() => {
                apply({
                  type: 'composition.replace',
                  composition: applyBrandKit(composition, {
                    id: chosenKit.id,
                    logoAssetId: chosenKit.logoAssetId,
                    colors: chosenKit.colors,
                    fonts: chosenKit.fonts,
                  }),
                });
                toast.success(t('brand.applied', { name: chosenKit.name }));
              }}
            >
              {t('brand.apply')}
            </Button>
            <p className="text-xs text-fg-muted">{t('brand.hint')}</p>
          </>
        )}
      </Section>

      {composition.variables.length > 0 && (
        <Section title={t('variables.title')}>
          <p className="text-xs text-fg-muted">{t('variables.text')}</p>
          {composition.variables.map((variable) => (
            <Input
              key={variable.name}
              size="sm"
              label={`{{${variable.name}}}`}
              placeholder={t('variables.placeholder')}
              maxLength={500}
              value={variable.defaultValue}
              hint={variable.defaultValue.trim() === '' ? t('variables.empty') : undefined}
              onChange={(event) =>
                apply(
                  {
                    type: 'variable.patch',
                    name: variable.name,
                    patch: { defaultValue: event.target.value },
                  },
                  `variable:${variable.name}`,
                )
              }
              onBlur={seal}
            />
          ))}
        </Section>
      )}
    </>
  );
}

/** Right-hand panel: properties of the scene, of the selected layer and of the whole video. */
export function Inspector() {
  const { t } = useTranslation('studio');
  const layerId = useEditor((state) => state.selection.layerId);
  const [tab, setTab] = useState<'scene' | 'layer' | 'video'>('scene');
  // Selecting a layer on the stage brings its properties forward; deselecting returns.
  useEffect(() => {
    setTab((current) => (layerId ? 'layer' : current === 'layer' ? 'scene' : current));
  }, [layerId]);
  return (
    <aside
      aria-label={t('inspector.label')}
      className="flex w-80 shrink-0 flex-col border-l border-line bg-surface"
    >
      <Tabs
        aria-label={t('inspector.label')}
        className="min-h-0 flex-1"
        value={tab}
        onValueChange={setTab}
        fill
        tabs={[
          { value: 'scene', label: t('inspector.scene') },
          { value: 'layer', label: t('inspector.layers'), icon: <Layers aria-hidden="true" /> },
          { value: 'video', label: t('inspector.video') },
        ]}
      >
        <TabPanel value="scene" className="min-h-0 flex-1 overflow-y-auto">
          <SceneTab />
        </TabPanel>
        <TabPanel value="layer" className="min-h-0 flex-1 overflow-y-auto">
          <LayerInspector />
        </TabPanel>
        <TabPanel value="video" className="min-h-0 flex-1 overflow-y-auto">
          <VideoTab />
        </TabPanel>
      </Tabs>
    </aside>
  );
}
