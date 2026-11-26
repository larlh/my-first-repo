import type { SceneRuntime } from '@parlante/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton, VoiceBars, cn } from '@/ui';
import { AvatarCanvas } from '@/features/script-writer/kit';
import type { StageAvatar } from '@/features/script-writer/kit';
import { captionAt, talkPose } from '../lib/talk';
import type { Caption, TalkPhase } from '../lib/talk';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Karaoke line of the reply being spoken; redraws only when the line or word changes. */
function LiveCaption({
  runtime,
  clock,
}: {
  runtime: SceneRuntime | null;
  clock: () => number | null;
}) {
  const [caption, setCaption] = useState<Caption | null>(null);
  const key = useRef('');
  useEffect(() => {
    if (!runtime || typeof requestAnimationFrame !== 'function') {
      key.current = '';
      setCaption(null);
      return;
    }
    let frame = requestAnimationFrame(function loop() {
      const next = captionAt(runtime.words, clock());
      const nextKey = next ? `${next.words.join(' ')}|${next.active}` : '';
      if (nextKey !== key.current) {
        key.current = nextKey;
        setCaption(next);
      }
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [runtime, clock]);

  return (
    // The full reply is in the transcript; this moving line is decorative for assistive tech.
    <p
      aria-hidden="true"
      className="min-h-[3.5rem] px-4 pb-4 text-center text-base leading-snug font-medium text-pretty sm:text-lg"
    >
      {caption?.words.map((word, index) => (
        <span
          key={`${index}-${word}`}
          className={cn(
            'transition-colors duration-100',
            index === caption.active
              ? 'text-saffron'
              : index < caption.active || caption.active === -1
                ? 'text-on-media'
                : 'text-on-media/55',
          )}
        >
          {word}{' '}
        </span>
      ))}
    </p>
  );
}

export interface StageProps {
  /** null while the avatar is being loaded. */
  avatar: StageAvatar | null;
  /** Name spoken by assistive tech for the picture. */
  label: string;
  phase: TalkPhase;
  /** Timeline of the reply being spoken. */
  runtime: SceneRuntime | null;
  /** Position of the audio (ms) or null; read on every frame. */
  clock: () => number | null;
  /** Controls drawn over the bottom-right corner (mute, stop). */
  controls?: ReactNode;
  className?: string;
}

/**
 * The booth: the avatar on a canvas, drawn with its rig from @parlante/renderer and posed on
 * every frame from the audio clock, plus the "on air" lamp and the live caption.
 */
export function Stage({ avatar, label, phase, runtime, clock, controls, className }: StageProps) {
  const { t } = useTranslation('interactive');
  const live = useRef({ phase, runtime, clock, seed: avatar?.id ?? 'avatar' });
  live.current = { phase, runtime, clock, seed: avatar?.id ?? 'avatar' };
  const pose = useCallback((nowMs: number) => {
    const current = live.current;
    return talkPose({
      phase: current.phase,
      runtime: current.runtime,
      speechMs: current.clock(),
      nowMs,
      seed: current.seed,
    });
  }, []);
  // With "reduce motion" the avatar is still unless it is speaking audio the person asked for.
  const animate = phase === 'speaking' || !prefersReducedMotion();

  return (
    <div
      data-talk-phase={phase}
      className={cn(
        'relative isolate flex min-w-0 flex-col overflow-hidden rounded-2xl bg-media text-on-media shadow-lg',
        className,
      )}
    >
      <div aria-hidden="true" className="booth-grid absolute inset-0 -z-10 opacity-60" />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 -z-10 h-2/3 bg-[radial-gradient(ellipse_at_50%_0%,color-mix(in_srgb,var(--saffron)_22%,transparent),transparent_70%)]"
      />

      <div className="flex items-center justify-between gap-3 px-4 pt-4">
        <p
          role="status"
          className={cn(
            'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold tracking-wide uppercase',
            phase === 'speaking'
              ? 'bg-accent text-accent-fg'
              : phase === 'thinking'
                ? 'bg-saffron text-saffron-fg'
                : 'bg-on-media/12 text-on-media',
          )}
        >
          {phase === 'speaking' ? (
            // Ink bars: the lamp itself is the accent colour.
            <VoiceBars size="sm" label={null} className="text-accent-fg" />
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                'size-2 rounded-full bg-current',
                phase === 'thinking' && 'animate-pulse',
              )}
            />
          )}
          {t(`stage.phase.${phase}`)}
        </p>
        {controls && <div className="flex items-center gap-1">{controls}</div>}
      </div>

      <div className="relative mx-auto aspect-[4/3] w-full max-w-2xl flex-1">
        {avatar ? (
          <AvatarCanvas
            avatar={avatar}
            label={label}
            pose={pose}
            animate={animate}
            framing="bust"
            className="absolute inset-0"
          />
        ) : (
          <Skeleton className="absolute inset-6 rounded-xl opacity-30" />
        )}
      </div>

      <LiveCaption runtime={phase === 'speaking' ? runtime : null} clock={clock} />
    </div>
  );
}
