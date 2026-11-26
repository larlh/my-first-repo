import { CREDIT_COSTS, LANGUAGES, baseLanguage } from '@parlante/shared';
import type { Gender, LanguageCode, UiLocale, Voice } from '@parlante/shared';
import { Check, FileAudio, Mic, RefreshCcw, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient, isApiError, toApiError } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Button,
  FileDropzone,
  Input,
  ProgressBar,
  SegmentedControl,
  Select,
  VoiceBars,
  cn,
} from '@/ui';
import {
  Callout,
  ConsentForm,
  CostLine,
  EMPTY_CONSENT,
  FailureNote,
  consentProblems,
  creationFailure,
  useConsentRecord,
  useSourceAsset,
} from '@/features/avatars/kit';
import type { ConsentDraft, ConsentProblems } from '@/features/avatars/kit';
import {
  SAMPLE_ACCEPT,
  SAMPLE_MAX_MS,
  SAMPLE_MIN_MS,
  durationProblem,
  readAudioDurationMs,
} from '../lib/sample';
import { recordingSupported, useRecorder } from '../lib/useRecorder';

type Step = 'idle' | 'uploading' | 'consent' | 'creating';
const GENDERS: readonly Gender[] = ['female', 'male', 'neutral'];
const NAME_MAX = 60;

interface Sample {
  file: File;
  /** Length read in the browser; null when it could not be read. */
  durationMs: number | null;
  recorded: boolean;
}

export interface CloneFormProps {
  /** Cloned voices already counted against the plan, or null while unknown. */
  used: number | null;
  onCreated: (voice: Voice) => void;
}

/**
 * Voice sample → cloned voice. The sample (uploaded or recorded here) stays in the browser
 * until the consent declaration is accepted and the button pressed; then: upload
 * (`voice_sample`), record the consent, queue the clone.
 */
export function CloneForm({ used, onCreated }: CloneFormProps) {
  const { t, i18n } = useTranslation('voice-clone');
  const format = useFormat();
  const session = useSession();
  const locale: UiLocale = i18n.language.startsWith('en') ? 'en' : 'es';

  const [sample, setSample] = useState<Sample | null>(null);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<LanguageCode>(baseLanguage(locale) ?? 'es');
  const [gender, setGender] = useState<Gender>('neutral');
  const [consent, setConsent] = useState<ConsentDraft>(EMPTY_CONSENT);
  const [touched, setTouched] = useState(false);
  const [step, setStep] = useState<Step>('idle');
  const [uploaded, setUploaded] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);

  const source = useSourceAsset('voice_sample');
  const consentRecord = useConsentRecord('voice_clone');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const recorder = useRecorder({
    fileName: t('sample.recordingFile'),
    onRecorded: ({ file, durationMs }) => {
      source.discard();
      setError(null);
      setSample({ file, durationMs, recorded: true });
    },
  });
  const canRecord = recordingSupported();

  const previewUrl = useMemo(() => (sample ? URL.createObjectURL(sample.file) : null), [sample]);
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const choose = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    source.discard();
    setError(null);
    setSample({ file, durationMs: null, recorded: false });
    const durationMs = await readAudioDurationMs(file);
    setSample((current) => (current?.file === file ? { ...current, durationMs } : current));
  };
  const clearSample = () => {
    source.discard();
    setSample(null);
    setError(null);
  };

  const busy = step !== 'idle';
  const recording = recorder.state === 'recording';
  const lengthIssue = sample ? durationProblem(sample.durationMs) : null;
  const nameIssue =
    name.trim() === '' ? 'nameRequired' : name.trim().length > NAME_MAX ? 'nameTooLong' : null;
  const consentIssues: ConsentProblems = consentProblems(consent);
  const cost = CREDIT_COSTS.voiceClone;
  const max = session.plan.limits.maxClonedVoices;
  const full = used !== null && used >= max;
  const blocked = session.credits < cost || full;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    setError(null);
    if (!sample || lengthIssue || nameIssue || Object.keys(consentIssues).length > 0 || blocked) {
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    try {
      setStep('uploading');
      setUploaded(0);
      const asset = await source.ensure(sample.file, {
        signal: controller.signal,
        onProgress: (progress) => setUploaded(progress.fraction),
      });
      setStep('consent');
      const consentId = await consentRecord.ensure(consent, locale);
      setStep('creating');
      const voice = await apiClient.voiceClones.create(
        { body: { name: name.trim(), sampleAssetId: asset.id, consentId, language, gender } },
        { signal: controller.signal },
      );
      source.adopt();
      consentRecord.forget();
      void session.refresh();
      onCreated(voice);
    } catch (err) {
      const failure = toApiError(err);
      if (failure.code === 'ABORTED') return;
      if (failure.code === 'CONSENT_REQUIRED') consentRecord.forget();
      if (creationFailure(failure) === 'sourceInUse') source.adopt();
      setError(failure);
    } finally {
      setStep('idle');
    }
  };

  const nameError =
    touched && nameIssue
      ? t(`problem.${nameIssue}`)
      : error && isApiError(error) && error.fieldErrors.name
        ? error.fieldErrors.name
        : undefined;

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-7">
      <section aria-labelledby="clone-step-1">
        <h2 id="clone-step-1" className="flex items-baseline gap-2.5 text-xl">
          <span className="nums font-mono text-sm text-fg-subtle">01</span>
          {t('sample.title')}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          {t('sample.rule', {
            min: format.duration(SAMPLE_MIN_MS),
            max: format.duration(SAMPLE_MAX_MS),
          })}
        </p>

        {sample && previewUrl ? (
          <div className="mt-3 rounded-xl border border-line bg-surface-2 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-inverse text-inverse-fg"
              >
                {sample.recorded ? <Mic className="size-5" /> : <FileAudio className="size-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{sample.file.name}</p>
                <p className="nums text-xs text-fg-muted">
                  {sample.durationMs !== null
                    ? format.duration(Math.round(sample.durationMs / 1000) * 1000)
                    : t('sample.unknownLength')}
                  {' · '}
                  {format.bytes(sample.file.size)}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                leftIcon={<RefreshCcw aria-hidden="true" />}
                disabled={busy}
                onClick={clearSample}
              >
                {t('sample.change')}
              </Button>
            </div>
            <audio
              controls
              src={previewUrl}
              aria-label={t('sample.listen')}
              className="mt-3 h-10 w-full"
            />
            {lengthIssue && (
              <p role="alert" className="mt-2 text-sm font-medium text-danger-text">
                {t(`problem.${lengthIssue}`, {
                  min: format.duration(SAMPLE_MIN_MS),
                  max: format.duration(SAMPLE_MAX_MS),
                })}
              </p>
            )}
          </div>
        ) : recording || recorder.state === 'encoding' || recorder.state === 'requesting' ? (
          <div
            role="status"
            className="mt-3 flex flex-wrap items-center gap-4 rounded-xl bg-media px-5 py-5 text-on-media [--ring:var(--saffron)]"
          >
            <VoiceBars size="md" active={recording} label={null} className="text-accent" />
            <div className="min-w-0 flex-1">
              <p className="display text-xl">
                {recording
                  ? t('record.recording')
                  : recorder.state === 'encoding'
                    ? t('record.encoding')
                    : t('record.requesting')}
              </p>
              <p className="nums font-mono text-sm text-on-media/70">
                {format.clock(recorder.elapsedMs)}
                {recording && recorder.elapsedMs < SAMPLE_MIN_MS
                  ? ` · ${t('record.keepGoing', { min: format.duration(SAMPLE_MIN_MS) })}`
                  : ''}
              </p>
            </div>
            {recording && (
              <>
                <Button
                  type="button"
                  variant="primary"
                  leftIcon={<Square aria-hidden="true" className="fill-current" />}
                  onClick={recorder.stop}
                >
                  {t('record.stop')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-on-media hover:bg-on-media/10"
                  onClick={recorder.cancel}
                >
                  {t('record.cancel')}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-stretch">
            <FileDropzone
              onFiles={(files) => void choose(files)}
              accept={SAMPLE_ACCEPT}
              maxSizeBytes={session.plan.limits.maxUploadBytes}
              disabled={busy}
              icon={<FileAudio aria-hidden="true" />}
              title={t('sample.drop')}
              description={t('sample.formats')}
              error={touched && !sample ? t('problem.sampleRequired') : undefined}
              aria-label={t('sample.drop')}
            />
            <div className="flex flex-col items-stretch justify-center gap-2 rounded-xl border border-dashed border-line-strong p-4 sm:w-56">
              <Button
                type="button"
                variant="solid"
                leftIcon={<Mic aria-hidden="true" />}
                disabled={busy || !canRecord}
                onClick={() => void recorder.start()}
              >
                {t('record.start')}
              </Button>
              <p className="text-center text-xs text-pretty text-fg-muted">
                {canRecord ? t('record.hint') : t('record.unsupported')}
              </p>
            </div>
          </div>
        )}
        {recorder.state === 'denied' && (
          <Callout className="mt-3" tone="warning" role="alert" title={t('record.deniedTitle')}>
            {t('record.deniedText')}
          </Callout>
        )}
        {recorder.state === 'missing' && (
          <Callout className="mt-3" tone="warning" role="alert" title={t('record.missingTitle')}>
            {t('record.missingText')}
          </Callout>
        )}
        {recorder.state === 'error' && (
          <Callout className="mt-3" tone="danger" role="alert" title={t('record.errorTitle')}>
            {t('record.errorText')}
          </Callout>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-sm font-semibold">{t('sample.tipsTitle')}</p>
            <ul className="mt-2 flex flex-col gap-1.5 text-sm text-fg-muted">
              {(['alone', 'quiet', 'natural', 'length'] as const).map((tip) => (
                <li key={tip} className="flex gap-2">
                  <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                  {t(`sample.tips.${tip}`)}
                </li>
              ))}
            </ul>
          </div>
          <figure
            className={cn(
              'rounded-lg border border-line bg-surface-2 px-4 py-3',
              recording && 'border-accent',
            )}
          >
            <figcaption className="eyebrow text-fg-subtle">{t('sample.readTitle')}</figcaption>
            <blockquote className="mt-1.5 text-sm leading-relaxed text-pretty">
              {t('sample.readText')}
            </blockquote>
          </figure>
        </div>
        <p className="mt-3 text-xs text-pretty text-fg-muted">{t('sample.private')}</p>
      </section>

      <section aria-labelledby="clone-step-2">
        <h2 id="clone-step-2" className="flex items-baseline gap-2.5 text-xl">
          <span className="nums font-mono text-sm text-fg-subtle">02</span>
          {t('details.title')}
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Input
            label={t('details.name')}
            hint={t('details.nameHint')}
            name="name"
            value={name}
            maxLength={NAME_MAX}
            required
            disabled={busy}
            error={nameError}
            onChange={(event) => setName(event.target.value)}
          />
          <Select<LanguageCode>
            label={t('details.language')}
            hint={t('details.languageHint')}
            value={language}
            disabled={busy}
            onValueChange={setLanguage}
            options={LANGUAGES.map((entry) => ({
              value: entry.code,
              label: locale === 'en' ? entry.englishName : entry.name,
            }))}
          />
          <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-semibold">{t('details.gender')}</span>
            <SegmentedControl
              aria-label={t('details.gender')}
              value={gender}
              onValueChange={setGender}
              disabled={busy}
              className="self-start"
              options={GENDERS.map((value) => ({ value, label: t(`gender.${value}`) }))}
            />
            <span className="text-sm text-fg-muted">{t('details.genderHint')}</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="clone-step-3">
        <h2 id="clone-step-3" className="flex items-baseline gap-2.5 text-xl">
          <span className="nums font-mono text-sm text-fg-subtle">03</span>
          {t('consent')}
        </h2>
        <ConsentForm
          className="mt-3"
          kind="voice_clone"
          value={consent}
          onChange={setConsent}
          problems={touched ? consentIssues : {}}
          disabled={busy}
        />
      </section>

      <div className="flex flex-col gap-3 border-t border-line pt-5">
        <CostLine
          cost={cost}
          allowanceFull={full}
          allowanceText={
            used !== null ? t('allowance', { used, max, plan: session.plan.name }) : null
          }
        />
        {error && <FailureNote error={error} />}
        {busy && (
          <div role="status" className="flex flex-col gap-1.5 text-sm">
            <span>{t(`step.${step}`)}</span>
            <ProgressBar
              label={t(`step.${step}`)}
              value={step === 'uploading' ? Math.round(uploaded * 100) : null}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy}
            disabled={blocked || recording}
          >
            {t('submit')}
          </Button>
          {busy && (
            <Button type="button" variant="ghost" onClick={() => abort.current?.abort()}>
              {t('cancel')}
            </Button>
          )}
          <p className="min-w-0 flex-1 basis-56 text-xs text-pretty text-fg-muted">
            {t('submitHint')}
          </p>
        </div>
      </div>
    </form>
  );
}
