import { Slider as RadixSlider } from 'radix-ui';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SliderProps {
  value: number;
  onValueChange: (value: number) => void;
  /** Fired when the user releases the thumb (use it for expensive updates / undo steps). */
  onValueCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: ReactNode;
  /** Text for the current value shown next to the label and announced (e.g. "1,25×"). */
  formatValue?: (value: number) => string;
  hint?: ReactNode;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  className?: string;
}

/** Single-thumb range slider (arrow keys, Home/End, PageUp/PageDown). */
export function Slider({
  value,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  label,
  formatValue,
  hint,
  disabled,
  id: explicitId,
  className,
  'aria-label': ariaLabel,
}: SliderProps) {
  const auto = useId();
  const id = explicitId ?? auto;
  const text = formatValue ? formatValue(value) : undefined;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {(label || text) && (
        <div className="flex items-baseline justify-between gap-3">
          {label && (
            <span id={`${id}-label`} className="text-sm font-semibold text-fg">
              {label}
            </span>
          )}
          {text && <span className="nums text-sm text-fg-muted">{text}</span>}
        </div>
      )}
      <RadixSlider.Root
        value={[value]}
        onValueChange={(next) => onValueChange(next[0] ?? value)}
        onValueCommit={onValueCommit ? (next) => onValueCommit(next[0] ?? value) : undefined}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="relative flex h-6 w-full touch-none items-center select-none data-[disabled]:opacity-50"
      >
        <RadixSlider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-surface-3">
          <RadixSlider.Range className="absolute h-full rounded-full bg-accent" />
        </RadixSlider.Track>
        <RadixSlider.Thumb
          aria-label={label ? undefined : ariaLabel}
          aria-labelledby={label ? `${id}-label` : undefined}
          aria-valuetext={text}
          className={cn(
            'block size-[1.125rem] rounded-full border-2 border-fg bg-surface shadow-sm transition-transform duration-100',
            'hover:scale-110 data-[disabled]:pointer-events-none',
          )}
        />
      </RadixSlider.Root>
      {hint && <p className="text-sm text-fg-muted">{hint}</p>}
    </div>
  );
}
