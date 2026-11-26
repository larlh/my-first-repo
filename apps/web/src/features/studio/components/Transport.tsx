import { Pause, Play, SkipBack, StepForward } from 'lucide-react';
import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/lib/format';
import { Button, IconButton, Spinner, cn } from '@/ui';
import {
  selectComposition,
  useEditor,
  usePlayhead,
  usePreviewState,
  useStudio,
} from '../state/context';

function Timecode({ totalMs }: { totalMs: number }) {
  const format = useFormat();
  const tMs = usePlayhead();
  return (
    <span className="nums shrink-0 font-mono text-xs text-fg-muted" data-testid="timecode">
      <span className="text-fg">{format.timecode(tMs)}</span>
      <span className="mx-1 text-fg-subtle">/</span>
      {format.timecode(totalMs)}
    </span>
  );
}

function Playhead({ totalMs }: { totalMs: number }) {
  const tMs = usePlayhead();
  const left = totalMs > 0 ? Math.min(100, (tMs / totalMs) * 100) : 0;
  return (
    <span
      aria-hidden="true"
      data-testid="playhead"
      className="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-accent"
      style={{ left: `${left}%` }}
    >
      <span className="absolute -top-1 left-1/2 size-2.5 -translate-x-1/2 rotate-45 rounded-[2px] bg-accent" />
    </span>
  );
}

/** Play controls, timecode and the timeline strip (one block per scene, drag to scrub). */
export function Transport() {
  const { t } = useTranslation('studio');
  const format = useFormat();
  const { engine, store, playScene, playAll, togglePlay, scrub } = useStudio();
  const { playing, preparing, timeline, playingSceneId } = usePreviewState();
  const scenes = useEditor((state) => selectComposition(state).scenes);
  const selectedId = useEditor((state) => state.selection.sceneId);
  const strip = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const total = timeline.totalMs;
  const busy = playing || preparing;

  const timeAt = (clientX: number): number => {
    const rect = strip.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total;
  };
  const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragging.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // No active pointer (synthetic event).
    }
    scrub(timeAt(event.clientX));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 1000 : 100;
    const now = engine.getTime();
    const next =
      event.key === 'ArrowRight'
        ? now + step
        : event.key === 'ArrowLeft'
          ? now - step
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? total
              : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    scrub(next);
  };

  return (
    <div className="shrink-0 border-t border-line bg-surface">
      <div className="flex h-12 items-center gap-2 px-3">
        <IconButton
          label={t('transport.toStart')}
          size="sm"
          onClick={() => {
            const first = scenes[0];
            engine.pause();
            if (first) {
              if (first.id === selectedId) engine.park(first.id);
              else store.getState().select({ sceneId: first.id });
            }
          }}
        >
          <SkipBack aria-hidden="true" />
        </IconButton>
        <Button
          size="sm"
          variant={busy ? 'solid' : 'secondary'}
          className="xl:min-w-32"
          leftIcon={
            preparing ? (
              <Spinner size="sm" label={null} />
            ) : playing ? (
              <Pause aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )
          }
          onClick={busy ? togglePlay : playScene}
        >
          {preparing
            ? t('transport.preparing')
            : playing
              ? t('transport.pause')
              : t('transport.playScene')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          aria-label={t('transport.playAll')}
          title={t('transport.playAll')}
          leftIcon={<StepForward aria-hidden="true" />}
          onClick={playAll}
        >
          <span className="hidden xl:inline">{t('transport.playAll')}</span>
        </Button>
        <div className="flex-1" />
        <Timecode totalMs={total} />
      </div>

      <div className="px-3 pb-3">
        <div
          ref={strip}
          role="slider"
          tabIndex={0}
          aria-label={t('transport.timeline')}
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(engine.getTime())}
          aria-valuetext={format.clock(engine.getTime())}
          data-testid="timeline"
          onPointerDown={onDown}
          onPointerMove={(event) => {
            if (dragging.current) scrub(timeAt(event.clientX));
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onKeyDown={onKey}
          className="relative flex h-10 cursor-ew-resize touch-none gap-px overflow-hidden rounded-md bg-surface-3 select-none"
        >
          {timeline.scenes.map((timing, index) => {
            const scene = scenes[index];
            if (!scene || total <= 0) return null;
            const active = (playingSceneId ?? selectedId) === scene.id;
            const speechLeft = ((timing.speechStartMs - timing.startMs) / timing.durationMs) * 100;
            const speechWidth = (timing.speechDurationMs / timing.durationMs) * 100;
            return (
              <div
                key={scene.id}
                data-scene-id={scene.id}
                className={cn(
                  'relative min-w-0 overflow-hidden transition-colors',
                  active ? 'bg-accent-soft' : 'bg-surface-2',
                )}
                style={{ width: `${(timing.durationMs / total) * 100}%` }}
              >
                {timing.transitionMs > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 bg-linear-to-r from-fg/25 to-transparent"
                    style={{ width: `${(timing.transitionMs / timing.durationMs) * 100}%` }}
                  />
                )}
                {timing.speechDurationMs > 0 && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute bottom-1 h-1.5 rounded-full',
                      active ? 'bg-accent' : 'bg-fg-subtle/60',
                    )}
                    style={{ left: `${speechLeft}%`, width: `${speechWidth}%` }}
                  />
                )}
                <span className="pointer-events-none absolute top-1 left-1.5 flex max-w-full items-center gap-1 pr-2 text-2xs font-semibold whitespace-nowrap text-fg-muted">
                  <span className="nums font-display text-fg">{index + 1}</span>
                  <span className="truncate">{scene.name}</span>
                </span>
              </div>
            );
          })}
          <Playhead totalMs={total} />
        </div>
      </div>
    </div>
  );
}
