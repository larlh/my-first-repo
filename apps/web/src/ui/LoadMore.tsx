import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { Button } from './Button';

export interface LoadMoreProps {
  /** There is another page (`nextCursor !== null`). */
  hasMore: boolean | undefined;
  loading: boolean;
  onLoadMore: () => void;
  /** Also load automatically when the button scrolls into view. */
  auto?: boolean;
  label?: ReactNode;
  /** Shown instead of the button when everything is loaded (optional). */
  endLabel?: ReactNode;
  className?: string;
}

/**
 * Cursor pagination control ("cargar más"). Pair with `useApiInfiniteQuery`:
 *   <LoadMore hasMore={q.hasNextPage} loading={q.isFetchingNextPage} onLoadMore={() => void q.fetchNextPage()} />
 */
export function LoadMore({
  hasMore,
  loading,
  onLoadMore,
  auto = false,
  label,
  endLabel,
  className,
}: LoadMoreProps) {
  const { t } = useTranslation('shell');
  const sentinel = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onLoadMore);
  callback.current = onLoadMore;

  useEffect(() => {
    const node = sentinel.current;
    if (!auto || !hasMore || loading || !node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current();
      },
      { rootMargin: '240px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [auto, hasMore, loading]);

  if (!hasMore) {
    return endLabel ? (
      <p className={cn('py-4 text-center text-sm text-fg-subtle', className)}>{endLabel}</p>
    ) : null;
  }
  return (
    <div ref={sentinel} className={cn('flex justify-center py-4', className)}>
      <Button onClick={onLoadMore} loading={loading}>
        {label ?? t('ui.loadMore')}
      </Button>
    </div>
  );
}
