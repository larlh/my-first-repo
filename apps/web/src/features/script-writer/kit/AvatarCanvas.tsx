import type { AvatarFraming } from '@parlante/shared';
import { restingAvatarState } from '@parlante/renderer';
import type { AvatarState } from '@parlante/renderer';
import { UserRound } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Ref } from 'react';
import { toAppUrl } from '@/lib/api';
import { cn } from '@/ui';
import { backingSize, stageBox, useAvatarRig } from './avatar';
import type { StageAvatar } from './avatar';

export interface AvatarCanvasProps {
  avatar: StageAvatar;
  /**
   * Pose to draw at a page time (ms). With `animate` it is called on every animation frame;
   * without it once (a still). Defaults to the neutral resting pose.
   */
  pose?: (nowMs: number) => AvatarState;
  /** Redraw on every animation frame. */
  animate?: boolean;
  framing?: AvatarFraming;
  /** Accessible name of the picture. */
  label: string;
  /** Longest side of the backing store in device pixels. */
  maxSide?: number;
  className?: string;
  canvasRef?: Ref<HTMLCanvasElement>;
}

/**
 * An avatar on a canvas, drawn with its rig from @parlante/renderer. The caller decides the
 * pose of each frame (`computeAvatarState` for speech, `restingAvatarState` for a still), so
 * this component holds no animation logic of its own.
 */
export function AvatarCanvas({
  avatar,
  pose,
  animate = false,
  framing = 'bust',
  label,
  maxSide,
  className,
  canvasRef,
}: AvatarCanvasProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const { rig, status } = useAvatarRig(avatar);

  // Latest props for the loop (it must not restart on every render).
  const live = useRef({ pose, framing, rig });
  live.current = { pose, framing, rig };

  const draw = useRef<(nowMs: number) => void>(() => undefined);
  draw.current = (nowMs: number) => {
    const element = canvas.current;
    const current = live.current;
    if (!element || !current.rig) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;
    const state = current.pose ? current.pose(nowMs) : restingAvatarState(0);
    ctx.clearRect(0, 0, element.width, element.height);
    current.rig.draw(ctx, stageBox(element.width, element.height, current.framing), state, {
      framing: current.framing,
      flip: false,
      quality: 'preview',
    });
  };

  // Keep the backing store in step with the CSS box.
  useEffect(() => {
    const box = wrapper.current;
    const element = canvas.current;
    if (!box || !element) return;
    const fit = () => {
      const rect = box.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const size = backingSize(rect.width, rect.height, window.devicePixelRatio, maxSide);
      if (element.width !== size.width || element.height !== size.height) {
        element.width = size.width;
        element.height = size.height;
      }
      draw.current(performance.now());
    };
    fit();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [maxSide]);

  useEffect(() => {
    if (!rig) return;
    draw.current(performance.now());
    if (!animate || typeof requestAnimationFrame !== 'function') return;
    let frame = requestAnimationFrame(function loop(nowMs) {
      draw.current(nowMs);
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [rig, animate, framing]);

  return (
    <div ref={wrapper} className={cn('relative overflow-hidden', className)}>
      <canvas
        ref={(element) => {
          canvas.current = element;
          if (typeof canvasRef === 'function') canvasRef(element);
          else if (canvasRef) canvasRef.current = element;
        }}
        role="img"
        aria-label={label}
        data-rig-status={status}
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
