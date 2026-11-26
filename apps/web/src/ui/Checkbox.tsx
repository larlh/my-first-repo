import { Check, Minus } from 'lucide-react';
import { Checkbox as RadixCheckbox } from 'radix-ui';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface CheckboxProps {
  checked: boolean | 'indeterminate';
  onCheckedChange: (checked: boolean) => void;
  /** Visible label (clickable). Without it pass `aria-label`. */
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  'aria-label'?: string;
  className?: string;
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  description,
  error,
  disabled,
  required,
  name,
  id: explicitId,
  className,
  'aria-label': ariaLabel,
}: CheckboxProps) {
  const auto = useId();
  const id = explicitId ?? auto;
  const invalid = error !== undefined && error !== null && error !== false;
  const describedBy = invalid ? `${id}-error` : description ? `${id}-desc` : undefined;
  const box = (
    <RadixCheckbox.Root
      id={id}
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next === true)}
      disabled={disabled}
      required={required}
      name={name}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={cn(
        'flex size-[1.125rem] shrink-0 items-center justify-center rounded-xs border border-line-control bg-surface text-accent-fg',
        'transition-colors duration-150 hover:border-fg-muted',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger',
        !label && className,
      )}
    >
      <RadixCheckbox.Indicator className="flex">
        {checked === 'indeterminate' ? (
          <Minus className="size-3.5" strokeWidth={3} aria-hidden="true" />
        ) : (
          <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
        )}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
  if (!label) return box;
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <span className="flex h-6 items-center">{box}</span>
      <div className="min-w-0">
        <label
          htmlFor={id}
          className={cn('text-sm leading-6 text-fg', disabled && 'text-fg-subtle')}
        >
          {label}
        </label>
        {description && (
          <p id={`${id}-desc`} className="text-sm text-fg-muted">
            {description}
          </p>
        )}
        {invalid && (
          <p id={`${id}-error`} role="alert" className="text-sm font-medium text-danger-text">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
