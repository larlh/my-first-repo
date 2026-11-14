import type { ProviderRef } from '@parlante/shared';
import { Cpu, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/ui/Badge';
import { Tooltip } from '@/ui/Tooltip';

export interface ProviderBadgeProps {
  provider: ProviderRef;
  /** Hide the provider name and show only the quality tier. */
  tierOnly?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Honesty rule (master prompt §2): every AI result says which provider produced it and never
 * dresses the local "modo básico" as the high-quality one. Use this next to any generated
 * output (voice preview, script, translation, render…).
 */
export function ProviderBadge({
  provider,
  tierOnly = false,
  size = 'md',
  className,
}: ProviderBadgeProps) {
  const { t } = useTranslation('shell');
  const basic = provider.quality === 'basic';
  const tier = basic ? t('provider.basic') : t('provider.premium');
  return (
    <Tooltip
      content={
        basic
          ? t('provider.basicHint', { name: provider.name })
          : t('provider.premiumHint', { name: provider.name })
      }
    >
      <Badge
        tabIndex={0}
        tone={basic ? 'neutral' : 'saffron'}
        variant={basic ? 'outline' : 'soft'}
        size={size}
        icon={basic ? <Cpu aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
        className={className}
      >
        {tierOnly ? tier : `${tier} · ${provider.name}`}
      </Badge>
    </Tooltip>
  );
}
