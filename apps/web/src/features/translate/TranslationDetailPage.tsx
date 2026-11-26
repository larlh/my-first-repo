import type { TranslationJob } from '@parlante/shared';
import { ArrowRight, Trash2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { JobStatus } from '@/components/JobStatus';
import { ProviderBadge } from '@/components/ProviderBadge';
import { VideoPlayer } from '@/components/VideoPlayer';
import { api, toAppUrl, useApiMutation, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useJobPolling } from '@/lib/jobs';
import { useSession } from '@/lib/session';
import { Button, ErrorState, PageHeader, Skeleton, toast, useConfirm, useErrorText } from '@/ui';
import {
  Notice,
  TOOL_ROUTES,
  languageShortName,
  useStoredErrorText,
  useUiLocale,
} from '@/features/script-writer/kit';
import { OutputCard } from './components/OutputCard';
import { countByStatus, isActive, languageResults } from './lib/translate';

const PROVIDER_STEPS = ['stt', 'translation', 'tts'] as const;

function VoiceName({ voiceId }: { voiceId: string }) {
  const voice = useApiQuery(api.voices.get, { params: { voiceId } }, { staleTime: 300_000 });
  return <>{voice.data?.name ?? '…'}</>;
}

/**
 * A translation job (master prompt §3.12): overall progress with its stage, one card per
 * target language (state, player with subtitles, downloads) and who did each step.
 */
export default function TranslationDetailPage() {
  const { t } = useTranslation('translate');
  const { translationId = '' } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const format = useFormat();
  const locale = useUiLocale();
  const confirm = useConfirm();
  const describe = useErrorText();
  const describeStored = useStoredErrorText();

  const polled = useJobPolling(
    api.translations.get,
    { params: { translationId } },
    {
      enabled: translationId !== '',
      intervalMs: 2000,
      select: (data) => ({ status: data.status, progress: data.progress }),
      onSettled: (data, phase) => {
        // Credits are settled to the real cost (or refunded) when the job ends.
        void session.refresh();
        if (phase === 'completed') toast.success(t('detail.done', { name: data.name }));
        else if (phase === 'partial') toast.warning(t('detail.partial', { name: data.name }));
        else if (phase === 'failed') toast.error(t('detail.failed', { name: data.name }));
      },
    },
  );
  const job: TranslationJob | undefined = polled.data;

  const remove = useApiMutation(api.translations.remove, {
    invalidates: [api.translations.list],
    onSuccess: () => {
      void session.refresh();
      toast.success(t('detail.deleted'));
      void navigate(TOOL_ROUTES.translate);
    },
    onError: (error) =>
      toast.error(t('detail.deleteFailed'), { description: describe(error).title }),
  });

  if (polled.isLoading || (!job && !polled.error)) {
    return (
      <>
        <PageHeader
          back={{ to: TOOL_ROUTES.translate, label: t('list.title') }}
          title={<Skeleton className="h-9 w-64" />}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </>
    );
  }
  if (!job) {
    return (
      <>
        <PageHeader
          back={{ to: TOOL_ROUTES.translate, label: t('list.title') }}
          title={t('detail.missing')}
        />
        <ErrorState error={polled.error} onRetry={polled.refetch} />
      </>
    );
  }

  const results = languageResults(job);
  const counts = countByStatus(results);
  const active = isActive(job);
  const jobError = job.error ? describeStored(job.error) : null;
  const translationBasic = job.providers?.translation?.quality === 'basic';

  const askDelete = async () => {
    const ok = await confirm({
      title: t('detail.deleteTitle'),
      description: active ? t('detail.deleteActive') : t('detail.deleteText'),
      confirmLabel: t('detail.delete'),
      tone: 'danger',
    });
    if (ok) remove.mutate({ params: { translationId: job.id } });
  };

  return (
    <>
      <PageHeader
        back={{ to: TOOL_ROUTES.translate, label: t('list.title') }}
        eyebrow={t('detail.eyebrow')}
        title={job.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-2">
            {languageShortName(job.sourceLanguage, locale)}
            <ArrowRight aria-hidden="true" className="size-4" />
            <span className="sr-only">{t('detail.to')}</span>
            {job.targetLanguages.map((code) => languageShortName(code, locale)).join(', ')}
          </span>
        }
        actions={
          session.can('editor') ? (
            <Button
              variant="secondary"
              leftIcon={<Trash2 aria-hidden="true" />}
              loading={remove.isPending}
              onClick={() => void askDelete()}
            >
              {active ? t('detail.cancel') : t('detail.delete')}
            </Button>
          ) : undefined
        }
      />

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-5">
          <section
            aria-label={t('detail.progress')}
            className="rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5"
          >
            <JobStatus
              label={t('detail.progressLabel', { name: job.name })}
              status={polled.phase}
              progress={polled.progress}
              etaSec={polled.etaSec}
              etaEstimated={polled.etaEstimated}
              stage={job.stage ? t(`stage.${job.stage}`) : undefined}
              error={
                jobError ? [jobError.title, jobError.detail].filter(Boolean).join('. ') : undefined
              }
            />
            <p className="nums mt-3 text-sm text-fg-muted">
              {t('detail.counts', {
                done: counts.completed,
                count: results.length,
              })}
              {counts.failed > 0 && <> · {t('detail.failedCount', { count: counts.failed })}</>}
            </p>
          </section>

          {job.status === 'partial' && (
            <Notice tone="warning" icon={<TriangleAlert />}>
              {t('detail.partialText')}
            </Notice>
          )}

          <section aria-labelledby="translate-outputs" className="min-w-0">
            <h2 id="translate-outputs" className="mb-3 text-lg">
              {t('detail.outputs')}
            </h2>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              {results.map((result) => (
                <OutputCard key={result.language} result={result} jobName={job.name} />
              ))}
            </div>
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-5">
          <section className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
            <h2 className="eyebrow px-4 pt-4 text-fg-subtle">{t('detail.source')}</h2>
            {job.sourceUrl ? (
              <VideoPlayer
                src={toAppUrl(job.sourceUrl)}
                title={t('detail.sourceTitle', { name: job.name })}
                className="mt-3 rounded-none"
              />
            ) : (
              <p className="px-4 py-3 text-sm text-fg-muted">{t('detail.sourceGone')}</p>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 py-4 text-sm">
              <dt className="text-fg-muted">{t('detail.facts.language')}</dt>
              <dd className="text-right font-medium">
                {languageShortName(job.sourceLanguage, locale)}
              </dd>
              <dt className="text-fg-muted">{t('detail.facts.duration')}</dt>
              <dd className="nums text-right font-medium">
                {job.sourceDurationMs ? format.duration(job.sourceDurationMs) : '—'}
              </dd>
              <dt className="text-fg-muted">{t('detail.facts.transcript')}</dt>
              <dd className="text-right font-medium">
                {t(`detail.transcriptSource.${job.transcriptSource}`)}
              </dd>
              <dt className="text-fg-muted">{t('detail.facts.original')}</dt>
              <dd className="nums text-right font-medium">
                {job.options.originalAudioVolume === 0
                  ? t('detail.originalOff')
                  : format.percent(job.options.originalAudioVolume * 100)}
              </dd>
              <dt className="text-fg-muted">{t('detail.facts.subtitles')}</dt>
              <dd className="text-right font-medium">
                {job.options.burnSubtitles ? t('detail.burned') : t('detail.sidecar')}
              </dd>
              <dt className="text-fg-muted">{t('detail.facts.credits')}</dt>
              <dd className="nums text-right font-medium">{format.number(job.creditsCharged)}</dd>
              <dt className="text-fg-muted">{t('detail.facts.created')}</dt>
              <dd className="text-right font-medium">{format.dateTime(job.createdAt)}</dd>
            </dl>
          </section>

          <section className="min-w-0 rounded-xl border border-line bg-surface p-4 shadow-xs">
            <h2 className="eyebrow text-fg-subtle">{t('detail.providers')}</h2>
            {job.providers ? (
              <ul className="mt-3 flex min-w-0 flex-col gap-3 text-sm">
                {PROVIDER_STEPS.map((step) => {
                  const provider = job.providers?.[step];
                  return provider ? (
                    // Stacked: provider names are long and this column is narrow.
                    <li key={step} className="flex min-w-0 flex-col items-start gap-1">
                      <span className="text-fg-muted">{t(`providers.${step}`)}</span>
                      <ProviderBadge provider={provider} size="sm" className="max-w-full" />
                    </li>
                  ) : null;
                })}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-fg-muted">
                {job.status === 'queued' || job.status === 'processing'
                  ? t('detail.providersPending')
                  : t('detail.providersNone')}
              </p>
            )}
            {translationBasic && (
              <p className="mt-3 text-sm text-pretty text-warning-text">{t('new.basic.text')}</p>
            )}
          </section>

          <section className="min-w-0 rounded-xl border border-line bg-surface p-4 shadow-xs">
            <h2 className="eyebrow text-fg-subtle">{t('detail.voices')}</h2>
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              {results.map((result) => (
                <li key={result.language} className="flex min-w-0 justify-between gap-3">
                  <span className="text-fg-muted">
                    {languageShortName(result.language, locale)}
                  </span>
                  <span className="min-w-0 truncate font-medium">
                    {result.output ? <VoiceName voiceId={result.output.voiceId} /> : '—'}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <Button asChild variant="secondary">
            <Link to={TOOL_ROUTES.translateNew}>{t('list.create')}</Link>
          </Button>
        </aside>
      </div>
    </>
  );
}
