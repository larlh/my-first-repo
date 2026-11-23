import type { Avatar } from '@parlante/shared';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toAppUrl } from '@/lib/api';
import { cn } from '@/ui';
import { AvatarCanvas } from './AvatarCanvas';

export interface AvatarPickerProps {
  /** Selectable avatars (pass `usableAvatars(...)`). */
  avatars: readonly Avatar[];
  value: string | null;
  onChange: (avatar: Avatar) => void;
  legend: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * Single-choice grid of avatars. It is a native radio group: arrow keys move the choice, Tab
 * leaves the group. Instant avatars are drawn live with their rig; photorealistic ones show
 * their thumbnail.
 */
export function AvatarPicker({
  avatars,
  value,
  onChange,
  legend,
  hint,
  disabled = false,
  className,
}: AvatarPickerProps) {
  const { t } = useTranslation('script-writer');
  const name = useId();
  return (
    <fieldset className={cn('min-w-0', className)} disabled={disabled}>
      <legend className="mb-1.5 text-sm font-semibold">{legend}</legend>
      {hint && <p className="mb-2 text-sm text-fg-muted">{hint}</p>}
      <div className="-m-1 grid max-h-72 grid-cols-3 gap-2 overflow-y-auto p-1 sm:grid-cols-4">
        {avatars.map((avatar) => {
          const checked = avatar.id === value;
          const photoreal = avatar.rendering === 'photoreal';
          return (
            <label key={avatar.id} className="relative min-w-0 cursor-pointer">
              <input
                type="radio"
                name={name}
                value={avatar.id}
                checked={checked}
                onChange={() => onChange(avatar)}
                className="peer sr-only"
              />
              <span
                className={cn(
                  'flex flex-col overflow-hidden rounded-lg border border-line-strong bg-surface transition-colors duration-150',
                  'hover:bg-surface-2 peer-checked:border-fg peer-checked:shadow-[inset_0_0_0_1px_var(--fg)]',
                  'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
                  'peer-disabled:cursor-not-allowed peer-disabled:opacity-60',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'relative block aspect-square w-full',
                    checked ? 'bg-accent-soft' : 'bg-surface-3',
                  )}
                >
                  {photoreal && avatar.thumbnailUrl ? (
                    <img
                      src={toAppUrl(avatar.thumbnailUrl)}
                      alt=""
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <AvatarCanvas
                      avatar={avatar}
                      label=""
                      maxSide={320}
                      className="absolute inset-0"
                    />
                  )}
                </span>
                <span className="flex min-w-0 items-center justify-between gap-1 px-2 py-1.5">
                  <span className="truncate text-xs font-semibold">{avatar.name}</span>
                  <span className="shrink-0 font-mono text-2xs text-fg-subtle uppercase">
                    {photoreal ? t('kit.avatar.photoreal') : t('kit.avatar.instant')}
                  </span>
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
