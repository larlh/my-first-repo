import { Coins } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cn } from '@/ui';
import { LIB_ROUTES, useAvailableRoutes } from './routes';

export interface CostLineProps {
  /** Credits the operation costs (charged when it is queued, refunded if it fails). */
  cost: number;
  /** Plan allowance already in words ("Avatares propios: 1 de 10 (plan Creator)"). */
  allowanceText?: string | null;
  /** The plan allowance is used up. */
  allowanceFull?: boolean;
  className?: string;
}

/** What an operation costs, what is left, and how much of the plan allowance is used. */
export function CostLine({ cost, allowanceText, allowanceFull = false, className }: CostLineProps) {
  const { t } = useTranslation('avatars');
  const format = useFormat();
  const session = useSession();
  const available = useAvailableRoutes();
  const short = session.credits < cost;
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 text-sm',
        className,
      )}
    >
      <p className="flex items-center gap-2">
        <Coins aria-hidden="true" className="size-4 shrink-0 text-saffron-text" />
        <span>
          <span className="nums font-semibold">{t('kit.cost.credits', { count: cost })}</span>
          <span className={cn('nums ml-1.5', short ? 'text-danger-text' : 'text-fg-muted')}>
            {t('kit.cost.balance', { credits: format.number(session.credits) })}
          </span>
        </span>
      </p>
      {allowanceText && (
        <p className={cn('nums', allowanceFull ? 'text-danger-text' : 'text-fg-muted')}>
          {allowanceText}
        </p>
      )}
      <p className="basis-full text-xs text-fg-muted">
        {t('kit.cost.refund')}{' '}
        {(short || allowanceFull) && available.billing && (
          <Link to={LIB_ROUTES.billing} className="font-semibold text-fg underline">
            {t('kit.cost.billing')}
          </Link>
        )}
      </p>
    </div>
  );
}
