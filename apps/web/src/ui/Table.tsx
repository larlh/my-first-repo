import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Skeleton } from './Skeleton';

/* Data table primitives. Wide tables scroll horizontally inside their own region, so the
 * page never overflows on phones.
 *
 *   <Table aria-label="Miembros">
 *     <THead><Tr><Th>Nombre</Th><Th align="right">Rol</Th></Tr></THead>
 *     <TBody>{rows.map((m) => <Tr key={m.id}><Td>{m.name}</Td><Td align="right">…</Td></Tr>)}</TBody>
 *   </Table>
 */

export interface TableProps extends ComponentProps<'table'> {
  /** Class of the scroll container. */
  containerClassName?: string;
  /** Tighter rows. */
  dense?: boolean;
}

export function Table({ className, containerClassName, dense, ...props }: TableProps) {
  return (
    <div
      className={cn(
        // `relative` keeps absolutely positioned descendants (sr-only labels) inside the scroll
        // box; otherwise they widen the page on narrow screens.
        'relative w-full overflow-x-auto rounded-lg border border-line bg-surface',
        containerClassName,
      )}
    >
      <table
        data-dense={dense || undefined}
        className={cn('group/table w-full border-collapse text-left text-sm', className)}
        {...props}
      />
    </div>
  );
}

export function THead({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('border-b border-line bg-surface-2', className)} {...props} />;
}

export function TBody({ className, ...props }: ComponentProps<'tbody'>) {
  return (
    <tbody
      className={cn('[&>tr:not(:last-child)]:border-b [&>tr]:border-line', className)}
      {...props}
    />
  );
}

export interface TrProps extends ComponentProps<'tr'> {
  /** Row hover highlight (rows that open something). */
  interactive?: boolean;
  selected?: boolean;
}

export function Tr({ className, interactive, selected, ...props }: TrProps) {
  return (
    <tr
      aria-selected={selected}
      className={cn(
        interactive && 'transition-colors duration-100 hover:bg-surface-2',
        selected && 'bg-accent-soft/50',
        className,
      )}
      {...props}
    />
  );
}

type Align = 'left' | 'center' | 'right';
const ALIGN: Record<Align, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

export function Th({
  className,
  align = 'left',
  scope = 'col',
  ...props
}: Omit<ComponentProps<'th'>, 'align'> & { align?: Align }) {
  return (
    <th
      scope={scope}
      className={cn('eyebrow h-10 px-4 whitespace-nowrap text-fg-muted', ALIGN[align], className)}
      {...props}
    />
  );
}

export function Td({
  className,
  align = 'left',
  ...props
}: Omit<ComponentProps<'td'>, 'align'> & { align?: Align }) {
  return (
    <td
      className={cn(
        'px-4 py-3 align-middle group-data-[dense]/table:py-2',
        ALIGN[align],
        className,
      )}
      {...props}
    />
  );
}

/** Body rows of skeletons while a table loads. */
export function TableSkeletonRows({ rows = 4, columns }: { rows?: number; columns: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <Tr key={r}>
          {Array.from({ length: columns }, (_, c) => (
            <Td key={c}>
              <Skeleton className={c === 0 ? 'w-40 max-w-full' : 'w-20 max-w-full'} />
            </Td>
          ))}
        </Tr>
      ))}
    </>
  );
}

/** One full-width row for empty / error content inside a table body. */
export function TableMessageRow({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={columns}>{children}</td>
    </tr>
  );
}
