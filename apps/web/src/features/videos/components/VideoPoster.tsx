import type { AspectRatio } from '@parlante/shared';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { LogoMark } from '@/components/Logo';
import { toAppUrl } from '@/lib/api';
import { formatClock } from '@/lib/format';
import { cn } from '@/ui';
import { ASPECT_CLASS } from '../lib/video';

export interface VideoPosterProps {
  thumbnailUrl: string | null;
  /** Shape of the video; the frame keeps `frame` and letterboxes the picture inside it. */
  aspect: AspectRatio;
  /** Shape of the frame. Defaults to 16:9 so cards line up in a grid. */
  frame?: AspectRatio;
  durationMs?: number | null;
  /** Text alternative of the picture; empty when the title is printed next to it. */
  alt?: string;
  /** Extra layers (progress, badges). */
  children?: ReactNode;
  className?: string;
}

/**
 * Poster of a video on the dark "media" surface. Without a thumbnail (never rendered, or the
 * image failed) it shows a blank slate in the shape of the video instead of a broken image.
 */
export function VideoPoster({
  thumbnailUrl,
  aspect,
  frame = '16:9',
  durationMs,
  alt = '',
  children,
  className,
}: VideoPosterProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const src = toAppUrl(thumbnailUrl);
  const showImage = src !== undefined && failedUrl !== src;
  return (
    <div
      className={cn(
        'relative flex items-center justify-center overflow-hidden bg-media text-on-media',
        ASPECT_CLASS[frame],
        className,
      )}
    >
      {showImage ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(src)}
          className="absolute inset-0 size-full object-contain"
        />
      ) : (
        <>
          <div className="booth-grid absolute inset-0 opacity-50" aria-hidden="true" />
          <div
            aria-hidden="true"
            className={cn(
              'relative flex h-[72%] items-center justify-center rounded-md border border-on-media/15 bg-on-media/5',
              ASPECT_CLASS[aspect],
            )}
          >
            <LogoMark className="size-8 opacity-90" />
          </div>
        </>
      )}
      {durationMs !== null && durationMs !== undefined && durationMs > 0 && (
        <span className="nums absolute right-2 bottom-2 rounded-xs bg-media/85 px-1.5 py-0.5 font-mono text-2xs font-medium text-on-media">
          {formatClock(durationMs)}
        </span>
      )}
      {children}
    </div>
  );
}
