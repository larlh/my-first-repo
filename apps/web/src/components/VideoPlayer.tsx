import { parseSubtitles } from '@parlante/shared';
import type { TimedText } from '@parlante/shared';
import {
  Captions,
  CaptionsOff,
  Download,
  Gauge,
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Slider as RadixSlider } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toAppUrl } from '@/lib/api/files';
import { cn } from '@/lib/cn';
import { formatClock } from '@/lib/format';
import {
  Menu,
  MenuContent,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '@/ui/Menu';
import { Spinner } from '@/ui/Spinner';
import { Tooltip } from '@/ui/Tooltip';

export interface SubtitleTrack {
  /** BCP-47 language of the track (`es`, `en`…); also its id. */
  lang: string;
  /** Name shown in the captions menu ("Español"). */
  label: string;
  /** URL of a WebVTT or SRT file (fetched and parsed by the player)… */
  src?: string | null;
  /** …or cues already in memory. */
  cues?: readonly TimedText[];
}

export interface VideoPlayerProps {
  src: string;
  /** Accessible name of the player (the video title). */
  title: string;
  poster?: string | null;
  subtitles?: readonly SubtitleTrack[];
  /** Language shown at start; `null` = captions off. Defaults to the first track. */
  defaultSubtitleLang?: string | null;
  /** Shape of the frame. The picture is letterboxed inside it, never cropped. */
  aspect?: '16:9' | '9:16' | '1:1';
  autoPlay?: boolean;
  loop?: boolean;
  /** Shows a download button linking to this URL. */
  downloadUrl?: string | null;
  downloadName?: string;
  onEnded?: () => void;
  onTimeUpdate?: (currentMs: number) => void;
  className?: string;
}

const ASPECT = { '16:9': 'aspect-video', '9:16': 'aspect-[9/16]', '1:1': 'aspect-square' } as const;
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const OFF = '__off__';

function ControlButton({
  label,
  children,
  className,
  ...props
}: ComponentProps<'button'> & { label: string; children: ReactNode }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-md text-on-media/90 transition-colors duration-100',
          'hover:bg-on-media/15 hover:text-on-media focus-visible:outline-on-media [&_svg]:size-[1.125rem]',
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function cueAt(cues: readonly TimedText[] | undefined, ms: number): TimedText | null {
  if (!cues) return null;
  for (const cue of cues) {
    if (ms >= cue.startMs && ms < cue.endMs) return cue;
    if (cue.startMs > ms) break;
  }
  return null;
}

/**
 * Video player with Parlante controls and subtitles.
 *
 * Subtitles are fetched as text (VTT or SRT) and drawn by the player, so they look the same
 * in every browser and work with signed, cross-origin file URLs.
 *
 * Keyboard (focus on the player): Space/K play·pause, ←/→ ±5 s, ↑/↓ volume, M mute,
 * C captions, F full screen, Home/End start·end.
 */
export function VideoPlayer({
  src,
  title,
  poster,
  subtitles,
  defaultSubtitleLang,
  aspect = '16:9',
  autoPlay = false,
  loop = false,
  downloadUrl,
  downloadName,
  onEnded,
  onTimeUpdate,
  className,
}: VideoPlayerProps) {
  const { t } = useTranslation('shell');
  const frame = useRef<HTMLDivElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const hideTimer = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [bufferedMs, setBufferedMs] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);

  const tracks = useMemo(() => subtitles ?? [], [subtitles]);
  const [lang, setLang] = useState<string | null>(
    defaultSubtitleLang === undefined ? (tracks[0]?.lang ?? null) : defaultSubtitleLang,
  );
  const lastLang = useRef<string | null>(lang ?? tracks[0]?.lang ?? null);
  const [loaded, setLoaded] = useState<Record<string, readonly TimedText[]>>({});

  // Load the cues of the selected track (once per URL).
  const active = tracks.find((track) => track.lang === lang) ?? null;
  const activeKey = active ? `${active.lang}|${active.src ?? ''}` : null;
  useEffect(() => {
    if (!active || active.cues || !active.src || !activeKey || loaded[activeKey]) return;
    const controller = new AbortController();
    fetch(toAppUrl(active.src), { signal: controller.signal })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((text) => setLoaded((prev) => ({ ...prev, [activeKey]: parseSubtitles(text) })))
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          console.warn('[VideoPlayer] could not load subtitles', err);
          setLoaded((prev) => ({ ...prev, [activeKey]: [] }));
        }
      });
    return () => controller.abort();
  }, [active, activeKey, loaded]);

  const cues = active ? (active.cues ?? (activeKey ? loaded[activeKey] : undefined)) : undefined;
  const cue = cueAt(cues, currentMs);

  const showChrome = useCallback(() => {
    setChrome(true);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      const el = video.current;
      if (el && !el.paused && !frame.current?.matches(':focus-within')) setChrome(false);
    }, 2600);
  }, []);
  useEffect(
    () => () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frame.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // A new source resets the transport.
  useEffect(() => {
    setFailed(false);
    setCurrentMs(0);
    setDurationMs(0);
    setBufferedMs(0);
    setPlaying(false);
  }, [src]);

  const toggle = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, []);

  const seek = useCallback((ms: number) => {
    const el = video.current;
    if (!el) return;
    const max = Number.isFinite(el.duration) ? el.duration * 1000 : 0;
    const next = Math.min(Math.max(0, ms), max);
    el.currentTime = next / 1000;
    setCurrentMs(next);
  }, []);

  const changeVolume = useCallback((next: number) => {
    const el = video.current;
    const value = Math.min(1, Math.max(0, next));
    if (el) {
      el.volume = value;
      el.muted = value === 0;
    }
    setVolume(value);
    setMuted(value === 0);
  }, []);

  const toggleMute = useCallback(() => {
    const el = video.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  }, []);

  const changeRate = useCallback((next: number) => {
    if (video.current) video.current.playbackRate = next;
    setRate(next);
  }, []);

  const toggleCaptions = useCallback(() => {
    setLang((prev) => {
      if (prev !== null) {
        lastLang.current = prev;
        return null;
      }
      return lastLang.current ?? tracks[0]?.lang ?? null;
    });
  }, [tracks]);

  const toggleFullscreen = useCallback(() => {
    const el = frame.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen?.().catch(() => undefined);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Shortcuts belong to the player surface; controls keep their own keys.
    if (event.target !== frame.current && event.target !== video.current) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    let handled = true;
    switch (event.key) {
      case ' ':
      case 'k':
      case 'K':
        toggle();
        break;
      case 'ArrowLeft':
        seek(currentMs - 5000);
        break;
      case 'ArrowRight':
        seek(currentMs + 5000);
        break;
      case 'ArrowUp':
        changeVolume(volume + 0.1);
        break;
      case 'ArrowDown':
        changeVolume(volume - 0.1);
        break;
      case 'Home':
        seek(0);
        break;
      case 'End':
        seek(durationMs);
        break;
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 'c':
      case 'C':
        if (tracks.length > 0) toggleCaptions();
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      showChrome();
    }
  };

  const visible = chrome || !playing || scrubbing;
  const captionsOn = lang !== null;
  const playLabel = playing ? t('player.pause') : t('player.play');
  const resolvedDownload = toAppUrl(downloadUrl);

  return (
    <div
      ref={frame}
      role="group"
      aria-label={t('player.label', { title })}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerMove={showChrome}
      onPointerLeave={() => playing && setChrome(false)}
      onFocus={showChrome}
      className={cn(
        'group/player relative w-full overflow-hidden rounded-lg bg-media text-on-media select-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2',
        !fullscreen && ASPECT[aspect],
        !visible && 'cursor-none',
        className,
      )}
    >
      <video
        ref={video}
        src={toAppUrl(src)}
        poster={toAppUrl(poster)}
        autoPlay={autoPlay}
        loop={loop}
        playsInline
        preload="metadata"
        tabIndex={-1}
        className="absolute inset-0 size-full object-contain"
        onClick={toggle}
        onPlay={() => {
          setPlaying(true);
          showChrome();
        }}
        onPause={() => {
          setPlaying(false);
          setChrome(true);
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onError={() => setFailed(true)}
        onEnded={onEnded}
        onLoadedMetadata={(event) => {
          const el = event.currentTarget;
          setDurationMs(Number.isFinite(el.duration) ? el.duration * 1000 : 0);
          setVolume(el.volume);
          setMuted(el.muted);
        }}
        onDurationChange={(event) => {
          const el = event.currentTarget;
          setDurationMs(Number.isFinite(el.duration) ? el.duration * 1000 : 0);
        }}
        onTimeUpdate={(event) => {
          const ms = event.currentTarget.currentTime * 1000;
          if (!scrubbing) setCurrentMs(ms);
          onTimeUpdate?.(ms);
        }}
        onProgress={(event) => {
          const el = event.currentTarget;
          if (el.buffered.length > 0) setBufferedMs(el.buffered.end(el.buffered.length - 1) * 1000);
        }}
      />

      {failed && (
        <div
          role="alert"
          className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm"
        >
          {t('player.error')}
        </div>
      )}

      {waiting && !failed && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner size="lg" label={t('player.buffering')} />
        </div>
      )}

      {!playing && !failed && !waiting && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={toggle}
          className="absolute inset-0 flex items-center justify-center"
        >
          <span className="flex size-16 items-center justify-center rounded-full bg-accent text-accent-fg shadow-lg transition-transform duration-150 ease-out-expo hover:scale-105">
            <Play className="ml-1 size-7 fill-current" />
          </span>
        </button>
      )}

      {cue && (
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 flex justify-center px-4 transition-[bottom] duration-150',
            visible ? 'bottom-[4.25rem]' : 'bottom-4',
          )}
        >
          <p
            lang={active?.lang}
            className="max-w-[90%] rounded-sm bg-media/85 px-2.5 py-1 text-center text-sm leading-snug font-medium text-on-media sm:text-base"
          >
            {cue.text}
          </p>
        </div>
      )}

      <div
        className={cn(
          'absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-media/90 via-media/60 to-transparent px-2 pt-8 pb-1.5 transition-opacity duration-200 sm:px-3',
          visible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <RadixSlider.Root
          value={[Math.min(currentMs, durationMs || currentMs)]}
          min={0}
          max={Math.max(durationMs, 1)}
          step={100}
          disabled={durationMs === 0}
          onValueChange={(next) => {
            setScrubbing(true);
            setCurrentMs(next[0] ?? 0);
          }}
          onValueCommit={(next) => {
            seek(next[0] ?? 0);
            setScrubbing(false);
          }}
          className="relative mx-1.5 flex h-4 touch-none items-center select-none"
        >
          <RadixSlider.Track className="relative h-1 grow overflow-hidden rounded-full bg-on-media/25">
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 bg-on-media/30"
              style={{
                width: `${durationMs > 0 ? Math.min(100, (bufferedMs / durationMs) * 100) : 0}%`,
              }}
            />
            <RadixSlider.Range className="absolute h-full bg-accent" />
          </RadixSlider.Track>
          <RadixSlider.Thumb
            aria-label={t('player.seek')}
            aria-valuetext={t('player.position', {
              current: formatClock(currentMs),
              total: formatClock(durationMs),
            })}
            className="block size-3.5 rounded-full bg-on-media shadow-md transition-transform duration-100 hover:scale-125 focus-visible:outline-on-media"
          />
        </RadixSlider.Root>

        <div className="flex items-center gap-0.5">
          <ControlButton label={playLabel} onClick={toggle}>
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </ControlButton>

          <div className="group/volume flex items-center">
            <ControlButton
              label={muted ? t('player.unmute') : t('player.mute')}
              onClick={toggleMute}
            >
              {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
            </ControlButton>
            <RadixSlider.Root
              value={[muted ? 0 : volume]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(next) => changeVolume(next[0] ?? 0)}
              className="relative hidden h-9 w-0 touch-none items-center overflow-hidden opacity-0 transition-[width,opacity] duration-150 select-none group-focus-within/volume:w-16 group-focus-within/volume:opacity-100 group-hover/volume:w-16 group-hover/volume:opacity-100 sm:flex"
            >
              <RadixSlider.Track className="relative mx-1.5 h-1 grow rounded-full bg-on-media/25">
                <RadixSlider.Range className="absolute h-full rounded-full bg-on-media" />
              </RadixSlider.Track>
              <RadixSlider.Thumb
                aria-label={t('player.volume')}
                aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)} %`}
                className="block size-3 rounded-full bg-on-media focus-visible:outline-on-media"
              />
            </RadixSlider.Root>
          </div>

          <span
            className="nums ml-1.5 text-xs whitespace-nowrap text-on-media/90"
            aria-hidden="true"
          >
            {formatClock(currentMs)}{' '}
            <span className="text-on-media/55">/ {formatClock(durationMs)}</span>
          </span>

          <span className="flex-1" />

          {tracks.length === 1 && (
            <ControlButton
              label={captionsOn ? t('player.captionsOff') : t('player.captionsOn')}
              aria-pressed={captionsOn}
              onClick={toggleCaptions}
            >
              {captionsOn ? <Captions /> : <CaptionsOff />}
            </ControlButton>
          )}
          {tracks.length > 1 && (
            <Menu>
              <MenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('player.captions')}
                  className="flex size-9 shrink-0 items-center justify-center rounded-md text-on-media/90 hover:bg-on-media/15 hover:text-on-media focus-visible:outline-on-media [&_svg]:size-[1.125rem]"
                >
                  {captionsOn ? <Captions /> : <CaptionsOff />}
                </button>
              </MenuTrigger>
              <MenuContent align="end" side="top">
                <MenuLabel>{t('player.captions')}</MenuLabel>
                <MenuRadioGroup
                  value={lang ?? OFF}
                  onValueChange={(next) => {
                    if (next !== OFF) lastLang.current = next;
                    setLang(next === OFF ? null : next);
                  }}
                >
                  <MenuRadioItem value={OFF}>{t('player.captionsNone')}</MenuRadioItem>
                  {tracks.map((track) => (
                    <MenuRadioItem key={track.lang} value={track.lang}>
                      {track.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>
          )}

          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={t('player.speed', { rate })}
                className="flex h-9 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs font-semibold text-on-media/90 hover:bg-on-media/15 hover:text-on-media focus-visible:outline-on-media [&_svg]:size-[1.125rem]"
              >
                <Gauge aria-hidden="true" />
                <span className="nums hidden sm:inline">{rate}×</span>
              </button>
            </MenuTrigger>
            <MenuContent align="end" side="top" className="min-w-28">
              <MenuLabel>{t('player.speedLabel')}</MenuLabel>
              <MenuRadioGroup
                value={String(rate)}
                onValueChange={(next) => changeRate(Number(next))}
              >
                {RATES.map((value) => (
                  <MenuRadioItem key={value} value={String(value)}>
                    {value}×
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>

          {resolvedDownload && (
            <Tooltip content={t('player.download')}>
              <a
                href={resolvedDownload}
                download={downloadName ?? true}
                aria-label={t('player.download')}
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-on-media/90 hover:bg-on-media/15 hover:text-on-media focus-visible:outline-on-media [&_svg]:size-[1.125rem]"
              >
                <Download aria-hidden="true" />
              </a>
            </Tooltip>
          )}

          <ControlButton
            label={fullscreen ? t('player.exitFullscreen') : t('player.fullscreen')}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize /> : <Maximize />}
          </ControlButton>
        </div>
      </div>
    </div>
  );
}
