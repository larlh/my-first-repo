import type { AvatarFraming, PhotoAvatarRig, SceneRuntime } from '@parlante/shared';
import { createPhotoAvatarRig, getStockAvatarRig } from '@parlante/renderer';
import type { AvatarRig } from '@parlante/renderer';
import { loadBrowserImage } from '@parlante/renderer/browser';
import { UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toAppUrl } from '@/lib/api';
import { cn } from '@/ui';
import { DEMO_LINES, backingSize, demoRuntime, stageBox, stagePose } from './stage';
import type { StageMode } from './stage';
import { subscribeTicker } from './ticker';

/** The fields of an `Avatar` DTO the stage needs (a stock catalogue entry also fits). */
export interface StageAvatar {
  id: string;
  rendering: 'instant' | 'photoreal';
  /** Photoreal: portrait with its matte applied; the stand-in rig is built from it. */
  cutoutUrl?: string | null;
  rig?: PhotoAvatarRig | null;
  thumbnailUrl?: string | null;
}

export type RigStatus = 'ready' | 'loading' | 'missing';

/* Stand-in rigs of photoreal avatars, by avatar id. Signed URLs change between responses, so
 * a loaded rig is kept for the id (and dropped when its geometry changes). */
const photoRigs = new Map<string, { key: string; rig: Promise<AvatarRig> }>();

function loadPhotoRig(avatar: StageAvatar, url: string, geometry: PhotoAvatarRig) {
  const key = JSON.stringify(geometry);
  const cached = photoRigs.get(avatar.id);
  if (cached && cached.key === key) return cached.rig;
  const rig = loadBrowserImage(toAppUrl(url)).then((image) =>
    createPhotoAvatarRig(avatar.id, image, geometry),
  );
  photoRigs.set(avatar.id, { key, rig });
  rig.catch(() => {
    if (photoRigs.get(avatar.id)?.rig === rig) photoRigs.delete(avatar.id);
  });
  return rig;
}

/**
 * The drawable rig of an avatar: the built-in parametric rig for instant (2D) avatars, the
 * Canvas stand-in over the cut-out for photorealistic ones (loaded on demand).
 */
export function useAvatarRig(avatar: StageAvatar): { rig: AvatarRig | null; status: RigStatus } {
  const instant = avatar.rendering === 'instant';
  const stock = instant ? getStockAvatarRig(avatar.id) : null;
  const cutoutUrl = avatar.cutoutUrl ?? null;
  const geometry = avatar.rig ?? null;
  const geometryKey = geometry ? JSON.stringify(geometry) : '';
  const [loaded, setLoaded] = useState<{ id: string; rig: AvatarRig | null } | null>(null);

  useEffect(() => {
    if (instant || !cutoutUrl || !geometry) return;
    let alive = true;
    loadPhotoRig(avatar, cutoutUrl, geometry).then(
      (rig) => alive && setLoaded({ id: avatar.id, rig }),
      () => alive && setLoaded({ id: avatar.id, rig: null }),
    );
    return () => {
      alive = false;
    };
    // The signed URL changes on every response; the avatar id + geometry identify the rig.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instant, avatar.id, geometryKey, cutoutUrl === null]);

  if (instant) return { rig: stock, status: stock ? 'ready' : 'missing' };
  if (!cutoutUrl || !geometry) return { rig: null, status: 'missing' };
  if (!loaded || loaded.id !== avatar.id) return { rig: null, status: 'loading' };
  return { rig: loaded.rig, status: loaded.rig ? 'ready' : 'missing' };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export interface AvatarStageProps {
  avatar: StageAvatar;
  /** `idle` (default), `demo` (mouths a sample line in a loop) or `speech` (follows audio). */
  mode?: StageMode;
  /** `speech`: runtime returned by the synthesis (visemes and words). */
  runtime?: SceneRuntime | null;
  /** `speech`: current position of the audio in ms (null / negative when not playing). */
  clock?: () => number | null;
  framing?: AvatarFraming;
  /** Language of the silent sample line of `demo`. */
  demoLocale?: 'es' | 'en';
  /** Accessible name of the picture ("Vista previa animada de Lucía"). */
  label: string;
  className?: string;
}

/**
 * Live avatar on a canvas, drawn with the rigs of @parlante/renderer — the code that draws
 * the avatar in the Studio preview and in the exported video. It animates only while it is on
 * screen; with "reduce motion" it shows a still pose unless it is following real audio the
 * person asked to hear.
 */
export function AvatarStage({
  avatar,
  mode = 'idle',
  runtime = null,
  clock,
  framing = 'bust',
  demoLocale = 'es',
  label,
  className,
}: AvatarStageProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { rig, status } = useAvatarRig(avatar);
  const [visible, setVisible] = useState(true);

  // Latest props for the animation loop (it must not resubscribe on every render).
  const live = useRef({ mode, runtime, clock, framing, demoLocale, rig, seed: avatar.id });
  live.current = { mode, runtime, clock, framing, demoLocale, rig, seed: avatar.id };
  const startedAt = useRef<{ mode: StageMode; atMs: number } | null>(null);

  const drawRef = useRef<(nowMs: number) => void>(() => undefined);
  drawRef.current = (nowMs: number) => {
    const canvas = canvasRef.current;
    const current = live.current;
    if (!canvas || !current.rig) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The sample line restarts from its first word whenever the mode changes.
    if (startedAt.current?.mode !== current.mode) {
      startedAt.current = { mode: current.mode, atMs: nowMs };
    }
    const sinceMode = nowMs - startedAt.current.atMs;
    const pose = stagePose({
      mode: current.mode,
      elapsedMs: current.mode === 'demo' ? sinceMode : nowMs,
      seed: current.seed,
      runtime:
        current.mode === 'demo'
          ? demoRuntime(DEMO_LINES[current.demoLocale], current.demoLocale)
          : current.runtime,
      speechMs: current.mode === 'speech' ? (current.clock?.() ?? -1) : null,
    });
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    current.rig.draw(ctx, stageBox(canvas.width, canvas.height, current.framing), pose, {
      framing: current.framing,
      flip: false,
      quality: 'preview',
    });
  };

  // Keep the backing store in step with the CSS box.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas) return;
    const fit = () => {
      const rect = wrapper.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const size = backingSize(rect.width, rect.height, window.devicePixelRatio);
      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
      }
      drawRef.current(performance.now());
    };
    fit();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(fit);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  // Animate only while on screen.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setVisible(entry.isIntersecting);
      },
      { rootMargin: '120px' },
    );
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  const still = prefersReducedMotion() && mode !== 'speech';
  useEffect(() => {
    if (!rig) return;
    drawRef.current(performance.now());
    if (!visible || still) return;
    return subscribeTicker((nowMs) => drawRef.current(nowMs), 30);
  }, [rig, visible, still, mode, framing]);

  return (
    <div ref={wrapperRef} className={cn('relative overflow-hidden', className)}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        data-stage-mode={mode}
        data-stage-status={status}
        className={cn('absolute inset-0 h-full w-full', !rig && 'hidden')}
      />
      {!rig &&
        (avatar.thumbnailUrl ? (
          <img
            src={toAppUrl(avatar.thumbnailUrl)}
            alt={label}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <span
            role="img"
            aria-label={label}
            className={cn(
              'absolute inset-0 flex items-center justify-center text-fg-subtle',
              status === 'loading' && 'shimmer',
            )}
          >
            <UserRound aria-hidden="true" className="size-1/3" strokeWidth={1.25} />
          </span>
        ))}
    </div>
  );
}
