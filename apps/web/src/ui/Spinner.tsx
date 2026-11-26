import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

const SIZES = { xs: 'size-3', sm: 'size-4', md: 'size-5', lg: 'size-8' } as const;

export interface SpinnerProps {
  size?: keyof typeof SIZES;
  className?: string;
  /** Accessible label; pass `null` when a visible label already describes the wait. */
  label?: string | null;
}

/** Ring spinner for inline waits (buttons, fields). Inherits the text colour. */
export function Spinner({ size = 'sm', className, label }: SpinnerProps) {
  const { t } = useTranslation('shell');
  const text = label === undefined ? t('ui.loading') : label;
  return (
    <span
      role={text === null ? undefined : 'status'}
      aria-label={text ?? undefined}
      aria-hidden={text === null ? true : undefined}
      className={cn('inline-block shrink-0', SIZES[size], className)}
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-full animate-spin">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="3" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

const BAR_DELAYS = ['0ms', '-420ms', '-180ms', '-620ms', '-300ms'];

export interface VoiceBarsProps {
  /** Height of the tallest bar. */
  size?: 'sm' | 'md' | 'lg';
  /** Animate (speaking) or rest as a static glyph. */
  active?: boolean;
  className?: string;
  label?: string | null;
}

/**
 * Brand loader: five voice-level bars. Used for page-level waits and wherever the product is
 * "speaking" (rendering, synthesising, the logo).
 */
export function VoiceBars({ size = 'md', active = true, className, label }: VoiceBarsProps) {
  const { t } = useTranslation('shell');
  const text = label === undefined ? t('ui.loading') : label;
  const dims = size === 'sm' ? 'h-4 gap-[2px]' : size === 'lg' ? 'h-12 gap-1.5' : 'h-7 gap-[3px]';
  const bar = size === 'sm' ? 'w-[3px]' : size === 'lg' ? 'w-2' : 'w-1';
  const rest = ['scale-y-[0.4]', 'scale-y-[0.8]', 'scale-y-100', 'scale-y-[0.6]', 'scale-y-[0.3]'];
  return (
    <span
      role={text === null ? undefined : 'status'}
      aria-label={text ?? undefined}
      aria-hidden={text === null ? true : undefined}
      className={cn('inline-flex items-center text-accent', dims, className)}
    >
      {BAR_DELAYS.map((delay, i) => (
        <span
          key={delay}
          style={active ? { animationDelay: delay } : undefined}
          className={cn(
            'h-full origin-center rounded-full bg-current',
            bar,
            active ? 'animate-voice' : rest[i],
          )}
        />
      ))}
    </span>
  );
}
