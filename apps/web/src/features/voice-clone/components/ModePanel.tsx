import type { ProviderRef } from '@parlante/shared';
import { Check, Cloud, Cpu, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProviderBadge, providerTier, useProviderName } from '@/components/ProviderBadge';
import { Skeleton, cn } from '@/ui';

export interface ModePanelProps {
  /** Active voice-clone provider (`Capabilities.active.voiceClone`); undefined while loading. */
  provider: ProviderRef | undefined;
  loading: boolean;
  className?: string;
}

/**
 * Honesty panel of voice cloning (master prompt §2): says which provider will do the work
 * and exactly what it does and what it does not — the local "basic mode" fits a local voice
 * to the pitch and pace of the sample (no timbre); the local neural engine reproduces the
 * timbre on this machine, in Spanish only; an external service receives the sample.
 */
export function ModePanel({ provider, loading, className }: ModePanelProps) {
  const { t } = useTranslation('voice-clone');
  const providerName = useProviderName();
  const mode = provider ? providerTier(provider) : 'basic';
  const points: { ok: boolean; key: string }[] =
    mode === 'basic'
      ? [
          { ok: true, key: 'pitch' },
          { ok: true, key: 'pace' },
          { ok: true, key: 'offline' },
          { ok: false, key: 'timbre' },
          { ok: false, key: 'accent' },
        ]
      : mode === 'neural'
        ? [
            { ok: true, key: 'timbre' },
            { ok: true, key: 'accent' },
            { ok: true, key: 'local' },
            { ok: true, key: 'watermark' },
            { ok: false, key: 'languages' },
          ]
        : [
            { ok: true, key: 'timbre' },
            { ok: true, key: 'languages' },
            { ok: false, key: 'leaves' },
          ];
  return (
    <section
      aria-label={t('mode.title')}
      className={cn('overflow-hidden rounded-xl border border-line bg-surface', className)}
    >
      <header className="flex items-center gap-3 bg-media px-4 py-3.5 text-on-media sm:px-5">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-md bg-on-media/10"
        >
          {mode === 'basic' ? (
            <Cpu className="size-5" />
          ) : mode === 'neural' ? (
            <Sparkles className="size-5" />
          ) : (
            <Cloud className="size-5" />
          )}
        </span>
        <div className="min-w-0">
          <p className="eyebrow text-on-media/60">{t('mode.title')}</p>
          <p className="display text-lg leading-tight" role="status">
            {loading ? t('mode.checking') : t(`mode.${mode}.name`)}
          </p>
        </div>
      </header>
      {loading ? (
        <div className="flex flex-col gap-3 p-4 sm:p-5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-4 text-sm sm:p-5">
          {provider && <ProviderBadge provider={provider} className="self-start" />}
          <p className="text-pretty">
            {t(`mode.${mode}.text`, { name: provider ? providerName(provider) : '' })}
          </p>
          <ul className="flex flex-col gap-2">
            {points.map((point) => (
              <li key={point.key} className="flex gap-2.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full',
                    point.ok
                      ? 'bg-success-soft text-success-text'
                      : 'bg-danger-soft text-danger-text',
                  )}
                >
                  {point.ok ? (
                    <Check className="size-3" strokeWidth={3} />
                  ) : (
                    <X className="size-3" strokeWidth={3} />
                  )}
                </span>
                <span className="min-w-0 text-pretty">
                  <span className="sr-only">{point.ok ? t('mode.does') : t('mode.doesNot')}</span>
                  {t(`mode.${mode}.points.${point.key}`)}
                </span>
              </li>
            ))}
          </ul>
          {mode === 'basic' && (
            <p className="border-t border-line pt-3 text-xs text-pretty text-fg-muted">
              {t('mode.basic.upgrade')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
