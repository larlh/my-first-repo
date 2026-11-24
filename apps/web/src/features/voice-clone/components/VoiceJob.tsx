import { VOICE_PREVIEW_TEXTS, baseLanguage, languageName } from '@parlante/shared';
import type { Voice } from '@parlante/shared';
import {
  CircleCheck,
  Clapperboard,
  Cpu,
  Play,
  Plus,
  Square,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { JobStatusBadge } from '@/components/JobStatus';
import { ProviderBadge, useProviderName } from '@/components/ProviderBadge';
import { api, useApiMutation, useInvalidateApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useJobPolling } from '@/lib/jobs';
import { useSession } from '@/lib/session';
import {
  Button,
  ErrorState,
  ProgressBar,
  Skeleton,
  VoiceBars,
  toast,
  useErrorText,
  useServerMessage,
} from '@/ui';
import { Callout, LIB_ROUTES, useSpeechPreview, useStartVideo } from '@/features/avatars/kit';

export interface VoiceJobProps {
  voiceId: string;
  /** Back to the form (clone another / try again). */
  onAnother: () => void;
}

/** `1.5` → "+1,5 st" (semitones, in the UI language). */
function semitones(value: number, format: (value: number) => string): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return '0 st';
  return `${rounded > 0 ? '+' : '−'}${format(Math.abs(rounded))} st`;
}

/**
 * Follows a voice clone until it is ready. The API reports no progress figure for this job,
 * so the bar is indeterminate and only the elapsed time is shown — no invented estimate.
 * The result says which provider did the work and, in basic mode, what was measured.
 */
export function VoiceJob({ voiceId, onAnother }: VoiceJobProps) {
  const { t, i18n } = useTranslation('voice-clone');
  const serverMessage = useServerMessage();
  const providerName = useProviderName();
  const format = useFormat();
  const session = useSession();
  const describe = useErrorText();
  const invalidate = useInvalidateApi();
  const speech = useSpeechPreview();
  const uiLocale = i18n.language.startsWith('en') ? 'en' : 'es';

  const job = useJobPolling(
    api.voices.get,
    { params: { voiceId } },
    {
      select: (voice: Voice) => ({ status: voice.status }),
      onSettled: (voice, phase) => {
        void invalidate(api.voices.list);
        void session.refresh();
        if (phase === 'completed') toast.success(t('job.readyToast', { name: voice.name }));
        else toast.error(t('job.failedToast', { name: voice.name }));
      },
    },
  );
  const startVideo = useStartVideo({
    onCreated: () => toast.success(t('job.videoCreated')),
    onError: (error) => toast.error(t('job.videoFailed'), { description: describe(error).title }),
  });
  const remove = useApiMutation(api.voiceClones.remove, {
    invalidates: [api.voices.list],
    onSuccess: onAnother,
    onError: (error) => toast.error(t('job.deleteFailed'), { description: describe(error).title }),
  });

  const voice = job.data;
  if (!voice) {
    return job.error ? (
      <ErrorState
        error={job.error}
        onRetry={job.refetch}
        action={<Button onClick={onAnother}>{t('job.back')}</Button>}
      />
    ) : (
      <Skeleton className="h-56 rounded-xl" aria-busy="true" />
    );
  }

  const language = baseLanguage(voice.language) ?? 'es';
  const sampleText = VOICE_PREVIEW_TEXTS[language] ?? (VOICE_PREVIEW_TEXTS.es as string);
  const basic = voice.provider.quality === 'basic';
  const playing = speech.status === 'playing' || speech.status === 'loading';

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow text-fg-subtle">
            {t('job.eyebrow', { language: languageName(voice.language, uiLocale) })}
          </p>
          <h2 className="text-3xl break-words">{voice.name}</h2>
        </div>
        <JobStatusBadge status={voice.status} />
      </div>

      {voice.status === 'processing' && (
        <>
          <div className="flex items-center gap-3 rounded-xl bg-media px-5 py-5 text-on-media">
            <VoiceBars size="md" label={null} className="text-saffron" />
            <div className="min-w-0 flex-1">
              <p className="display text-xl">{t('job.working')}</p>
              <p className="nums font-mono text-sm text-on-media/70">
                {t('job.elapsed', { time: format.clock(job.elapsedSec * 1000) })}
              </p>
            </div>
          </div>
          <ProgressBar label={t('job.progressLabel', { name: voice.name })} value={null} />
          <p className="text-sm text-pretty text-fg-muted">
            {basic
              ? t('job.explain.basic')
              : t('job.explain.premium', { name: providerName(voice.provider) })}{' '}
            {t('job.noEta')}
          </p>
          <Callout tone="neutral">{t('job.leave')}</Callout>
        </>
      )}

      {voice.status === 'ready' && (
        <>
          <Callout tone="success" role="status" icon={<CircleCheck />} title={t('job.readyTitle')}>
            {t('job.readyText')}
          </Callout>

          <div className="rounded-xl border border-line bg-surface-2 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="solid"
                leftIcon={playing ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
                loading={speech.status === 'loading'}
                onClick={() =>
                  playing
                    ? speech.stop()
                    : void speech.play(voice.id, { text: sampleText, voiceId: voice.id, language })
                }
              >
                {playing ? t('job.stop') : t('job.listen')}
              </Button>
              {speech.status === 'playing' && <VoiceBars size="sm" label={null} />}
              <span className="ml-auto">
                <ProviderBadge provider={speech.result?.provider ?? voice.provider} size="sm" />
              </span>
            </div>
            <p lang={language} className="mt-3 text-sm text-pretty text-fg-muted">
              «{sampleText}»
            </p>
            {speech.status === 'error' && speech.error && (
              <p role="alert" className="mt-2 text-sm text-danger-text">
                {describe(speech.error).title}
              </p>
            )}
          </div>

          {basic && (
            <Callout tone="saffron" icon={<Cpu />} title={t('job.basicTitle')}>
              {t('job.basicText')}
            </Callout>
          )}

          {voice.profile && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-fg-muted">{t('job.profile.f0')}</dt>
                <dd className="nums font-mono">
                  {voice.profile.meanF0Hz === null
                    ? t('job.profile.unknown')
                    : `${format.number(voice.profile.meanF0Hz)} Hz`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">{t('job.profile.pitch')}</dt>
                <dd className="nums font-mono">
                  {semitones(voice.profile.pitchSemitones, (value) =>
                    format.number(value, { maximumFractionDigits: 1 }),
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">{t('job.profile.speed')}</dt>
                <dd className="nums font-mono">
                  {format.number(voice.profile.speed, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                  ×
                </dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">{t('job.profile.base')}</dt>
                <dd className="truncate font-mono text-xs">{voice.profile.baseVoiceId}</dd>
              </div>
            </dl>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              leftIcon={<Clapperboard aria-hidden="true" />}
              disabled={!startVideo.canOpen}
              loading={startVideo.isPending}
              onClick={() =>
                startVideo.start({
                  title: t('job.videoTitle', { name: voice.name }),
                  text: sampleText,
                  locale: uiLocale,
                  voice: { id: voice.id, language },
                })
              }
            >
              {t('job.use')}
            </Button>
            <Button asChild>
              <Link to={`${LIB_ROUTES.voices}?kind=cloned&voice=${voice.id}`}>{t('job.open')}</Link>
            </Button>
            <Button variant="ghost" leftIcon={<Plus aria-hidden="true" />} onClick={onAnother}>
              {t('job.another')}
            </Button>
          </div>
        </>
      )}

      {voice.status === 'failed' && (
        <>
          <Callout tone="danger" role="alert" icon={<TriangleAlert />} title={t('job.failedTitle')}>
            <p>
              {serverMessage(voice.error?.message, {
                code: voice.error?.code,
                reason: voice.error?.reason,
              }) || t('job.failedUnknown')}
            </p>
            <p className="mt-1.5">{t('job.refunded')}</p>
          </Callout>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={onAnother}>
              {t('job.retry')}
            </Button>
            <Button
              variant="ghost"
              leftIcon={<Trash2 aria-hidden="true" />}
              loading={remove.isPending}
              onClick={() => remove.mutate({ params: { voiceId: voice.id } })}
            >
              {t('job.discard')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
