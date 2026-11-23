import type { ProviderRef } from '@parlante/shared';
import { Cpu, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ProviderBadge } from '@/components/ProviderBadge';
import { Notice } from './Notice';

export interface ModeNoticeProps {
  /** Provider that will do (or did) the work; nothing is shown until it is known. */
  provider: ProviderRef | null | undefined;
  /** What the local basic mode means for this tool. */
  basic: ReactNode;
  /** What the external provider means for this tool (quality, cost). */
  premium: ReactNode;
  className?: string;
}

/**
 * Honesty rule (master prompt §2): says which provider answers and, when it is the local
 * heuristic, calls it "modo básico" in words — never only with a colour.
 */
export function ModeNotice({ provider, basic, premium, className }: ModeNoticeProps) {
  const { t } = useTranslation('script-writer');
  if (!provider) return null;
  const isBasic = provider.quality === 'basic';
  return (
    <Notice
      tone={isBasic ? 'neutral' : 'saffron'}
      icon={isBasic ? <Cpu /> : <Sparkles />}
      title={isBasic ? t('kit.mode.basicTitle') : t('kit.mode.premiumTitle')}
      action={<ProviderBadge provider={provider} size="sm" />}
      className={className}
    >
      {isBasic ? basic : premium}
    </Notice>
  );
}
