import { Switch as RadixSwitch } from 'radix-ui';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  name?: string;
  id?: string;
  size?: 'sm' | 'md';
  /** Put the label before the switch and push the switch to the end of the row. */
  labelPosition?: 'start' | 'end';
  'aria-label'?: string;
  className?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  name,
  id: explicitId,
  size = 'md',
  labelPosition = 'end',
  className,
  'aria-label': ariaLabel,
}: SwitchProps) {
  const auto = useId();
  const id = explicitId ?? auto;
  const control = (
    <RadixSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      name={name}
      aria-label={ariaLabel}
      aria-describedby={description ? `${id}-desc` : undefined}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full border border-line-control bg-surface-3 transition-colors duration-150',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-5 w-9' : 'h-6 w-11',
        !label && className,
      )}
    >
      <RadixSwitch.Thumb
        className={cn(
          'block rounded-full bg-fg shadow-sm transition-transform duration-150 ease-out-expo data-[state=checked]:bg-accent-fg',
          size === 'sm'
            ? 'size-3.5 translate-x-0.5 data-[state=checked]:translate-x-[1.125rem]'
            : 'size-[1.125rem] translate-x-0.5 data-[state=checked]:translate-x-[1.375rem]',
        )}
      />
    </RadixSwitch.Root>
  );
  if (!label) return control;
  return (
    <div
      className={cn(
        'flex items-start gap-3',
        labelPosition === 'start' && 'flex-row-reverse justify-between',
        className,
      )}
    >
      <span className="flex h-6 items-center">{control}</span>
      <div className="min-w-0">
        <label
          htmlFor={id}
          className={cn('text-sm leading-6 font-medium text-fg', disabled && 'text-fg-subtle')}
        >
          {label}
        </label>
        {description && (
          <p id={`${id}-desc`} className="text-sm text-fg-muted">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
