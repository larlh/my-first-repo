import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { CONTROL_CLASSES, Field, useFieldIds } from './Field';
import type { FieldChrome } from './Field';

type ControlSize = 'sm' | 'md' | 'lg';
const HEIGHTS: Record<ControlSize, string> = {
  sm: 'h-8 text-sm',
  md: 'h-10 text-sm',
  lg: 'h-12 text-base',
};

export interface InputProps extends Omit<ComponentProps<'input'>, 'size'>, FieldChrome {
  size?: ControlSize;
  /** Icon or text inside the control, before the value. */
  leading?: ReactNode;
  /** Icon, unit or button inside the control, after the value. */
  trailing?: ReactNode;
  /** Class of the outer wrapper (the `className` prop styles the input itself). */
  wrapperClassName?: string;
}

/** Text input. Works with react-hook-form: `<Input label="…" error={…} {...register('name')} />`. */
export function Input({
  size = 'md',
  label,
  hint,
  error,
  optionalLabel,
  labelAside,
  leading,
  trailing,
  className,
  wrapperClassName,
  id: explicitId,
  required,
  ...props
}: InputProps) {
  const { id, describedBy, invalid, hintId, errorId } = useFieldIds({ hint, error }, explicitId);
  const control = (
    <div className={cn('relative flex items-center', !label && wrapperClassName)}>
      {leading && (
        <span className="pointer-events-none absolute left-3 flex items-center text-fg-subtle [&_svg]:size-4">
          {leading}
        </span>
      )}
      <input
        id={id}
        required={required}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(
          CONTROL_CLASSES,
          HEIGHTS[size],
          'px-3',
          leading && 'pl-9',
          trailing && 'pr-10',
          className,
        )}
        {...props}
      />
      {trailing && (
        <span className="absolute right-1.5 flex items-center text-fg-subtle [&_svg]:size-4">
          {trailing}
        </span>
      )}
    </div>
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
      required={required}
      className={wrapperClassName}
    >
      {control}
    </Field>
  );
}

export interface TextareaProps extends ComponentProps<'textarea'>, FieldChrome {
  wrapperClassName?: string;
  /** Shows `current / max` next to the label when `maxLength` is set and the value is controlled. */
  showCount?: boolean;
}

export function Textarea({
  label,
  hint,
  error,
  optionalLabel,
  labelAside,
  className,
  wrapperClassName,
  showCount,
  id: explicitId,
  required,
  rows = 4,
  ...props
}: TextareaProps) {
  const { id, describedBy, invalid, hintId, errorId } = useFieldIds({ hint, error }, explicitId);
  const count =
    showCount && typeof props.value === 'string' ? (
      <span className="nums">
        {props.value.length}
        {props.maxLength ? ` / ${props.maxLength}` : ''}
      </span>
    ) : null;
  const control = (
    <textarea
      id={id}
      rows={rows}
      required={required}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={cn(CONTROL_CLASSES, 'min-h-20 resize-y px-3 py-2 text-sm leading-6', className)}
      {...props}
    />
  );
  if (!label && !hint && !error && !count) return control;
  return (
    <Field
      htmlFor={id}
      label={label}
      hint={hint}
      error={error}
      optionalLabel={optionalLabel}
      labelAside={labelAside ?? count}
      hintId={hintId}
      errorId={errorId}
      required={required}
      className={wrapperClassName}
    >
      {control}
    </Field>
  );
}
