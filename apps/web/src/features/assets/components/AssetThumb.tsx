import type { AssetKind } from '@parlante/shared';
import { Film, ImageIcon, ImageOff, Music, Play } from 'lucide-react';
import { useState } from 'react';
import { toAppUrl } from '@/lib/api';
import { formatClock } from '@/lib/format';
import { cn } from '@/ui';

export const KIND_ICON = { image: ImageIcon, video: Film, audio: Music } as const;

/** Deterministic bar heights (18..100 %) from an id, so an audio file always looks the same. */
export function waveformOf(seed: string, bars = 28): number[] {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const out: number[] = [];
  for (let i = 0; i < bars; i += 1) {
    hash ^= hash << 13;
    hash >>>= 0;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    hash >>>= 0;
    // Shape the noise with a soft envelope so it reads as speech, not static.
    const envelope = 0.55 + 0.45 * Math.sin((i / (bars - 1)) * Math.PI);
    out.push(Math.round(18 + (hash % 83) * envelope));
  }
  return out;
}

export interface AssetThumbProps {
  /** Asset or stock id: seeds the audio waveform. */
  id: string;
  kind: AssetKind;
  /** Poster to show: the thumbnail, or the file itself for images without one. */
  imageUrl: string | null;
  durationMs: number | null;
  className?: string;
}

/**
 * Picture of a media file inside a 16:9 frame: the thumbnail for images and video (with a play
 * mark and the duration), a waveform for audio. Purely visual: the caller labels it.
 */
export function AssetThumb({ id, kind, imageUrl, durationMs, className }: AssetThumbProps) {
  const [failed, setFailed] = useState(false);
  const showImage = kind !== 'audio' && imageUrl !== null && !failed;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative block aspect-video w-full overflow-hidden bg-media text-on-media',
        className,
      )}
    >
      {kind === 'audio' ? (
        <span className="absolute inset-0 flex items-center justify-center gap-[3px] bg-inverse px-5 text-inverse-fg">
          {waveformOf(id).map((height, index) => (
            <span
              key={index}
              className={cn(
                'w-1 shrink-0 rounded-full',
                index % 5 === 2 ? 'bg-accent' : 'bg-inverse-fg/55',
              )}
              style={{ height: `${Math.round(height * 0.56)}%` }}
            />
          ))}
        </span>
      ) : showImage ? (
        <img
          src={toAppUrl(imageUrl)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <span className="booth-grid absolute inset-0 flex items-center justify-center text-on-media/60">
          {failed ? (
            <ImageOff className="size-7" />
          ) : kind === 'video' ? (
            <Film className="size-7" />
          ) : (
            <ImageIcon className="size-7" />
          )}
        </span>
      )}
      {kind === 'video' && showImage && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-media/70 text-on-media backdrop-blur-sm">
            <Play className="ml-0.5 size-4 fill-current" />
          </span>
        </span>
      )}
      {durationMs !== null && kind !== 'image' && (
        <span className="nums absolute right-1.5 bottom-1.5 rounded-xs bg-media/80 px-1.5 py-0.5 font-mono text-2xs font-medium text-on-media">
          {formatClock(durationMs)}
        </span>
      )}
    </span>
  );
}
