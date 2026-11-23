import { computeTimeline, createPhotoAvatarRig, renderFrame } from '@parlante/renderer';
import type { Timeline } from '@parlante/renderer';
import {
  BrowserRenderAssets,
  ensureBrowserFonts,
  ensureCompositionFonts,
  loadBrowserImage,
} from '@parlante/renderer/browser';
import type { Composition, RenderRuntime } from '@parlante/shared';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, apiClient, toAppUrl, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { IconButton, Slider, cn } from '@/ui';
import { clampPlayhead, estimatedRuntime, previewDependencies } from './preview';
import { backingSize } from './stage';
import { subscribeTicker } from './ticker';

type MediaUrl = { url: string; kind: 'image' | 'video' };

/**
 * Everything a composition needs to be drawn in the browser: fonts, stock and uploaded
 * media, and stand-in rigs for photorealistic avatars. `version` changes whenever something
 * new can be drawn (redraw then).
 */
function usePreviewAssets(
  composition: Composition,
  extraMedia: Readonly<Record<string, MediaUrl>> | undefined,
): { assets: BrowserRenderAssets; version: number } {
  const assets = useMemo(() => new BrowserRenderAssets(), []);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((value) => value + 1), []);
  const stock = useApiQuery(api.assets.listStock, undefined, { staleTime: 10 * 60_000 });
  const dependencies = useMemo(() => previewDependencies(composition), [composition]);
  const assetKey = dependencies.assetIds.join(',');
  const avatarKey = dependencies.avatarIds.join(',');

  // Fonts: a canvas does not wait for a face, so load them and draw again.
  useEffect(() => {
    let alive = true;
    void ensureBrowserFonts()
      .then(() => ensureCompositionFonts(composition))
      .then(() => alive && bump())
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [composition, bump]);

  // Media: stock comes from the catalogue; uploaded assets are looked up one by one.
  const [uploaded, setUploaded] = useState<Record<string, MediaUrl>>({});
  useEffect(() => {
    if (assetKey === '') return;
    let alive = true;
    void Promise.allSettled(
      assetKey.split(',').map((assetId) => apiClient.assets.get({ params: { assetId } })),
    ).then((results) => {
      if (!alive) return;
      const found: Record<string, MediaUrl> = {};
      for (const result of results) {
        if (result.status !== 'fulfilled' || result.value.kind === 'audio') continue;
        found[`asset:${result.value.id}`] = { url: result.value.url, kind: result.value.kind };
      }
      setUploaded(found);
    });
    return () => {
      alive = false;
    };
  }, [assetKey]);

  useEffect(() => {
    let alive = true;
    const stockItems = stock.data?.items ?? [];
    void assets
      .loadComposition(composition, (key) => {
        const extra = extraMedia?.[key] ?? uploaded[key];
        if (extra) return { url: toAppUrl(extra.url), kind: extra.kind };
        if (!key.startsWith('stock:')) return null;
        const item = stockItems.find((entry) => `stock:${entry.id}` === key);
        if (!item || item.kind === 'audio') return null;
        return { url: toAppUrl(item.url), kind: item.kind };
      })
      .then(() => alive && bump());
    return () => {
      alive = false;
    };
  }, [assets, composition, stock.data, uploaded, extraMedia, bump]);

  // Photorealistic avatars: the Canvas stand-in over the cut-out (labelled as a preview).
  useEffect(() => {
    if (avatarKey === '') return;
    let alive = true;
    for (const avatarId of avatarKey.split(',')) {
      void apiClient.avatars
        .get({ params: { avatarId } })
        .then(async (avatar) => {
          if (!avatar.cutoutUrl || !avatar.rig) return;
          const image = await loadBrowserImage(toAppUrl(avatar.cutoutUrl));
          if (!alive) return;
          assets.setAvatar(avatarId, createPhotoAvatarRig(avatarId, image, avatar.rig));
          bump();
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [assets, avatarKey, bump]);

  return { assets, version };
}

export interface CompositionPlayerProps {
  composition: Composition;
  /** Accessible name of the picture. */
  label: string;
  /** Show play / scrub controls (default) or only a still frame. */
  controls?: boolean;
  /** Frame shown while stopped (ms). Default: 40 % into the first scene. */
  posterMs?: number;
  /** Media the caller already has a URL for, by media key (`asset:<id>`). */
  extraMedia?: Readonly<Record<string, MediaUrl>>;
  /** CSS height of the picture for vertical formats (wide ones fill the width). */
  portraitHeight?: string;
  /** Called with the scene index under the playhead. */
  onScene?: (index: number) => void;
  /** Jump request: `{ sceneIndex, nonce }` (a new nonce re-triggers the same scene). */
  seekTo?: { sceneIndex: number; nonce: number } | null;
  className?: string;
}

/**
 * Silent player of a Composition drawn with `renderFrame` — the code of the Studio preview
 * and of the export. Narration is not synthesized here: scene lengths and mouths come from
 * the shared estimator, so this is a faithful picture with approximate timing.
 */
export function CompositionPlayer({
  composition,
  label,
  controls = true,
  posterMs,
  extraMedia,
  portraitHeight = 'min(58dvh, 32rem)',
  onScene,
  seekTo,
  className,
}: CompositionPlayerProps) {
  const { t } = useTranslation('avatars');
  const format = useFormat();
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { assets, version } = usePreviewAssets(composition, extraMedia);

  const runtime: RenderRuntime = useMemo(() => estimatedRuntime(composition), [composition]);
  const timeline: Timeline = useMemo(
    () => computeTimeline(composition, runtime),
    [composition, runtime],
  );
  const firstScene = timeline.scenes[0];
  const poster = clampPlayhead(
    posterMs ?? (firstScene ? firstScene.durationMs * 0.4 : 0),
    timeline.totalMs,
  );

  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(poster);
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  const draw = useCallback(
    (tMs: number, isPlaying: boolean) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      assets.syncVideos(composition, timeline, tMs, { playing: isPlaying, volume: 0 });
      renderFrame(ctx, composition, tMs, runtime, assets, {
        width: canvas.width,
        height: canvas.height,
        timeline,
        quality: 'preview',
      });
    },
    [assets, composition, runtime, timeline],
  );

  // A new document starts from its poster frame.
  useEffect(() => {
    setPlaying(false);
    setPlayhead(poster);
  }, [composition, poster]);

  // Keep the backing store in step with the CSS box, then redraw.
  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    const fit = () => {
      const rect = frame.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const size = backingSize(rect.width, rect.height, window.devicePixelRatio, 1280);
      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
      }
      draw(playheadRef.current, false);
    };
    fit();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [draw]);

  // Stopped: draw whenever the frame, the document or the loaded media change.
  useEffect(() => {
    if (!playing) draw(playhead, false);
  }, [playing, playhead, draw, version]);

  // Playing: follow the clock.
  useEffect(() => {
    if (!playing) return;
    const origin = performance.now() - playheadRef.current;
    return subscribeTicker((nowMs) => {
      const tMs = nowMs - origin;
      if (tMs >= timeline.totalMs) {
        setPlaying(false);
        setPlayhead(clampPlayhead(timeline.totalMs, timeline.totalMs));
        return;
      }
      playheadRef.current = tMs;
      draw(tMs, true);
      setPlayhead(tMs);
    }, 30);
  }, [playing, draw, timeline.totalMs]);

  // Report the scene under the playhead.
  const sceneIndex = useMemo(() => {
    let index = 0;
    timeline.scenes.forEach((scene, i) => {
      if (playhead >= scene.startMs) index = i;
    });
    return index;
  }, [timeline, playhead]);
  const onSceneRef = useRef(onScene);
  onSceneRef.current = onScene;
  useEffect(() => {
    onSceneRef.current?.(sceneIndex);
  }, [sceneIndex]);

  // Jump to a scene on request.
  const seekNonce = seekTo?.nonce;
  useEffect(() => {
    if (!seekTo) return;
    const scene = timeline.scenes[seekTo.sceneIndex];
    if (!scene) return;
    setPlaying(false);
    setPlayhead(clampPlayhead(scene.startMs + scene.durationMs * 0.4, timeline.totalMs));
    // Only a new request moves the playhead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekNonce]);

  const atEnd = playhead >= timeline.totalMs - 40;
  const toggle = () => {
    if (playing) return setPlaying(false);
    if (atEnd) setPlayhead(0);
    playheadRef.current = atEnd ? 0 : playheadRef.current;
    setPlaying(true);
  };

  const { width, height } = composition.canvas;
  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex min-w-0 justify-center rounded-xl bg-media p-2">
        <div
          ref={frameRef}
          className="relative max-w-full overflow-hidden rounded-md"
          style={
            height > width
              ? { aspectRatio: `${width} / ${height}`, height: portraitHeight }
              : { aspectRatio: `${width} / ${height}`, width: '100%' }
          }
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={label}
            data-playhead={Math.round(playhead)}
            className="absolute inset-0 h-full w-full"
          />
        </div>
      </div>
      {controls && (
        <div className="flex min-w-0 items-center gap-3">
          <IconButton
            variant="solid"
            label={
              playing
                ? t('kit.player.pause')
                : atEnd
                  ? t('kit.player.replay')
                  : t('kit.player.play')
            }
            onClick={toggle}
          >
            {playing ? (
              <Pause aria-hidden="true" />
            ) : atEnd ? (
              <RotateCcw aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
          </IconButton>
          <Slider
            aria-label={t('kit.player.position')}
            className="min-w-0 flex-1"
            value={Math.round(playhead)}
            min={0}
            max={Math.max(1, Math.round(timeline.totalMs - 1))}
            step={33}
            onValueChange={(value) => {
              setPlaying(false);
              setPlayhead(clampPlayhead(value, timeline.totalMs));
            }}
          />
          <span className="nums shrink-0 font-mono text-xs text-fg-muted">
            {format.clock(playhead)} / {format.clock(timeline.totalMs)}
          </span>
        </div>
      )}
    </div>
  );
}
