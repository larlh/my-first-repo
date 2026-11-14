import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export interface CardProps extends ComponentProps<'div'> {
  /** Hover/focus affordance for cards that are links or buttons (combine with `asChild`). */
  interactive?: boolean;
  /** `sunken` for secondary groups inside a page section. */
  variant?: 'raised' | 'sunken' | 'outline';
  padded?: boolean;
  asChild?: boolean;
}

/** Surface container. Compose with CardHeader / CardTitle / CardContent / CardFooter. */
export function Card({
  interactive = false,
  variant = 'raised',
  padded = false,
  asChild = false,
  className,
  ...props
}: CardProps) {
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp
      className={cn(
        'flex min-w-0 flex-col rounded-lg text-fg',
        variant === 'raised' && 'border border-line bg-surface shadow-xs',
        variant === 'sunken' && 'bg-bg-sunken',
        variant === 'outline' && 'border border-line',
        padded && 'p-5',
        interactive &&
          'transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md',
        className,
      )}
      {...(props as ComponentProps<'div'>)}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('flex items-start justify-between gap-4 p-5 pb-0', className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('text-lg leading-6', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('mt-1 text-sm text-fg-muted', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-5', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'mt-auto flex items-center justify-end gap-2 border-t border-line px-5 py-3.5',
        className,
      )}
      {...props}
    />
  );
}
