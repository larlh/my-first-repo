import { Check, ChevronDown } from 'lucide-react';
import { Select as RadixSelect } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { CONTROL_CLASSES, Field, useFieldIds } from './Field';
import type { FieldChrome } from './Field';

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Plain text used for type-ahead when `label` is not a string. */
  textValue?: string;
  /** Secondary line inside the list. */
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SelectGroup<V extends string = string> {
  label: string;
  options: SelectOption<V>[];
}

export interface SelectProps<V extends string = string> extends FieldChrome {
  value: V | undefined;
  onValueChange: (value: V) => void;
  /** Flat options, or groups with a heading. */
  options: SelectOption<V>[] | SelectGroup<V>[];
  placeholder?: string;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  /** Accessible name when there is no visible `label`. */
  'aria-label'?: string;
  className?: string;
  wrapperClassName?: string;
}

const HEIGHTS = { sm: 'h-8 text-sm', md: 'h-10 text-sm', lg: 'h-12 text-base' } as const;

function isGrouped<V extends string>(
  options: SelectOption<V>[] | SelectGroup<V>[],
): options is SelectGroup<V>[] {
  const first = options[0];
  return first !== undefined && 'options' in first;
}

function Item<V extends string>({ option }: { option: SelectOption<V> }) {
  return (
    <RadixSelect.Item
      value={option.value}
      disabled={option.disabled}
      textValue={option.textValue ?? (typeof option.label === 'string' ? option.label : undefined)}
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-sm py-2 pr-8 pl-2.5 text-sm outline-none select-none',
        'data-[highlighted]:bg-surface-3 data-[disabled]:text-fg-subtle data-[disabled]:pointer-events-none',
      )}
    >
      {option.icon && (
        <span className="flex shrink-0 text-fg-muted [&_svg]:size-4">{option.icon}</span>
      )}
      <span className="flex min-w-0 flex-col">
        <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
        {option.description && <span className="text-xs text-fg-muted">{option.description}</span>}
      </span>
      <RadixSelect.ItemIndicator className="absolute right-2 flex items-center text-accent-text">
        <Check className="size-4" aria-hidden="true" />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  );
}

/** Single-choice dropdown (listbox semantics, type-ahead, arrow keys). */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  placeholder,
  size = 'md',
  disabled,
  required,
  name,
  id: explicitId,
  label,
  hint,
  error,
  optionalLabel,
  labelAside,
  className,
  wrapperClassName,
  'aria-label': ariaLabel,
}: SelectProps<V>) {
  const { id, describedBy, invalid, hintId, errorId } = useFieldIds({ hint, error }, explicitId);
  const control = (
    <RadixSelect.Root
      value={value ?? ''}
      onValueChange={(next) => onValueChange(next as V)}
      disabled={disabled}
      required={required}
      name={name}
    >
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(
          CONTROL_CLASSES,
          HEIGHTS[size],
          'inline-flex items-center justify-between gap-2 px-3 text-left data-[placeholder]:text-fg-subtle',
          '[&>span:first-child]:truncate',
          className,
        )}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="shrink-0 text-fg-muted">
          <ChevronDown className="size-4" aria-hidden="true" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-[60] max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden',
            'rounded-lg border border-line bg-surface text-fg shadow-lg data-[state=open]:animate-pop-in',
          )}
        >
          <RadixSelect.Viewport className="p-1">
            {isGrouped(options)
              ? options.map((group) => (
                  <RadixSelect.Group key={group.label}>
                    <RadixSelect.Label className="eyebrow px-2.5 pt-2.5 pb-1 text-fg-subtle">
                      {group.label}
                    </RadixSelect.Label>
                    {group.options.map((option) => (
                      <Item key={option.value} option={option} />
                    ))}
                  </RadixSelect.Group>
                ))
              : options.map((option) => <Item key={option.value} option={option} />)}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
  if (!label && !hint && !error) {
    return wrapperClassName ? <div className={wrapperClassName}>{control}</div> : control;
  }
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
      required={required}
      className={wrapperClassName}
    >
      {control}
    </Field>
  );
}
