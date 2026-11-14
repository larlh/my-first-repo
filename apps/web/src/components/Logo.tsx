import { cn } from '@/lib/cn';

const SIZES = {
  sm: { mark: 'size-6', word: 'text-lg' },
  md: { mark: 'size-8', word: 'text-2xl' },
  lg: { mark: 'size-11', word: 'text-4xl' },
  xl: { mark: 'size-16', word: 'text-6xl' },
} as const;

export interface LogoMarkProps {
  className?: string;
  /** Accessible name; omit when the wordmark (or other text) sits next to it. */
  title?: string;
}

/**
 * The Parlante mark: a speech bubble whose tail becomes the stem of a "P", with a play
 * triangle cut out of it — speaking + video in one glyph. Always vermilion.
 */
export function LogoMark({ className, title }: LogoMarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn('shrink-0 text-accent', className)}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M5 12.5A9.5 9.5 0 0 1 14.5 3h4a9.5 9.5 0 0 1 0 19H12.6v4.2a3.8 3.8 0 0 1-7.6 0Zm8.3-4.3v8.6l7.6-4.3Z"
      />
    </svg>
  );
}

export interface LogoProps {
  size?: keyof typeof SIZES;
  /** Only the mark (collapsed navigation, favicons). */
  markOnly?: boolean;
  className?: string;
}

/** Mark + wordmark. The wordmark takes the current text colour (ink on paper, paper on ink). */
export function Logo({ size = 'md', markOnly = false, className }: LogoProps) {
  const dims = SIZES[size];
  if (markOnly) return <LogoMark className={cn(dims.mark, className)} title="Parlante" />;
  return (
    <span className={cn('inline-flex items-center gap-[0.4em] select-none', className)}>
      <LogoMark className={dims.mark} />
      <span
        className={cn('font-display leading-none font-extrabold tracking-[-0.045em]', dims.word)}
        style={{ fontStretch: '78%' }}
      >
        Parlante
      </span>
    </span>
  );
}
