import type { ProviderRef } from '@parlante/shared';
import { Cpu, Sparkles } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/ui/Badge';
import { Tooltip } from '@/ui/Tooltip';

/**
 * Provider names come from the server, where the local implementations are named in Spanish
 * ("Heurística local") and a few in English ("Local disk"). The names this installation ships
 * with are shown in the language of the interface; brand names (eSpeak NG, ElevenLabs, Anthropic
 * Claude…) and anything unknown are shown as the server sends them.
 */
const PROVIDER_NAME_KEYS: Readonly<Record<string, string>> = {
  'Heurística local': 'localHeuristic',
  'Lista de bloqueo (local)': 'localBlocklist',
  'Local disk': 'localDisk',
  'Motor neuronal local': 'localNeuralEngine',
  'Perfil de voz (local)': 'localVoiceProfile',
  'Traducción básica por glosario (local)': 'localGlossary',
  'Transcripción aportada por el usuario': 'userTranscript',
  'External lip-sync': 'externalLipsync',
  'Avatar 2D': 'avatar2d',
};

/** `(provider) => name in the UI language`. Use it wherever a provider is named in a sentence. */
export function useProviderName(): (provider: Pick<ProviderRef, 'name'>) => string {
  const { t } = useTranslation('shell');
  return useCallback(
    (provider) => {
      const key = PROVIDER_NAME_KEYS[provider.name];
      return key ? t(`provider.names.${key}`) : provider.name;
    },
    [t],
  );
}

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
  const name = useProviderName()(provider);
  const basic = provider.quality === 'basic';
  const tier = basic ? t('provider.basic') : t('provider.premium');
  return (
    <Tooltip
      content={basic ? t('provider.basicHint', { name }) : t('provider.premiumHint', { name })}
    >
      <Badge
        tabIndex={0}
        tone={basic ? 'neutral' : 'saffron'}
        variant={basic ? 'outline' : 'soft'}
        size={size}
        icon={basic ? <Cpu aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
        className={className}
      >
        {tierOnly ? tier : `${tier} · ${name}`}
      </Badge>
    </Tooltip>
  );
}
