import { Check } from 'lucide-react';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/ui';

export interface Choice<V extends string> {
  value: V;
  label: string;
  description?: string;
  /** Picture above the label (theme preview, language sample). */
  visual?: ReactNode;
  /** Extra line under the description (status badge, availability). */
  note?: ReactNode;
  /** This option cannot be chosen right now. */
  disabled?: boolean;
}

/** Radio group drawn as cards. Native radios: arrow keys move, Space selects. */
export function ChoiceCards<V extends string>({
  legend,
  value,
  onChange,
  choices,
  disabled,
}: {
  legend: string;
  value: V;
  onChange: (value: V) => void;
  choices: Choice<V>[];
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {choices.map((choice) => {
          const checked = choice.value === value;
          return (
            <label
              key={choice.value}
              className={cn(
                'relative flex cursor-pointer flex-col gap-3 rounded-lg border bg-surface p-3 transition-[border-color,box-shadow] duration-150',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                'has-[:disabled]:cursor-wait has-[:disabled]:opacity-70',
                choice.disabled && 'cursor-not-allowed',
                checked
                  ? 'border-fg shadow-[inset_0_0_0_1px_var(--fg)]'
                  : 'border-line hover:border-line-strong',
              )}
            >
              <input
                type="radio"
                name={name}
                value={choice.value}
                checked={checked}
                disabled={choice.disabled}
                onChange={() => onChange(choice.value)}
                className="sr-only"
              />
              {choice.visual}
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{choice.label}</span>
                  {choice.description && (
                    <span className="block text-sm text-fg-muted">{choice.description}</span>
                  )}
                  {choice.note && <span className="mt-2 block">{choice.note}</span>}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
                    checked ? 'border-fg bg-fg text-bg' : 'border-line-control',
                  )}
                >
                  {checked && <Check className="size-3.5" strokeWidth={3} />}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
