import { Tabs as RadixTabs } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  /** Small counter / badge after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<V extends string = string> {
  value: V;
  onValueChange: (value: V) => void;
  tabs: TabItem<V>[];
  /** Accessible name of the tab list. */
  'aria-label': string;
  /** `underline` for page sections, `pills` for compact panels. */
  variant?: 'underline' | 'pills';
  /** Stretch tabs to share the full width. */
  fill?: boolean;
  className?: string;
  /** `<TabPanel value="…">` elements. */
  children?: ReactNode;
}

/** Tabs with roving focus (arrow keys) and automatic activation. */
export function Tabs<V extends string = string>({
  value,
  onValueChange,
  tabs,
  variant = 'underline',
  fill = false,
  className,
  children,
  'aria-label': ariaLabel,
}: TabsProps<V>) {
  return (
    <RadixTabs.Root
      value={value}
      onValueChange={(next) => onValueChange(next as V)}
      className={cn('flex min-w-0 flex-col', className)}
    >
      <RadixTabs.List
        aria-label={ariaLabel}
        className={cn(
          'flex min-w-0 shrink-0 overflow-x-auto',
          variant === 'underline'
            ? 'gap-5 border-b border-line'
            : 'gap-1 self-start rounded-lg bg-surface-3 p-1',
          fill && 'self-stretch',
        )}
      >
        {tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.value}
            value={tab.value}
            disabled={tab.disabled}
            className={cn(
              'inline-flex shrink-0 items-center justify-center gap-2 text-sm font-semibold whitespace-nowrap text-fg-muted transition-colors duration-150',
              'hover:text-fg disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4',
              fill && 'flex-1',
              variant === 'underline'
                ? '-mb-px border-b-2 border-transparent px-0.5 pt-1 pb-2.5 data-[state=active]:border-accent data-[state=active]:text-fg'
                : 'h-8 rounded-md px-3 data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-xs',
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.badge}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  );
}

export function TabPanel({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cn('pt-5 outline-offset-4', className)} {...props} />;
}
