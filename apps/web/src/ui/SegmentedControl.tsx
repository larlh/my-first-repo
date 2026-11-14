import { RadioGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Tooltip } from './Tooltip';

export interface SegmentOption<V extends string = string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  /** Accessible name / tooltip for icon-only segments. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  value: V;
  onValueChange: (value: V) => void;
  options: SegmentOption<V>[];
  /** Accessible name of the group. */
  'aria-label': string;
  size?: 'sm' | 'md';
  /** Stretch to the container width with equal segments. */
  block?: boolean;
  disabled?: boolean;
  className?: string;
}

/** A few mutually exclusive options in one row (radio group semantics, arrow keys). */
export function SegmentedControl<V extends string = string>({
  value,
  onValueChange,
  options,
  size = 'md',
  block = false,
  disabled,
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<V>) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(next) => onValueChange(next as V)}
      orientation="horizontal"
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn(
        'inline-flex max-w-full gap-1 rounded-lg bg-surface-3 p-1',
        block && 'flex w-full',
        className,
      )}
    >
      {options.map((option) => {
        const item = (
          <RadioGroup.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            aria-label={option.title}
            className={cn(
              'inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md font-semibold whitespace-nowrap text-fg-muted transition-colors duration-150',
              'hover:text-fg disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
              'data-[state=checked]:bg-surface data-[state=checked]:text-fg data-[state=checked]:shadow-xs',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
              block && 'flex-1',
            )}
          >
            {option.icon}
            {option.label}
          </RadioGroup.Item>
        );
        return option.title ? (
          <Tooltip key={option.value} content={option.title}>
            {item}
          </Tooltip>
        ) : (
          item
        );
      })}
    </RadioGroup.Root>
  );
}
