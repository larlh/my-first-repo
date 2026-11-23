import type { PublicShare } from '@parlante/shared';
import { useQuery } from '@tanstack/react-query';
import { Bot, Download, Link2Off } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { ProviderBadge } from '@/components/ProviderBadge';
import { VideoPlayer } from '@/components/VideoPlayer';
import { toAppUrl } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { currentLocale } from '@/lib/i18n';
import { useSessionState } from '@/lib/session';
import { PATHS, PublicPreferences } from '@/shell';
import { Badge, Button, ErrorState, Skeleton, VoiceBars, cn } from '@/ui';
import { loadShare } from './loadShare';
import { applyShareMeta, buildShareMeta, canonicalPageUrl } from './meta';
import { listProvenance } from './provenance';

/** Width of the player per shape: vertical videos must fit a phone screen without scrolling. */
const STAGE_WIDTH = {
  '16:9': 'max-w-5xl',
  '1:1': 'max-w-[min(42rem,72dvh)]',
  '9:16': 'max-w-[min(24rem,42dvh)]',
} as const;

function Frame({ children }: { children: ReactNode }) {
  const { t } = useTranslation('share');
  const { t: tShell } = useTranslation('shell');
  const session = useSessionState();
  const signedIn = session.status === 'authenticated';
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="bg-sidebar text-sidebar-fg [--ring:var(--saffron)]">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-8">
          <Link to={PATHS.home} aria-label={tShell('nav.home')} className="rounded-sm">
            <Logo size="md" />
          </Link>
          <PublicPreferences className="flex items-center gap-1 [&_button]:text-sidebar-fg [&_button:hover]:bg-sidebar-2" />
        </div>
      </header>

      <main className="flex flex-1 flex-col">{children}</main>

      <footer className="border-t border-line bg-bg-sunken">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-4 px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex min-w-0 items-center gap-3.5">
            <VoiceBars active={false} label={null} />
            <p className="min-w-0 text-sm text-fg-muted">
              <span className="block font-semibold text-fg">{t('footer.made')}</span>
              {t('footer.pitch')}
            </p>
          </div>
          <Button asChild variant="solid">
            <Link to={signedIn ? PATHS.home : PATHS.register}>
              {signedIn ? t('footer.toApp') : t('footer.cta')}
            </Link>
          </Button>
        </div>
      </footer>
    </div>
  );
}

function Stage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="relative bg-sidebar text-sidebar-fg">
      <div
        className="booth-grid pointer-events-none absolute inset-0 opacity-40"
        aria-hidden="true"
      />
      <div
        className={cn(
          'relative mx-auto w-full px-0 pb-0 sm:px-8 sm:pt-2 sm:pb-8',
          className ?? 'max-w-5xl',
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Public page of a shared video (`/s/:token`): no session needed. Player, title, who shared
 * it, how it was made, and the way into Parlante. Every state is explained: loading, a link
 * that was turned off or expired, and a server that cannot be reached.
 */
export default function SharePage() {
  const { t } = useTranslation('share');
  const { token = '' } = useParams();
  const format = useFormat();
  const locale = currentLocale();

  // Each successful read counts as a view on the server: read once per visit (see loadShare),
  // never in the background.
  const query = useQuery<PublicShare, ApiError>({
    queryKey: ['share', 'public', token],
    queryFn: () => loadShare(token),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
  });
  const share = query.data;

  const description = share ? t('meta.description', { workspace: share.workspaceName }) : '';
  const meta = useMemo(
    () =>
      share
        ? buildShareMeta({
            share,
            pageUrl: canonicalPageUrl(window.location),
            description,
            locale,
          })
        : null,
    [share, description, locale],
  );
  useEffect(() => (meta ? applyShareMeta(document, meta) : undefined), [meta]);

  const subtitles = useMemo(
    () => (share?.vttUrl ? [{ lang: 'und', label: t('captions'), src: share.vttUrl }] : undefined),
    [share?.vttUrl, t],
  );

  if (query.isPending || (!share && !query.isError)) {
    return (
      <Frame>
        <Stage>
          <div className="flex aspect-video items-center justify-center bg-media sm:rounded-lg">
            <VoiceBars label={t('loading')} />
          </div>
        </Stage>
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8" aria-hidden="true">
          <Skeleton className="h-9 w-2/3 max-w-md" />
          <Skeleton className="mt-3 h-4 w-1/2 max-w-xs" />
        </div>
      </Frame>
    );
  }

  if (!share) {
    const gone = query.error?.is('NOT_FOUND', 'VALIDATION_ERROR', 'FORBIDDEN') ?? false;
    return (
      <Frame>
        <div className="flex flex-1 items-center justify-center px-4 py-10">
          {gone ? (
            <div className="flex max-w-md flex-col items-center text-center">
              <span
                aria-hidden="true"
                className="booth-grid mb-5 flex size-20 items-center justify-center rounded-2xl border border-line bg-surface-2 text-fg-muted"
              >
                <Link2Off className="size-8" />
              </span>
              <h1 className="display text-3xl sm:text-4xl">{t('gone.title')}</h1>
              <p className="mt-3 text-base text-fg-muted">{t('gone.text')}</p>
              <Button asChild variant="primary" className="mt-7">
                <Link to={PATHS.home}>{t('gone.action')}</Link>
              </Button>
            </div>
          ) : (
            <ErrorState
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isRefetching}
            />
          )}
        </div>
      </Frame>
    );
  }

  const provenance = listProvenance(share.providers);
  const facts = [
    t('sharedBy', { workspace: share.workspaceName }),
    format.date(share.createdAt),
    share.durationMs
      ? format.duration(Math.max(1000, Math.round(share.durationMs / 1000) * 1000))
      : null,
  ].filter((fact): fact is string => fact !== null);

  return (
    <Frame>
      <Stage className={STAGE_WIDTH[share.aspect]}>
        <VideoPlayer
          src={share.videoUrl}
          title={share.title}
          poster={share.thumbnailUrl}
          aspect={share.aspect}
          subtitles={subtitles}
          downloadUrl={share.downloadUrl}
          className="rounded-none shadow-lg sm:rounded-lg"
        />
      </Stage>

      <article className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-8 sm:py-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="display text-3xl break-words sm:text-4xl">{share.title}</h1>
            <p className="mt-2.5 flex flex-wrap gap-x-2 gap-y-0.5 text-sm text-fg-muted">
              {facts.map((fact, index) => (
                <span key={fact} className="inline-flex items-center gap-2">
                  {index > 0 && <span aria-hidden="true">·</span>}
                  {fact}
                </span>
              ))}
            </p>
          </div>
          {share.downloadUrl && (
            <Button asChild className="shrink-0" leftIcon={<Download aria-hidden="true" />}>
              <a href={toAppUrl(share.downloadUrl)} download>
                {t('download')}
              </a>
            </Button>
          )}
        </div>

        {(share.aiGenerated || provenance.length > 0) && (
          <section
            aria-label={t('made.title')}
            className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 sm:flex-row sm:items-center sm:gap-5"
          >
            <h2 className="eyebrow shrink-0 text-fg-subtle">{t('made.title')}</h2>
            <ul className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2.5">
              {share.aiGenerated && (
                <li>
                  <Badge tone="saffron" icon={<Bot aria-hidden="true" />}>
                    {t('made.aiGenerated')}
                  </Badge>
                </li>
              )}
              {provenance.map(({ capability, provider }) => (
                <li key={capability} className="flex items-center gap-2 text-sm">
                  <span className="text-fg-muted">{t(`made.capability.${capability}`)}</span>
                  <ProviderBadge provider={provider} size="sm" />
                </li>
              ))}
            </ul>
          </section>
        )}
        {share.aiGenerated && <p className="text-sm text-fg-muted">{t('made.aiGeneratedNote')}</p>}
      </article>
    </Frame>
  );
}
