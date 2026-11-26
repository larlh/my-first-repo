import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { ColorPicker, Input, cn } from '@/ui';

/* Small building blocks of the inspector. */

export function Section({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('border-b border-line px-4 py-4', className)}>
      <div className="mb-3 flex min-h-6 items-center justify-between gap-2">
        <h3 id={id} className="eyebrow text-fg-muted">
          {title}
        </h3>
        {aside}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  /** Called when the field loses focus (end of an undo step). */
  onCommit?: () => void;
  min: number;
  max: number;
  step?: number;
  /** Display multiplier: 100 shows a 0..1 value as a percentage. */
  scale?: number;
  /** Decimals shown. */
  digits?: number;
  suffix?: string;
  disabled?: boolean;
}

/** Compact numeric input: applies every valid keystroke, clamps, restores on blur. */
export function NumberField({
  label,
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  scale = 1,
  digits = 0,
  suffix,
  disabled,
}: NumberFieldProps) {
  const shown = (value * scale).toFixed(digits).replace(/\.0+$/, '');
  const [draft, setDraft] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(shown);
  }, [shown, focused]);
  return (
    <Input
      label={label}
      size="sm"
      type="number"
      inputMode="decimal"
      value={focused ? draft : shown}
      min={min * scale}
      max={max * scale}
      step={step}
      disabled={disabled}
      trailing={suffix ? <span className="text-xs text-fg-subtle">{suffix}</span> : undefined}
      className="nums"
      onFocus={() => {
        setDraft(shown);
        setFocused(true);
      }}
      onBlur={() => {
        setFocused(false);
        onCommit?.();
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value.replace(',', '.'));
        if (event.target.value.trim() === '' || !Number.isFinite(parsed)) return;
        const next = Math.max(min, Math.min(max, parsed / scale));
        if (next !== value) onChange(next);
      }}
    />
  );
}

/** Colour field for Composition colours, which may carry alpha (`#rrggbbaa`): alpha is kept. */
export function ColorField({
  label,
  value,
  onChange,
  compact,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  compact?: boolean;
}) {
  const alpha =
    value.length === 9 ? value.slice(7) : value.length === 5 ? value.slice(4).repeat(2) : '';
  const opaque =
    value.length === 9 ? value.slice(0, 7) : value.length === 5 ? value.slice(0, 4) : value;
  return (
    <ColorPicker
      label={compact ? undefined : label}
      aria-label={label}
      compact={compact}
      value={opaque}
      onChange={(hex) => onChange(`${hex}${alpha}`)}
    />
  );
}

/** Two controls side by side. */
export function Pair({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2.5">{children}</div>;
}
