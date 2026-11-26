import { useComposedRefs } from 'radix-ui/internal';
import { useEffect, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { DictationButton, useDictationOffered } from './Dictation';
import { CONTROL_CLASSES, Field, useFieldIds } from './Field';
import type { FieldChrome } from './Field';

/** Dictation by microphone, shared by `Input` and `Textarea`. */
export interface DictationFieldProps {
  /**
   * Microphone button to dictate into the field. On by default in every free-text field; pass
   * `false` to leave this one without it. It is never offered — whatever this prop says — for
   * passwords, e-mail, URL, numbers, dates and other non-text types, for read-only or disabled
   * fields, nor for fields marked `secret`.
   */
  dictation?: boolean;
  /**
   * Language spoken into this field (`es`, `en-GB`…) when it is not the user's dictation
   * language: the voice of a scene, the source language of a translation…
   */
  dictationLanguage?: string | undefined;
  /** The field holds a secret (API key, token, webhook secret): it is never dictated. */
  secret?: boolean;
}

type ControlSize = 'sm' | 'md' | 'lg';
const HEIGHTS: Record<ControlSize, string> = {
  sm: 'h-8 text-sm',
  md: 'h-10 text-sm',
  lg: 'h-12 text-base',
};

export interface InputProps
  extends Omit<ComponentProps<'input'>, 'size'>, FieldChrome, DictationFieldProps {
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
  dictation,
  dictationLanguage,
  secret,
  ref,
  ...props
}: InputProps) {
  const { id, describedBy, invalid, hintId, errorId } = useFieldIds({ hint, error }, explicitId);
  const element = useRef<HTMLInputElement | null>(null);
  const wrapper = useRef<HTMLDivElement | null>(null);
  const composedRef = useComposedRefs(ref, element);
  const mic = useDictationOffered(
    {
      type: props.type,
      readOnly: props.readOnly,
      disabled: props.disabled,
      secret,
      autoComplete: props.autoComplete,
      inputMode: props.inputMode,
      pattern: props.pattern,
    },
    dictation,
  );
  const control = (
    <div ref={wrapper} className={cn('relative flex items-center', !label && wrapperClassName)}>
      {leading && (
        <span className="pointer-events-none absolute left-3 flex items-center text-fg-subtle [&_svg]:size-4">
          {leading}
        </span>
      )}
      <input
        ref={composedRef}
        id={id}
        required={required}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-secret={secret ? '' : undefined}
        className={cn(
          CONTROL_CLASSES,
          HEIGHTS[size],
          'px-3',
          leading && 'pl-9',
          trailing && 'pr-10',
          // Room for the microphone, next to whatever already sits at the end.
          mic && (trailing ? 'pr-[4.5rem]' : 'pr-10'),
          className,
        )}
        {...props}
      />
      {mic && (
        <DictationButton
          target={element}
          anchor={wrapper}
          language={dictationLanguage}
          size={size === 'sm' ? 'sm' : 'md'}
          className={cn(
            'absolute',
            trailing ? 'right-10' : size === 'sm' ? 'right-1' : 'right-1.5',
          )}
        />
      )}
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

export interface TextareaProps
  extends ComponentProps<'textarea'>, FieldChrome, DictationFieldProps {
  /** Class of the outer wrapper (the `className` prop styles the textarea itself). */
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
  dictation,
  dictationLanguage,
  secret,
  ref,
  ...props
}: TextareaProps) {
  const { id, describedBy, invalid, hintId, errorId } = useFieldIds({ hint, error }, explicitId);
  const element = useRef<HTMLTextAreaElement | null>(null);
  const wrapper = useRef<HTMLDivElement | null>(null);
  const composedRef = useComposedRefs(ref, element);
  const mic = useDictationOffered(
    { readOnly: props.readOnly, disabled: props.disabled, secret },
    dictation,
  );
  const scrollbar = useScrollbarWidth(element, mic);
  const count =
    showCount && typeof props.value === 'string' ? (
      <span className="nums">
        {props.value.length}
        {props.maxLength ? ` / ${props.maxLength}` : ''}
      </span>
    ) : null;
  const hasChrome = Boolean(label || hint || error || count);
  const control = (
    // The wrapper is always there (not only with the microphone), so the textarea is never
    // remounted when dictation becomes available after the session loads.
    <div
      ref={wrapper}
      className={cn('relative flex w-full min-w-0', !hasChrome && wrapperClassName)}
    >
      <textarea
        ref={composedRef}
        id={id}
        rows={rows}
        required={required}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-secret={secret ? '' : undefined}
        className={cn(
          CONTROL_CLASSES,
          'min-h-20 resize-y px-3 py-2 text-sm leading-6',
          mic && 'pr-10',
          className,
        )}
        {...props}
      />
      {mic && (
        <DictationButton
          target={element}
          anchor={wrapper}
          language={dictationLanguage}
          className="absolute top-1.5"
          // Stay clear of the scrollbar when the text overflows.
          style={{ right: 6 + scrollbar }}
        />
      )}
    </div>
  );
  if (!hasChrome) return control;
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

/**
 * Width of the vertical scrollbar of a textarea (0 while the text fits, or with overlay
 * scrollbars), so the microphone button can sit next to it instead of on top of it.
 */
function useScrollbarWidth(
  element: { current: HTMLTextAreaElement | null },
  enabled: boolean,
): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = element.current;
    if (!enabled || !node) return;
    const measure = () => {
      const style = window.getComputedStyle(node);
      const borders =
        (Number.parseFloat(style.borderLeftWidth) || 0) +
        (Number.parseFloat(style.borderRightWidth) || 0);
      setWidth(Math.max(0, Math.round(node.offsetWidth - node.clientWidth - borders)));
    };
    measure();
    node.addEventListener('input', measure);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      node.removeEventListener('input', measure);
      observer.disconnect();
    };
  }, [element, enabled]);
  return enabled ? width : 0;
}
