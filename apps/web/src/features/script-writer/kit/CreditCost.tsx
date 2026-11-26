import { Coins } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cn } from '@/ui';
import { TOOL_ROUTES, useAvailableRoutes } from './routes';

export interface CreditCostProps {
  /** Credits the action will cost (0 = free). null while it cannot be known yet. */
  cost: number | null;
  /** Shown instead of the figure while `cost` is null ("elige un vídeo para calcularlo"). */
  pending?: ReactNode;
  /** Extra line under the figures (how the cost is computed). */
  detail?: ReactNode;
  /** The figure is an estimate (the server settles the real cost). */
  estimated?: boolean;
  className?: string;
}

/** True when the workspace balance covers `cost`. */
export function canAfford(cost: number | null, credits: number): boolean {
  return cost === null || cost <= credits;
}

/** Cost of an action next to the workspace balance, with the shortfall spelt out. */
export function CreditCost({
  cost,
  pending,
  detail,
  estimated = false,
  className,
}: CreditCostProps) {
  const { t } = useTranslation('script-writer');
  const format = useFormat();
  const session = useSession();
  const available = useAvailableRoutes();
  const short = cost !== null && cost > session.credits;
  return (
    <div
      className={cn(
        'flex min-w-0 gap-3 rounded-lg border px-4 py-3 text-sm',
        short
          ? 'border-transparent bg-danger-soft text-danger-text'
          : 'border-transparent bg-saffron-soft text-saffron-text',
        className,
      )}
      role={short ? 'alert' : undefined}
    >
      <Coins aria-hidden="true" className="mt-0.5 size-[1.125rem] shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">
          {cost === null
            ? pending
            : cost === 0
              ? t('kit.credits.free')
              : t(estimated ? 'kit.credits.estimate' : 'kit.credits.cost', {
                  count: cost,
                  formatted: format.number(cost),
                })}
        </p>
        <p className="nums">
          {short
            ? t('kit.credits.short', {
                count: cost - session.credits,
                balance: format.number(session.credits),
              })
            : t('kit.credits.balance', {
                count: session.credits,
                formatted: format.number(session.credits),
              })}
          {short && available.billing && (
            <>
              {' '}
              <Link to={TOOL_ROUTES.billing} className="font-semibold underline underline-offset-4">
                {t('kit.credits.buy')}
              </Link>
            </>
          )}
        </p>
        {detail && <p className="mt-1 text-pretty opacity-90">{detail}</p>}
      </div>
    </div>
  );
}
