import { Check } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { CONTROL_CLASSES, Field, useFieldIds } from './Field';
import type { FieldChrome } from './Field';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

/** Presets tuned for video: readable brand colours plus neutrals. */
export const DEFAULT_COLOR_PRESETS = [
  '#1b1424',
  '#ffffff',
  '#fbf7f1',
  '#ff5b2e',
  '#ffc233',
  '#1e8e63',
  '#2468b4',
  '#7c4dff',
  '#e3214f',
  '#f29fb5',
  '#8fd3c8',
  '#5c5167',
] as const;

/** `#abc`, `abc`, `#AABBCC` → `#aabbcc`; null when it is not a hex colour. */
export function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(raw)) {
    return `#${raw
      .split('')
      .map((c) => c + c)
      .join('')}`;
  }
  return /^[0-9a-f]{6}$/.test(raw) ? `#${raw}` : null;
}

/** True when ink text reads better than white on this colour. */
export function isLightColor(hex: string): boolean {
  const value = normalizeHex(hex) ?? '#000000';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0) > 0.6;
}

export interface ColorPickerProps extends FieldChrome {
  /** `#rrggbb` */
  value: string;
  onChange: (hex: string) => void;
  presets?: readonly string[];
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  /** Only the swatch as trigger (toolbars). */
  compact?: boolean;
  className?: string;
  /** Extra content under the presets (e.g. brand kit colours). */
  children?: ReactNode;
}

/**
 * Colour field: swatch trigger → popover with the system picker, presets and a hex input.
 * Everything is reachable by keyboard; the hex field accepts 3 or 6 digits.
 */
export function ColorPicker({
  value,
  onChange,
  presets = DEFAULT_COLOR_PRESETS,
  disabled,
  id: explicitId,
  label,
  hint,
  error,
  optionalLabel,
  labelAside,
  compact = false,
  className,
  children,
  'aria-label': ariaLabel,
}: ColorPickerProps) {
  const { t } = useTranslation('shell');
  const { id, describedBy, invalid, hintId, errorId } = useFieldIds({ hint, error }, explicitId);
  const hexId = useId();
  const current = normalizeHex(value) ?? '#000000';
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);

  const commit = (text: string) => {
    const next = normalizeHex(text);
    if (next) onChange(next);
    else setDraft(current);
  };

  const control = (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-label={ariaLabel ?? (label ? undefined : t('ui.color.pick'))}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn(
            CONTROL_CLASSES,
            'inline-flex h-10 items-center gap-2.5 text-sm',
            compact ? 'w-10 justify-center px-0' : 'px-2.5',
            !label && className,
          )}
        >
          <span
            aria-hidden="true"
            className="size-6 shrink-0 rounded-sm border border-fg/15"
            style={{ backgroundColor: current }}
          />
          {!compact && <span className="nums font-mono text-sm uppercase">{current}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="flex flex-col gap-3">
          <label className="relative block h-28 overflow-hidden rounded-md border border-line">
            <span className="sr-only">{t('ui.color.custom')}</span>
            <input
              type="color"
              value={current}
              onChange={(event) => onChange(event.target.value.toLowerCase())}
              className="absolute -inset-2 size-[calc(100%+1rem)] cursor-pointer border-0 bg-transparent p-0"
            />
            <span
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute inset-0 flex items-end justify-end p-2 text-xs font-semibold',
                isLightColor(current) ? 'text-accent-fg' : 'text-on-media',
              )}
              style={{ backgroundColor: current }}
            >
              {t('ui.color.custom')}
            </span>
          </label>
          <div role="group" aria-label={t('ui.color.presets')} className="grid grid-cols-6 gap-1.5">
            {presets.map((preset) => {
              const hex = normalizeHex(preset) ?? preset;
              const selected = hex === current;
              return (
                <button
                  key={hex}
                  type="button"
                  aria-label={hex}
                  aria-pressed={selected}
                  onClick={() => onChange(hex)}
                  className="flex aspect-square items-center justify-center rounded-sm border border-fg/15 transition-transform duration-100 hover:scale-110"
                  style={{ backgroundColor: hex }}
                >
                  {selected && (
                    <Check
                      aria-hidden="true"
                      strokeWidth={3}
                      className={cn(
                        'size-3.5',
                        isLightColor(hex) ? 'text-accent-fg' : 'text-on-media',
                      )}
                    />
                  )}
                </button>
              );
            })}
          </div>
          {children}
          <div className="flex items-center gap-2">
            <label htmlFor={hexId} className="text-sm font-semibold">
              Hex
            </label>
            <input
              id={hexId}
              value={draft}
              spellCheck={false}
              autoCapitalize="off"
              maxLength={7}
              onChange={(event) => {
                setDraft(event.target.value);
                const next = normalizeHex(event.target.value);
                if (next && event.target.value.replace('#', '').length === 6) onChange(next);
              }}
              onBlur={(event) => commit(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commit(event.currentTarget.value);
              }}
              className={cn(CONTROL_CLASSES, 'h-8 px-2 font-mono text-sm uppercase')}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
  if (!label && !hint && !error) return control;
  return (
    <Field
      htmlFor={id}
      label={label}
      hint={hint}
      error={error}
      optionalLabel={optionalLabel}
      labelAside={labelAside}
      hintId={hintId}
      errorId={errorId}
      className={className}
    >
      {control}
    </Field>
  );
}
