import {
  ALLOWED_UPLOAD_MIME,
  LANGUAGES,
  VOICE_PREVIEW_TEXTS,
  baseLanguage,
  languageName,
} from '@parlante/shared';
import type { AssetKind, Avatar, MediaRef, Voice } from '@parlante/shared';
import { getStockAvatarRig, restingAvatarState } from '@parlante/renderer';
import { Film, Music, Pause, Play, Search, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ProviderBadge } from '@/components/ProviderBadge';
import { PhotorealNotice as SharedPhotorealNotice } from '@/components/RenderSettings';
import { api, apiClient, toAppUrl, useUpload } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  FileDropzone,
  IconButton,
  Input,
  ProgressBar,
  SegmentedControl,
  Select,
  Skeleton,
  Spinner,
  cn,
  toast,
  useErrorText,
} from '@/ui';
import { context2d } from '../preview/engine';
import { useStudio } from '../state/context';

/* ---------- audio preview (one sound at a time) ---------- */

type Preview = { id: string; state: 'loading' | 'playing' } | null;

/** Plays one preview at a time; `toggle` starts, stops or switches. */
export function useAudioPreview() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const token = useRef(0);
  const [current, setCurrent] = useState<Preview>(null);
  const describe = useErrorText();

  const stop = () => {
    token.current += 1;
    audio.current?.pause();
    audio.current = null;
    setCurrent(null);
  };
  useEffect(() => stop, []);

  const toggle = async (id: string, source: () => Promise<string> | string) => {
    if (current?.id === id) return stop();
    stop();
    const mine = ++token.current;
    setCurrent({ id, state: 'loading' });
    try {
      const url = toAppUrl(await source());
      if (mine !== token.current) return;
      const element = new Audio(url);
      audio.current = element;
      element.addEventListener('ended', () => mine === token.current && stop());
      element.addEventListener('error', () => mine === token.current && stop());
      await element.play();
      if (mine === token.current) setCurrent({ id, state: 'playing' });
    } catch (error) {
      if (mine !== token.current) return;
      stop();
      const text = describe(error);
      toast.error(text.title, { description: text.message });
    }
  };
  return { current, toggle, stop };
}

function PreviewButton({
  state,
  label,
  onClick,
}: {
  state: 'idle' | 'loading' | 'playing';
  label: string;
  onClick: () => void;
}) {
  return (
    <IconButton label={label} size="sm" variant="secondary" onClick={onClick}>
      {state === 'loading' ? (
        <Spinner size="sm" label={null} />
      ) : state === 'playing' ? (
        <Pause aria-hidden="true" />
      ) : (
        <Play aria-hidden="true" />
      )}
    </IconButton>
  );
}

/* ---------- avatars ---------- */

/** Thumbnail of an avatar: 2D rigs are drawn with the renderer, photoreal ones are images. */
export function AvatarThumb({
  avatar,
  className,
}: {
  avatar: Avatar | string;
  className?: string;
}) {
  const id = typeof avatar === 'string' ? avatar : avatar.id;
  const image = typeof avatar === 'string' ? null : avatar.thumbnailUrl;
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || image) return;
    const rig = getStockAvatarRig(id);
    const ctx = context2d(canvas);
    if (!rig || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    rig.draw(ctx, { x: 0, y: 0, w: canvas.width, h: canvas.height }, restingAvatarState(), {
      framing: 'bust',
      flip: false,
      quality: 'preview',
    });
  }, [id, image]);
  return (
    <span className={cn('block overflow-hidden rounded-md bg-surface-3', className)}>
      {image ? (
        <img src={toAppUrl(image)} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <canvas ref={ref} width={192} height={192} aria-hidden="true" className="h-full w-full" />
      )}
    </span>
  );
}

/**
 * Honest note about photorealistic avatars (measured render time, availability, licence): the
 * shell's notice with the engine status the Studio already loaded, plus what only applies here.
 */
export function PhotorealNotice({ className }: { className?: string }) {
  const { t } = useTranslation('studio');
  const { library } = useStudio();
  return (
    <SharedPhotorealNotice
      engine={library.avatarEngine}
      note={t('avatar.photorealPreview')}
      size="sm"
      className={className}
    />
  );
}

export function AvatarPickerDialog({
  open,
  onOpenChange,
  value,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string | null;
  onPick: (avatar: Avatar) => void;
}) {
  const { t } = useTranslation('studio');
  const { library } = useStudio();
  const [rendering, setRendering] = useState<'all' | 'instant' | 'photoreal'>('all');
  const [search, setSearch] = useState('');
  const { avatars } = library;
  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return avatars.items.filter(
      (avatar) =>
        (rendering === 'all' || avatar.rendering === rendering) &&
        (needle === '' ||
          `${avatar.name} ${avatar.description} ${avatar.tags.join(' ')}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [avatars.items, rendering, search]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('avatar.pickTitle')}
      description={t('avatar.pickText')}
      size="xl"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            aria-label={t('avatar.filter')}
            size="sm"
            value={rendering}
            onValueChange={setRendering}
            options={[
              { value: 'all', label: t('avatar.all') },
              { value: 'instant', label: t('avatar.instant') },
              { value: 'photoreal', label: t('avatar.photoreal') },
            ]}
          />
          <Input
            size="sm"
            type="search"
            aria-label={t('avatar.search')}
            placeholder={t('avatar.search')}
            leading={<Search className="size-4" aria-hidden="true" />}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            wrapperClassName="min-w-48 flex-1"
          />
        </div>
        {rendering !== 'instant' && <PhotorealNotice />}
        {avatars.isPending ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="aspect-square" />
            ))}
          </div>
        ) : avatars.error ? (
          <ErrorState size="sm" error={avatars.error} onRetry={avatars.refetch} />
        ) : items.length === 0 ? (
          <EmptyState size="sm" title={t('avatar.empty')} />
        ) : (
          <ul className="grid max-h-[50vh] grid-cols-3 gap-3 overflow-y-auto p-0.5 sm:grid-cols-5">
            {items.map((avatar) => {
              const ready = avatar.status === 'ready';
              return (
                <li key={avatar.id}>
                  <button
                    type="button"
                    disabled={!ready}
                    aria-pressed={avatar.id === value}
                    onClick={() => onPick(avatar)}
                    className={cn(
                      'flex w-full flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors disabled:opacity-50',
                      avatar.id === value
                        ? 'border-accent bg-accent-soft'
                        : 'border-line hover:border-line-strong hover:bg-surface-2',
                    )}
                  >
                    <AvatarThumb avatar={avatar} className="aspect-square w-full" />
                    <span className="truncate px-0.5 text-sm font-semibold">{avatar.name}</span>
                    <Badge
                      size="sm"
                      tone={avatar.rendering === 'photoreal' ? 'saffron' : 'neutral'}
                      className="self-start"
                    >
                      {!ready
                        ? t(`avatar.status.${avatar.status}`)
                        : avatar.rendering === 'photoreal'
                          ? t('avatar.photorealBadge')
                          : t('avatar.instantBadge')}
                    </Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/* ---------- voices ---------- */

export function VoicePickerDialog({
  open,
  onOpenChange,
  value,
  language,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  language: string;
  onPick: (voice: Voice) => void;
}) {
  const { t } = useTranslation('studio');
  const format = useFormat();
  const { library } = useStudio();
  const uiLocale = format.locale === 'en' ? 'en' : 'es';
  const [filter, setFilter] = useState<string>(baseLanguage(language) ?? 'all');
  const [search, setSearch] = useState('');
  const preview = useAudioPreview();
  const { voices } = library;

  useEffect(() => {
    if (open) setFilter(baseLanguage(language) ?? 'all');
    else preview.stop();
    // Reset only when the dialog opens or closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return voices.items.filter(
      (voice) =>
        (filter === 'all' || voice.multilingual || baseLanguage(voice.language) === filter) &&
        (needle === '' ||
          `${voice.name} ${voice.description} ${voice.tags.join(' ')}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [voices.items, filter, search]);

  const previewVoice = (voice: Voice) => {
    const lang = voice.multilingual && filter !== 'all' ? filter : voice.language;
    const text =
      VOICE_PREVIEW_TEXTS[baseLanguage(lang) ?? 'es'] ?? (VOICE_PREVIEW_TEXTS.es as string);
    return preview.toggle(voice.id, async () => {
      const speech = await apiClient.voices.synthesize({
        body: { text, voiceId: voice.id, language: lang, speed: 1, pitch: 0 },
      });
      return speech.audioUrl;
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('voice.pickTitle')}
      description={t('voice.pickText')}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            size="sm"
            aria-label={t('voice.language')}
            value={filter}
            onValueChange={setFilter}
            wrapperClassName="w-44"
            options={[
              { value: 'all', label: t('voice.allLanguages') },
              ...LANGUAGES.map((lang) => ({
                value: lang.code as string,
                label: languageName(lang.code, uiLocale),
              })),
            ]}
          />
          <Input
            size="sm"
            type="search"
            aria-label={t('voice.search')}
            placeholder={t('voice.search')}
            leading={<Search className="size-4" aria-hidden="true" />}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            wrapperClassName="min-w-40 flex-1"
          />
        </div>
        {voices.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : voices.error ? (
          <ErrorState size="sm" error={voices.error} onRetry={voices.refetch} />
        ) : items.length === 0 ? (
          <EmptyState size="sm" title={t('voice.empty')} />
        ) : (
          <ul className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto p-0.5">
            {items.map((voice) => {
              const ready = voice.status === 'ready';
              const state = preview.current?.id === voice.id ? preview.current.state : 'idle';
              return (
                <li
                  key={voice.id}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border p-2',
                    voice.id === value ? 'border-accent bg-accent-soft' : 'border-line',
                  )}
                >
                  <PreviewButton
                    state={state}
                    label={
                      state === 'idle'
                        ? t('voice.preview', { name: voice.name })
                        : t('voice.stopPreview', { name: voice.name })
                    }
                    onClick={() => void previewVoice(voice)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      <span className="truncate">{voice.name}</span>
                      {voice.kind === 'cloned' && (
                        <Badge size="sm" tone="info">
                          {t('voice.cloned')}
                        </Badge>
                      )}
                    </p>
                    <p className="truncate text-xs text-fg-muted">
                      {voice.multilingual
                        ? t('voice.multilingual')
                        : languageName(voice.language, uiLocale)}
                      {' · '}
                      {t(`voice.gender.${voice.gender}`)}
                    </p>
                  </div>
                  <ProviderBadge provider={voice.provider} size="sm" className="hidden sm:flex" />
                  <Button
                    size="sm"
                    variant={voice.id === value ? 'solid' : 'secondary'}
                    disabled={!ready}
                    aria-label={t('voice.useNamed', { name: voice.name })}
                    onClick={() => onPick(voice)}
                  >
                    {voice.id === value ? t('voice.inUse') : t('voice.use')}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/* ---------- media (uploads and built-in library) ---------- */

export interface PickedMedia {
  ref: MediaRef;
  kind: AssetKind;
  name: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

interface MediaItem extends PickedMedia {
  key: string;
  url: string;
  thumbnailUrl: string | null;
}

function MediaTile({
  item,
  preview,
  onPick,
}: {
  item: MediaItem;
  preview: ReturnType<typeof useAudioPreview>;
  onPick: (item: MediaItem) => void;
}) {
  const { t } = useTranslation('studio');
  const format = useFormat();
  if (item.kind === 'audio') {
    const state = preview.current?.id === item.key ? preview.current.state : 'idle';
    return (
      <li className="col-span-full flex items-center gap-3 rounded-lg border border-line p-2">
        <PreviewButton
          state={state}
          label={
            state === 'idle'
              ? t('media.preview', { name: item.name })
              : t('media.stopPreview', { name: item.name })
          }
          onClick={() => void preview.toggle(item.key, () => item.url)}
        />
        <Music className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{item.name}</span>
        {item.durationMs !== null && (
          <span className="nums font-mono text-xs text-fg-muted">
            {format.clock(item.durationMs)}
          </span>
        )}
        <Button
          size="sm"
          aria-label={t('media.useNamed', { name: item.name })}
          onClick={() => onPick(item)}
        >
          {t('media.use')}
        </Button>
      </li>
    );
  }
  const thumb = item.kind === 'image' ? (item.thumbnailUrl ?? item.url) : item.thumbnailUrl;
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(item)}
        aria-label={t('media.useNamed', { name: item.name })}
        className="group flex w-full flex-col gap-1.5 rounded-lg border border-line p-1.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
      >
        <span className="relative grid aspect-video w-full place-items-center overflow-hidden rounded-md bg-media text-on-media">
          {thumb ? (
            <img
              src={toAppUrl(thumb)}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <Film className="size-6 opacity-70" aria-hidden="true" />
          )}
          {item.kind === 'video' && item.durationMs !== null && (
            <span className="nums absolute right-1 bottom-1 rounded-sm bg-media/80 px-1 font-mono text-2xs">
              {format.clock(item.durationMs)}
            </span>
          )}
        </span>
        <span className="truncate px-0.5 text-xs font-medium">{item.name}</span>
      </button>
    </li>
  );
}

/**
 * Choose a media file of one kind: built-in library (generated by code, free to use) or the
 * workspace uploads, with upload in place.
 */
export function MediaPickerDialog({
  kind,
  open,
  onOpenChange,
  onPick,
  title,
  uploadsOnly = false,
}: {
  kind: AssetKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (media: PickedMedia) => void;
  title?: ReactNode;
  /** Only workspace uploads can be chosen (e.g. narration audio must be an asset). */
  uploadsOnly?: boolean;
}) {
  const { t } = useTranslation('studio');
  const session = useSession();
  const describe = useErrorText();
  const { library } = useStudio();
  const [chosen, setSource] = useState<'stock' | 'uploads'>('stock');
  const source = uploadsOnly ? 'uploads' : chosen;
  const preview = useAudioPreview();
  const uploader = useUpload(api.assets.upload, { invalidates: [api.assets.list] });

  useEffect(() => {
    if (!open) preview.stop();
    // Stop the sound when the dialog closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stock = useMemo<MediaItem[]>(
    () =>
      library.stock.items
        .filter((item) => item.kind === kind)
        .map((item) => ({
          key: `stock:${item.id}`,
          ref: { source: 'stock', stockId: item.id },
          kind: item.kind,
          name: item.name,
          width: item.width,
          height: item.height,
          durationMs: item.durationMs,
          url: item.url,
          thumbnailUrl: null,
        })),
    [library.stock.items, kind],
  );
  const uploads = useMemo<MediaItem[]>(
    () =>
      library.assets.items
        .filter((asset) => asset.kind === kind)
        .map((asset) => ({
          key: `asset:${asset.id}`,
          ref: { source: 'asset', assetId: asset.id },
          kind: asset.kind,
          name: asset.name,
          width: asset.width,
          height: asset.height,
          durationMs: asset.durationMs,
          url: asset.url,
          thumbnailUrl: asset.thumbnailUrl,
        })),
    [library.assets.items, kind],
  );
  const list = source === 'stock' ? library.stock : library.assets;
  const items = source === 'stock' ? stock : uploads;
  const pick = (item: MediaItem) => {
    preview.stop();
    onPick(item);
  };

  const upload = async (file: File) => {
    try {
      const asset = await uploader.upload({ file, fields: { name: file.name.slice(0, 120) } });
      uploader.reset();
      if (asset.kind !== kind) {
        toast.warning(t('media.wrongKind'));
        return;
      }
      pick({
        key: `asset:${asset.id}`,
        ref: { source: 'asset', assetId: asset.id },
        kind: asset.kind,
        name: asset.name,
        width: asset.width,
        height: asset.height,
        durationMs: asset.durationMs,
        url: asset.url,
        thumbnailUrl: asset.thumbnailUrl,
      });
    } catch {
      // Shown inline through `uploader.error`.
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? t(`media.title.${kind}`)}
      description={t('media.text')}
      size="xl"
      dismissible={uploader.status !== 'uploading'}
    >
      <div className="flex flex-col gap-4">
        {!uploadsOnly && (
          <SegmentedControl
            aria-label={t('media.source')}
            size="sm"
            value={source}
            onValueChange={setSource}
            options={[
              { value: 'stock', label: t('media.stock') },
              { value: 'uploads', label: t('media.uploads') },
            ]}
          />
        )}
        {source === 'uploads' &&
          (uploader.status === 'uploading' ? (
            <div className="flex items-center gap-3 rounded-lg border border-line p-3">
              <ProgressBar
                className="flex-1"
                size="sm"
                label={t('media.uploading')}
                value={uploader.progress * 100}
              />
              <Button size="sm" variant="ghost" onClick={uploader.cancel}>
                {t('common.cancel')}
              </Button>
            </div>
          ) : (
            <FileDropzone
              compact
              accept={ALLOWED_UPLOAD_MIME[kind]}
              maxSizeBytes={session.plan.limits.maxUploadBytes}
              icon={<Upload aria-hidden="true" />}
              title={t(`media.upload.${kind}`)}
              error={uploader.error ? describe(uploader.error).title : undefined}
              onFiles={(files) => {
                const file = files[0];
                if (file) void upload(file);
              }}
            />
          ))}
        {list.isPending ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="aspect-video" />
            ))}
          </div>
        ) : list.error ? (
          <ErrorState size="sm" error={list.error} onRetry={list.refetch} />
        ) : items.length === 0 ? (
          <EmptyState
            size="sm"
            title={source === 'stock' ? t('media.emptyStock') : t(`media.emptyUploads.${kind}`)}
          />
        ) : (
          <ul className="grid max-h-[46vh] grid-cols-2 gap-3 overflow-y-auto p-0.5 sm:grid-cols-4">
            {items.map((item) => (
              <MediaTile key={item.key} item={item} preview={preview} onPick={pick} />
            ))}
          </ul>
        )}
        {source === 'uploads' && library.assets.hasMore && (
          <Button
            size="sm"
            variant="ghost"
            className="self-center"
            loading={library.assets.loadingMore}
            onClick={library.assets.loadMore}
          >
            {t('media.more')}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
