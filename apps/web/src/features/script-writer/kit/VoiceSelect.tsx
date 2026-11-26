import type { LanguageCode, Voice } from '@parlante/shared';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderName } from '@/components/ProviderBadge';
import { Button, Select } from '@/ui';
import type { SelectGroup, SelectOption } from '@/ui';
import { usableVoices, useVoices } from './catalog';

/** Value of the "let the server choose" entry (Radix items cannot have an empty value). */
export const AUTO_VOICE = 'auto';

export interface VoiceSelectProps {
  /** Language the voice must speak. */
  language: LanguageCode;
  /** A voice id, `AUTO_VOICE`, or undefined while nothing is chosen. */
  value: string | undefined;
  onValueChange: (voiceId: string, voice: Voice | null) => void;
  label?: ReactNode;
  hint?: ReactNode;
  'aria-label'?: string;
  /** Adds a first entry that leaves the choice to the server (its text is this prop). */
  autoLabel?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
}

/**
 * Dropdown with the voices that speak a language, grouped into stock and cloned. Every entry
 * says which provider synthesises it and whether that provider is the local basic mode.
 */
export function VoiceSelect({
  language,
  value,
  onValueChange,
  label,
  hint,
  'aria-label': ariaLabel,
  autoLabel,
  size = 'md',
  disabled = false,
  className,
}: VoiceSelectProps) {
  const { t } = useTranslation('script-writer');
  const voices = useVoices(language);
  const ready = useMemo(() => usableVoices(voices.data?.items ?? []), [voices.data]);

  const providerName = useProviderName();
  const options = useMemo(() => {
    const toOption = (voice: Voice): SelectOption => ({
      value: voice.id,
      label: voice.name,
      textValue: voice.name,
      description: [
        t(`kit.voice.gender.${voice.gender}`),
        providerName(voice.provider),
        voice.provider.quality === 'basic' ? t('kit.voice.basic') : null,
        voice.multilingual ? t('kit.voice.multilingual') : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });
    const groups: SelectGroup[] = [];
    if (autoLabel) {
      groups.push({
        label: t('kit.voice.groups.auto'),
        options: [{ value: AUTO_VOICE, label: autoLabel }],
      });
    }
    const cloned = ready.filter((voice) => voice.kind === 'cloned');
    const stock = ready.filter((voice) => voice.kind === 'stock');
    if (cloned.length > 0) {
      groups.push({ label: t('kit.voice.groups.cloned'), options: cloned.map(toOption) });
    }
    if (stock.length > 0) {
      groups.push({ label: t('kit.voice.groups.stock'), options: stock.map(toOption) });
    }
    return groups;
  }, [ready, autoLabel, t, providerName]);

  const error = voices.isError ? (
    <>
      {t('kit.voice.error')}{' '}
      <Button variant="link" onClick={() => void voices.refetch()}>
        {t('kit.voice.retry')}
      </Button>
    </>
  ) : undefined;
  const empty = !voices.isPending && !voices.isError && ready.length === 0 && !autoLabel;

  return (
    <Select
      value={value}
      onValueChange={(next) =>
        onValueChange(next, ready.find((voice) => voice.id === next) ?? null)
      }
      options={options}
      label={label}
      aria-label={ariaLabel}
      hint={empty ? t('kit.voice.empty') : hint}
      error={error}
      size={size}
      placeholder={voices.isPending ? t('kit.voice.loading') : t('kit.voice.placeholder')}
      disabled={disabled || (voices.isPending && !autoLabel) || empty}
      className={className}
    />
  );
}
