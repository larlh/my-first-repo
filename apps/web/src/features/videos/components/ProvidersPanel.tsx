import type { Capability, Video } from '@parlante/shared';
import { Bot, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProviderBadge } from '@/components/ProviderBadge';
import { api, useApiQuery } from '@/lib/api';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@/ui';
import { hasBasicProvider, listProvenance } from '../lib/video';
import type { ProvenanceEntry } from '../lib/video';

/** Capabilities that shape what a viewer hears and sees in a render. */
const RENDER_CAPABILITIES: readonly Capability[] = ['tts', 'lipsync'];

function ProvenanceList({ entries }: { entries: readonly ProvenanceEntry[] }) {
  const { t } = useTranslation('videos');
  return (
    <ul className="flex flex-col">
      {entries.map(({ capability, provider }) => (
        <li
          key={capability}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-line py-2.5 first:pt-0 last:border-b-0 last:pb-0"
        >
          <span className="text-sm font-medium">{t(`providers.capability.${capability}`)}</span>
          <ProviderBadge provider={provider} size="sm" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Honesty rule (master prompt §2): which provider produced each part of the output, and a
 * plain notice when part of it is the local "modo básico". Before the first render it shows
 * what this server WOULD use, labelled as such.
 */
export function ProvidersPanel({ video }: { video: Video }) {
  const { t } = useTranslation('videos');
  // Where the file is stored says nothing about how the content was generated: left out.
  const produced = listProvenance(video.providers).filter(
    (entry) => entry.capability !== 'storage',
  );
  const rendered = produced.length > 0;

  const capabilities = useApiQuery(api.system.capabilities, undefined, {
    enabled: !rendered,
    staleTime: 60_000,
  });
  const planned: ProvenanceEntry[] = capabilities.data
    ? RENDER_CAPABILITIES.flatMap((capability) => {
        const provider = capabilities.data.active[capability];
        return provider ? [{ capability, provider }] : [];
      })
    : [];

  const entries = rendered ? produced : planned;
  const basic = hasBasicProvider(entries);

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{t('providers.title')}</CardTitle>
          <CardDescription>
            {rendered ? t('providers.description') : t('providers.descriptionPlanned')}
          </CardDescription>
        </div>
        {video.usesPhotorealAvatars && (
          <Badge tone="saffron" icon={<Bot aria-hidden="true" />}>
            {t('providers.aiGenerated')}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3.5">
        {!rendered && capabilities.isPending ? (
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('providers.unknown')}</p>
        ) : (
          <ProvenanceList entries={entries} />
        )}
        {basic && (
          <p className="flex items-start gap-2.5 rounded-md bg-bg-sunken p-3 text-sm text-fg-muted">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {rendered ? t('providers.basicNote') : t('providers.basicNotePlanned')}
          </p>
        )}
        {video.usesPhotorealAvatars && (
          <p className="text-sm text-fg-muted">{t('providers.aiGeneratedNote')}</p>
        )}
      </CardContent>
    </Card>
  );
}
