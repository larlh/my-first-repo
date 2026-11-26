import { useTranslation } from 'react-i18next';
import { cn } from '@/ui';
import { STATUS_FILTERS } from '../lib/filters';
import type { StatusFilter as StatusFilterValue } from '../lib/filters';

const DOT: Record<StatusFilterValue, string | null> = {
  all: null,
  draft: 'bg-fg-subtle',
  queued: 'bg-saffron',
  rendering: 'bg-accent',
  completed: 'bg-success',
  failed: 'bg-danger',
};

/** Status filter of the list: a row of toggle pills that scrolls sideways on phones. */
export function StatusFilter({
  value,
  onChange,
}: {
  value: StatusFilterValue;
  onChange: (value: StatusFilterValue) => void;
}) {
  const { t } = useTranslation('videos');
  return (
    <div
      role="group"
      aria-label={t('filters.status')}
      className="-mx-4 flex min-w-0 gap-1.5 overflow-x-auto px-4 py-1 sm:mx-0 sm:flex-wrap sm:px-0"
    >
      {STATUS_FILTERS.map((status) => {
        const selected = status === value;
        const dot = DOT[status];
        return (
          <button
            key={status}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(status)}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-semibold whitespace-nowrap transition-colors duration-150',
              selected
                ? 'border-inverse bg-inverse text-inverse-fg'
                : 'border-line-strong bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            {dot && <span aria-hidden="true" className={cn('size-1.5 rounded-full', dot)} />}
            {t(`filters.${status}`)}
          </button>
        );
      })}
    </div>
  );
}
