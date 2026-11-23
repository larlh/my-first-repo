import type { LanguageCode } from '@parlante/shared';
import { Languages, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ProviderBadge } from '@/components/ProviderBadge';
import { api, isApiError, useApiMutation, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button, Input, PageHeader, Select, Slider, Switch, toast, useErrorText } from '@/ui';
import {
  AUTO_VOICE,
  CreditCost,
  Notice,
  Step,
  TOOL_ROUTES,
  VoiceSelect,
  languageLabel,
  languageShortName,
  useAvailableRoutes,
  useLanguageOptions,
  useUiLocale,
} from '@/features/script-writer/kit';
import { SourcePicker } from './components/SourcePicker';
import { TargetLanguages } from './components/TargetLanguages';
import { TranscriptField } from './components/TranscriptField';
import {
  CREDITS_PER_MINUTE_AND_LANGUAGE,
  billedMinutes,
  buildCreateBody,
  emptyForm,
  formProblems,
  translationCost,
  withoutSource,
} from './lib/translate';
import type { FormProblem, TranslationForm } from './lib/translate';

/**
 * New video translation (master prompt §3.12): source video, languages (capped by the plan),
 * transcript when speech recognition is manual, voices, options and the cost in credits.
 */
export default function NewTranslationPage() {
  const { t } = useTranslation('translate');
  const session = useSession();
  const navigate = useNavigate();
  const format = useFormat();
  const locale = useUiLocale();
  const describe = useErrorText();
  const available = useAvailableRoutes();
  const languages = useLanguageOptions();
  const limits = session.plan.limits;

  const capabilities = useApiQuery(api.system.capabilities, undefined, { staleTime: 60_000 });
  const active = capabilities.data?.active;
  // Until the server says otherwise, assume the local mode (the transcript is needed).
  const transcriptRequired = capabilities.data?.sttRequiresTranscript ?? true;

  const [form, setForm] = useState<TranslationForm>(() => emptyForm(locale));
  const [submitted, setSubmitted] = useState(false);
  const patch = (next: Partial<TranslationForm>) => setForm((current) => ({ ...current, ...next }));

  const problems = formProblems(form, {
    transcriptRequired,
    maxTargets: limits.maxTranslationTargets,
    maxSourceSec: limits.maxTranslationSourceSec,
    credits: session.credits,
  });
  const has = (problem: FormProblem) => problems.includes(problem);
  const cost = translationCost(form);
  const duration = form.source?.durationMs ?? null;

  const create = useApiMutation(api.translations.create, {
    invalidates: [api.translations.list],
    onSuccess: (job) => {
      void session.refresh();
      toast.success(t('new.queued'));
      void navigate(TOOL_ROUTES.translation(job.id));
    },
    onError: (error) => {
      const text = describe(error);
      toast.error(t('new.failed'), {
        description:
          isApiError(error) && error.code === 'TRANSCRIPT_REQUIRED'
            ? t('new.problems.transcriptRequired')
            : text.message || text.title,
      });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (problems.length > 0) {
      document.getElementById('translate-problems')?.scrollIntoView({ block: 'center' });
      return;
    }
    create.mutate({ body: buildCreateBody(form) });
  };

  const translationBasic = active?.translation.quality === 'basic';

  return (
    <>
      <PageHeader
        back={{ to: TOOL_ROUTES.translate, label: t('list.title') }}
        eyebrow={t('new.eyebrow')}
        title={t('new.title')}
        description={t('new.description')}
      />

      <form onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-5">
        <Step number="01" title={t('new.source.title')} description={t('new.source.text')}>
          <SourcePicker
            value={form.source}
            onChange={(source) =>
              patch({
                source,
                name: form.name !== '' || !source ? form.name : source.name.slice(0, 120),
              })
            }
            maxUploadBytes={limits.maxUploadBytes}
          />
          {has('sourceTooLong') && duration && (
            <Notice tone="danger" role="alert" icon={<TriangleAlert />} className="mt-4">
              {t('new.problems.sourceTooLong', {
                length: format.duration(duration),
                max: format.duration(limits.maxTranslationSourceSec * 1000),
              })}
            </Notice>
          )}
          {has('unknownDuration') && (
            <Notice tone="danger" role="alert" icon={<TriangleAlert />} className="mt-4">
              {t('new.problems.unknownDuration')}
            </Notice>
          )}
        </Step>

        <Step number="02" title={t('new.languages.title')} description={t('new.languages.text')}>
          <div className="flex min-w-0 flex-col gap-5">
            <Select<LanguageCode>
              label={t('new.languages.source')}
              hint={t('new.languages.sourceHint')}
              value={form.sourceLanguage}
              onValueChange={(sourceLanguage) =>
                patch({ sourceLanguage, targets: withoutSource(form.targets, sourceLanguage) })
              }
              options={languages}
              wrapperClassName="sm:max-w-xs"
            />
            <TargetLanguages
              source={form.sourceLanguage}
              value={form.targets}
              onChange={(targets) => patch({ targets })}
              max={limits.maxTranslationTargets}
              error={submitted && has('noTargets') ? t('new.problems.noTargets') : undefined}
            />
          </div>
        </Step>

        <Step
          number="03"
          title={t('new.transcript.title')}
          description={
            transcriptRequired ? t('new.transcript.required') : t('new.transcript.optional')
          }
          aside={active ? <ProviderBadge provider={active.stt} size="sm" /> : undefined}
        >
          <TranscriptField
            format={form.transcriptFormat}
            content={form.transcript}
            onChange={(next) =>
              patch({
                ...(next.format !== undefined ? { transcriptFormat: next.format } : {}),
                ...(next.content !== undefined ? { transcript: next.content } : {}),
              })
            }
            durationMs={duration}
            required={transcriptRequired}
            error={
              submitted && has('transcriptRequired')
                ? t('new.problems.transcriptRequired')
                : undefined
            }
          />
        </Step>

        <Step number="04" title={t('new.dub.title')} description={t('new.dub.text')}>
          <div className="flex min-w-0 flex-col gap-5">
            {form.targets.length === 0 ? (
              <p className="text-sm text-fg-muted">{t('new.dub.noTargets')}</p>
            ) : (
              <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
                {form.targets.map((code) => (
                  <li key={code} className="min-w-0">
                    <VoiceSelect
                      label={t('new.dub.voiceFor', { language: languageLabel(code, locale) })}
                      language={code}
                      value={form.voices[code] ?? AUTO_VOICE}
                      onValueChange={(voiceId) =>
                        patch({ voices: { ...form.voices, [code]: voiceId } })
                      }
                      autoLabel={t('new.dub.auto')}
                    />
                  </li>
                ))}
              </ul>
            )}
            <div className="grid min-w-0 gap-5 border-t border-line pt-5 sm:grid-cols-2">
              <Slider
                label={t('new.dub.original')}
                hint={t('new.dub.originalHint')}
                value={Math.round(form.originalAudioVolume * 100)}
                onValueChange={(value) => patch({ originalAudioVolume: value / 100 })}
                min={0}
                max={100}
                step={1}
                formatValue={(value) =>
                  value === 0 ? t('new.dub.originalOff') : format.percent(value / 100)
                }
              />
              <Switch
                checked={form.burnSubtitles}
                onCheckedChange={(burnSubtitles) => patch({ burnSubtitles })}
                label={t('new.dub.burn')}
                description={t('new.dub.burnHint')}
              />
            </div>
            <Input
              label={t('new.name')}
              optionalLabel={t('common.optional')}
              value={form.name}
              onChange={(event) => patch({ name: event.target.value })}
              maxLength={120}
              wrapperClassName="sm:max-w-md"
            />
          </div>
        </Step>

        <Step number="05" title={t('new.review.title')} description={t('new.review.text')}>
          <div className="flex min-w-0 flex-col gap-4">
            {active && (
              <dl className="grid min-w-0 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {(
                  [
                    ['stt', active.stt],
                    ['translation', active.translation],
                    ['tts', active.tts],
                  ] as const
                ).map(([step, provider]) => (
                  <div key={step} className="flex min-w-0 flex-col items-start gap-1">
                    <dt className="eyebrow text-fg-subtle">{t(`providers.${step}`)}</dt>
                    <dd>
                      <ProviderBadge provider={provider} size="sm" />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {translationBasic && (
              <Notice tone="warning" icon={<TriangleAlert />} title={t('new.basic.title')}>
                {t('new.basic.text')}
              </Notice>
            )}

            <CreditCost
              cost={cost}
              pending={t('new.cost.pending')}
              detail={
                duration && form.targets.length > 0
                  ? t('new.cost.detail', {
                      rate: CREDITS_PER_MINUTE_AND_LANGUAGE,
                      minutes: billedMinutes(duration),
                      languages: form.targets.length,
                    })
                  : t('new.cost.rule', { rate: CREDITS_PER_MINUTE_AND_LANGUAGE })
              }
            />

            {submitted && problems.length > 0 && (
              <Notice
                tone="danger"
                role="alert"
                icon={<TriangleAlert />}
                title={t('new.problems.title')}
              >
                <ul id="translate-problems" className="list-disc pl-4">
                  {problems.map((problem) => (
                    <li key={problem}>
                      {problem === 'sourceTooLong'
                        ? t('new.problems.sourceTooLongShort')
                        : problem === 'tooManyTargets'
                          ? t('targets.full', { count: limits.maxTranslationTargets })
                          : t(`new.problems.${problem}`)}
                    </li>
                  ))}
                </ul>
              </Notice>
            )}

            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                loading={create.isPending}
                leftIcon={<Languages aria-hidden="true" />}
              >
                {form.targets.length > 0
                  ? t('new.submit', { count: form.targets.length })
                  : t('new.submitNone')}
              </Button>
              <Button asChild variant="ghost">
                <Link to={TOOL_ROUTES.translate}>{t('common.cancel')}</Link>
              </Button>
              {has('insufficientCredits') && available.billing && (
                <Button asChild variant="link">
                  <Link to={TOOL_ROUTES.billing}>{t('new.buy')}</Link>
                </Button>
              )}
            </div>
            {form.source && form.targets.length > 0 && (
              <p className="text-sm text-fg-muted">
                {t('new.summary', {
                  name: form.source.name,
                  from: languageShortName(form.sourceLanguage, locale),
                  to: form.targets.map((code) => languageShortName(code, locale)).join(', '),
                })}
              </p>
            )}
          </div>
        </Step>
      </form>
    </>
  );
}
