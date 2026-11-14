import { Check, ChevronRight } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/* Dropdown menu (menu / menuitem roles, arrow keys, type-ahead, Escape).
 *
 *   <Menu>
 *     <MenuTrigger asChild><IconButton label="Más acciones"><Ellipsis /></IconButton></MenuTrigger>
 *     <MenuContent align="end">
 *       <MenuItem icon={<Copy />} onSelect={duplicate}>Duplicar</MenuItem>
 *       <MenuSeparator />
 *       <MenuItem tone="danger" icon={<Trash2 />} onSelect={remove}>Eliminar</MenuItem>
 *     </MenuContent>
 *   </Menu>
 */

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuGroup = DropdownMenu.Group;
export const MenuRadioGroup = DropdownMenu.RadioGroup;
export const MenuSub = DropdownMenu.Sub;

const SURFACE =
  'z-[60] min-w-44 max-w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-line bg-surface p-1 text-fg shadow-lg ' +
  'max-h-[var(--radix-dropdown-menu-content-available-height)] data-[state=open]:animate-pop-in';

const ITEM =
  'relative flex cursor-default items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm outline-none select-none ' +
  'data-[highlighted]:bg-surface-3 data-[disabled]:pointer-events-none data-[disabled]:text-fg-subtle [&_svg]:size-4 [&_svg]:shrink-0';

export function MenuContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(SURFACE, className)}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

export interface MenuItemProps extends ComponentProps<typeof DropdownMenu.Item> {
  icon?: ReactNode;
  /** Right-aligned hint (shortcut, value). */
  trailing?: ReactNode;
  tone?: 'default' | 'danger';
}

export function MenuItem({ icon, trailing, tone, className, children, ...props }: MenuItemProps) {
  return (
    <DropdownMenu.Item
      className={cn(
        ITEM,
        tone === 'danger' && 'text-danger-text data-[highlighted]:bg-danger-soft',
        className,
      )}
      {...props}
    >
      {icon && <span className={cn('flex', tone !== 'danger' && 'text-fg-muted')}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing && <span className="ml-4 text-xs text-fg-subtle">{trailing}</span>}
    </DropdownMenu.Item>
  );
}

export function MenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenu.CheckboxItem>) {
  return (
    <DropdownMenu.CheckboxItem className={cn(ITEM, 'pr-8', className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <DropdownMenu.ItemIndicator className="absolute right-2 flex text-accent-text">
        <Check aria-hidden="true" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.CheckboxItem>
  );
}

export function MenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenu.RadioItem>) {
  return (
    <DropdownMenu.RadioItem className={cn(ITEM, 'pr-8', className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <DropdownMenu.ItemIndicator className="absolute right-2 flex text-accent-text">
        <Check aria-hidden="true" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  );
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenu.Label>) {
  return (
    <DropdownMenu.Label
      className={cn('eyebrow px-2.5 pt-2 pb-1 text-fg-subtle', className)}
      {...props}
    />
  );
}

export function MenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator className={cn('-mx-1 my-1 h-px bg-line', className)} {...props} />;
}

export function MenuSubTrigger({
  icon,
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenu.SubTrigger> & { icon?: ReactNode }) {
  return (
    <DropdownMenu.SubTrigger
      className={cn(ITEM, 'data-[state=open]:bg-surface-3', className)}
      {...props}
    >
      {icon && <span className="flex text-fg-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight className="text-fg-subtle" aria-hidden="true" />
    </DropdownMenu.SubTrigger>
  );
}

export function MenuSubContent({
  className,
  ...props
}: ComponentProps<typeof DropdownMenu.SubContent>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent
        sideOffset={6}
        collisionPadding={8}
        className={cn(SURFACE, className)}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}
