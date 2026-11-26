import { Slot } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'solid' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold select-none ' +
  'transition-[background-color,color,border-color,box-shadow,transform] duration-150 ease-standard ' +
  'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 ' +
  'active:translate-y-px [&_svg]:shrink-0';

const VARIANTS: Record<ButtonVariant, string> = {
  /** The one loud action of a view: vermilion with ink text. */
  primary: 'bg-accent text-accent-fg shadow-edge hover:bg-accent-hover',
  /** High-contrast neutral (ink on paper / paper on ink). */
  solid: 'bg-inverse text-inverse-fg hover:opacity-90',
  secondary: 'border border-line-strong bg-surface text-fg shadow-xs hover:bg-surface-2',
  ghost: 'text-fg hover:bg-fg/8',
  danger: 'bg-danger text-danger-fg shadow-edge hover:bg-danger-hover',
  link: 'h-auto rounded-xs px-0 font-medium text-accent-text underline-offset-4 hover:underline active:translate-y-0',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm [&_svg]:size-4',
  md: 'h-10 px-4 text-sm [&_svg]:size-[1.125rem]',
  lg: 'h-12 px-6 text-base [&_svg]:size-5',
};

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks interaction. */
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  /** Stretch to the container width. */
  block?: boolean;
  /** Render the single child element (e.g. a router `<Link>`) with the button look. */
  asChild?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  leftIcon,
  rightIcon,
  block = false,
  asChild = false,
  className,
  children,
  disabled,
  type,
  ...props
}: ButtonProps) {
  const classes = cn(
    BASE,
    VARIANTS[variant],
    variant === 'link' ? 'text-sm' : SIZES[size],
    block && 'w-full',
    className,
  );
  const leading = loading ? <Spinner size="sm" label={null} /> : leftIcon;
  if (asChild) {
    // Slot merges these props into the single child element; `Slottable` marks where that
    // child's own content goes, so icons can sit around it.
    return (
      <Slot.Root
        className={classes}
        aria-disabled={disabled || loading ? true : undefined}
        aria-busy={loading || undefined}
        {...(props as ComponentProps<typeof Slot.Root>)}
      >
        {leading}
        <Slot.Slottable>{children}</Slot.Slottable>
        {rightIcon}
      </Slot.Root>
    );
  }
  return (
    <button
      type={type ?? 'button'}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {leading}
      {children}
      {rightIcon}
    </button>
  );
}

const ICON_SIZES: Record<ButtonSize, string> = {
  sm: 'size-8 [&_svg]:size-4',
  md: 'size-10 [&_svg]:size-[1.125rem]',
  lg: 'size-12 [&_svg]:size-5',
};

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'aria-label'> {
  /** Required accessible name; also shown as a tooltip. */
  label: string;
  variant?: Exclude<ButtonVariant, 'link'>;
  size?: ButtonSize;
  loading?: boolean;
  /** Hide the tooltip (the accessible name stays). */
  noTooltip?: boolean;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}

/** Square button with only an icon. `label` is mandatory: it is the accessible name. */
export function IconButton({
  label,
  variant = 'ghost',
  size = 'md',
  loading = false,
  noTooltip = false,
  tooltipSide,
  className,
  children,
  disabled,
  type,
  ...props
}: IconButtonProps) {
  const button = (
    <button
      type={type ?? 'button'}
      aria-label={label}
      className={cn(BASE, VARIANTS[variant], ICON_SIZES[size], 'px-0', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner size="sm" label={null} /> : children}
    </button>
  );
  if (noTooltip) return button;
  return (
    <Tooltip content={label} side={tooltipSide}>
      {button}
    </Tooltip>
  );
}
