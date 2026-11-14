import { useId } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-semibold text-fg', className)} {...props} />;
}

export interface FieldChrome {
  /** Visible label. */
  label?: ReactNode;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Error message: marks the control invalid and replaces the hint. */
  error?: ReactNode;
  /** Adds the "optional" marker next to the label. */
  optionalLabel?: ReactNode;
  /** Extra element at the right of the label row (counter, link…). */
  labelAside?: ReactNode;
}

export interface FieldIds {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

/** Ids and ARIA wiring shared by every form control of the kit. */
export function useFieldIds(
  chrome: Pick<FieldChrome, 'hint' | 'error'>,
  explicitId?: string,
): FieldIds & { hintId: string; errorId: string } {
  const auto = useId();
  const id = explicitId ?? auto;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = chrome.error !== undefined && chrome.error !== null && chrome.error !== false;
  const describedBy = invalid ? errorId : chrome.hint ? hintId : undefined;
  return { id, describedBy, invalid, hintId, errorId };
}

export interface FieldProps extends FieldChrome {
  /** id of the control the label points to. */
  htmlFor: string;
  hintId?: string;
  errorId?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Label + control + hint/error layout. Input, Textarea, Select, Slider… render it themselves
 * when they receive `label` / `hint` / `error`; use it directly for custom controls.
 */
export function Field({
  htmlFor,
  label,
  hint,
  error,
  optionalLabel,
  labelAside,
  hintId,
  errorId,
  required,
  className,
  children,
}: FieldProps) {
  const invalid = error !== undefined && error !== null && error !== false;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {(label || labelAside) && (
        <div className="flex items-baseline justify-between gap-3">
          {label && (
            <Label htmlFor={htmlFor}>
              {label}
              {required && (
                <span aria-hidden="true" className="ml-0.5 text-accent-text">
                  *
                </span>
              )}
              {optionalLabel && (
                <span className="ml-1.5 font-normal text-fg-subtle">{optionalLabel}</span>
              )}
            </Label>
          )}
          {labelAside && <div className="text-xs text-fg-subtle">{labelAside}</div>}
        </div>
      )}
      {children}
      {invalid ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-danger-text">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className="text-sm text-fg-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** Shared look of text-like controls. */
export const CONTROL_CLASSES =
  'w-full min-w-0 rounded-md border border-line-control bg-surface text-fg shadow-xs ' +
  'placeholder:text-fg-subtle transition-[border-color,box-shadow,background-color] duration-150 ' +
  'hover:border-fg-muted focus-visible:border-fg focus-visible:outline-2 focus-visible:outline-offset-0 ' +
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-subtle disabled:hover:border-line-control ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:outline-danger';
