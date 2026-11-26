import type { Voice } from '@parlante/shared';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api, useApiQuery, useInvalidateApi } from '@/lib/api';
import { PageHeader } from '@/ui';
import { LIB_ROUTES } from '@/features/avatars/kit';
import { CloneForm } from './components/CloneForm';
import { ModePanel } from './components/ModePanel';
import { VoiceJob } from './components/VoiceJob';
import { countClonedVoices } from './lib/sample';

const POLL_MS = 2000;

/**
 * Clone a voice from a sample (master prompt §3.14, §5): mandatory consent declaration, and
 * a plain statement of what the active provider does — the local "basic mode" fits a local
 * voice to the pitch and pace of the sample; an external provider reproduces the timbre.
 */
export default function CloneVoicePage() {
  const { t } = useTranslation('voice-clone');
  const invalidate = useInvalidateApi();
  const [params, setParams] = useSearchParams();
  const jobId = params.get('job');

  const capabilities = useApiQuery(api.system.capabilities, undefined, { staleTime: 60_000 });
  const voices = useApiQuery(
    api.voices.list,
    { query: { kind: 'cloned' } },
    {
      refetchInterval: (query) =>
        query.state.data?.items.some((voice) => voice.status === 'processing') ? POLL_MS : false,
    },
  );
  const used = voices.data ? countClonedVoices(voices.data.items) : null;
  const inProgress = (voices.data?.items ?? []).filter(
    (voice) => voice.status === 'processing' && voice.id !== jobId,
  );

  const follow = (voice: Voice | null) =>
    setParams((current) => {
      const copy = new URLSearchParams(current);
      if (voice) copy.set('job', voice.id);
      else copy.delete('job');
      return copy;
    });

  return (
    <>
      <PageHeader
        back={{ to: LIB_ROUTES.voices, label: t('back') }}
        eyebrow={t('eyebrow')}
        title={t('title')}
        description={t('description')}
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 rounded-xl border border-line bg-surface p-5 shadow-xs sm:p-6">
          {jobId ? (
            <VoiceJob voiceId={jobId} onAnother={() => follow(null)} />
          ) : (
            <CloneForm
              used={used}
              onCreated={(voice) => {
                void invalidate(api.voices.list);
                follow(voice);
              }}
            />
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6">
          <ModePanel
            provider={capabilities.data?.active.voiceClone}
            loading={capabilities.isPending}
          />
          {capabilities.isError && (
            <p role="alert" className="text-sm text-danger-text">
              {t('mode.unknown')}
            </p>
          )}
          {inProgress.length > 0 && (
            <section
              aria-label={t('queue.title')}
              className="rounded-xl border border-line bg-surface p-4"
            >
              <h2 className="text-base">{t('queue.title')}</h2>
              <ul className="mt-2 flex flex-col gap-1.5">
                {inProgress.map((voice) => (
                  <li key={voice.id}>
                    <Link
                      to={`${LIB_ROUTES.cloneVoice}?job=${voice.id}`}
                      className="text-sm font-semibold underline-offset-2 hover:underline"
                    >
                      {voice.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
