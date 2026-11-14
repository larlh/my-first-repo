import { useState } from 'react';
import { cn } from '@/lib/cn';

const SIZES = {
  xs: 'size-6 text-2xs',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-14 text-lg',
  xl: 'size-20 text-2xl',
} as const;

/* Initials sit on one of the brand tints; the pick is stable per name. */
const TINTS = [
  'bg-accent-soft text-accent-text',
  'bg-saffron-soft text-saffron-text',
  'bg-success-soft text-success-text',
  'bg-info-soft text-info-text',
  'bg-danger-soft text-danger-text',
  'bg-surface-3 text-fg',
];

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : (words[0]?.[1] ?? '');
  return (first + last).toUpperCase() || '?';
}

function tintOf(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return TINTS[hash % TINTS.length] ?? TINTS[0] ?? '';
}

export interface AvatarProps {
  /** Person or workspace name: source of the initials and of the accessible name. */
  name: string;
  src?: string | null;
  size?: keyof typeof SIZES;
  /** `rounded` (squircle) reads as a workspace / thing, `circle` as a person. */
  shape?: 'circle' | 'rounded';
  /** Hide from assistive tech when the name is printed next to it. */
  decorative?: boolean;
  className?: string;
}

/**
 * Identity chip of a PERSON or WORKSPACE (image or initials). Not to be confused with the
 * product's AI avatars, which are drawn by the renderer. Also exported as `UserAvatar`.
 */
export function Avatar({
  name,
  src,
  size = 'md',
  shape = 'circle',
  decorative = false,
  className,
}: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const safeName = typeof name === 'string' ? name : '';
  const showImage = Boolean(src) && !failed;
  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : safeName}
      aria-hidden={decorative || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden font-bold select-none',
        shape === 'circle' ? 'rounded-full' : 'rounded-md',
        SIZES[size],
        !showImage && tintOf(safeName),
        className,
      )}
    >
      {showImage ? (
        <img
          src={src ?? undefined}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true" className="font-display tracking-tight">
          {initialsOf(safeName)}
        </span>
      )}
    </span>
  );
}

export { Avatar as UserAvatar };
