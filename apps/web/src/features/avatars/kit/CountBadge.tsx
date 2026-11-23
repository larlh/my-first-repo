/** Counter shown after a tab label ("Todos 21"). */
export function CountBadge({ value }: { value: number }) {
  return (
    <span className="nums rounded-full bg-surface-3 px-1.5 py-px text-xs font-medium text-fg-muted">
      {value}
    </span>
  );
}
