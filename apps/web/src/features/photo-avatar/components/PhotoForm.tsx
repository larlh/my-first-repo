import { CREDIT_COSTS } from '@parlante/shared';
import type { Avatar, Gender, UiLocale } from '@parlante/shared';
import { Camera, Check, RefreshCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient, isApiError, toApiError } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, FileDropzone, Input, ProgressBar, SegmentedControl } from '@/ui';
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
import { GENDERS, NAME_MAX, PHOTO_ACCEPT, nameFromFile, nameProblem } from '../lib/form';
import type { Allowance } from '../lib/form';

type Step = 'idle' | 'uploading' | 'consent' | 'creating';

export interface PhotoFormProps {
  /** The engine can prepare a photo right now. */
  canPrepare: boolean;
  allowance: Allowance | null;
  onCreated: (avatar: Avatar) => void;
}

/**
 * Photo → photorealistic avatar. Nothing leaves the browser until the person has given the
 * consent declaration and pressed the button; then: upload the photo (`avatar_source`),
 * record the consent, queue the preparation. An upload that does not end in an avatar is
 * deleted again.
 */
export function PhotoForm({ canPrepare, allowance, onCreated }: PhotoFormProps) {
  const { t, i18n } = useTranslation('photo-avatar');
  const session = useSession();
  const locale: UiLocale = i18n.language.startsWith('en') ? 'en' : 'es';

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [gender, setGender] = useState<Gender>('neutral');
  const [consent, setConsent] = useState<ConsentDraft>(EMPTY_CONSENT);
  const [touched, setTouched] = useState(false);
  const [step, setStep] = useState<Step>('idle');
  const [uploaded, setUploaded] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);

  const source = useSourceAsset('avatar_source');
  const consentRecord = useConsentRecord('photo_avatar');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  // Local preview of the chosen photo (never uploaded just to be shown).
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const busy = step !== 'idle';
  const nameIssue = nameProblem(name);
  const consentIssues: ConsentProblems = consentProblems(consent);
  const cost = CREDIT_COSTS.photoAvatar;
  const blocked = !canPrepare || session.credits < cost || (allowance !== null && !allowance.room);

  const choose = (files: File[]) => {
    const next = files[0];
    if (!next) return;
    source.discard();
    setFile(next);
    setError(null);
    if (name.trim() === '') setName(nameFromFile(next.name));
  };
  const clearPhoto = () => {
    source.discard();
    setFile(null);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    setError(null);
    if (!file || nameIssue || Object.keys(consentIssues).length > 0 || blocked) return;
    const controller = new AbortController();
    abort.current = controller;
    try {
      setStep('uploading');
      setUploaded(0);
      const asset = await source.ensure(file, {
        signal: controller.signal,
        onProgress: (progress) => setUploaded(progress.fraction),
      });
      setStep('consent');
      const consentId = await consentRecord.ensure(consent, locale);
      setStep('creating');
      const avatar = await apiClient.photoAvatars.create(
        { body: { name: name.trim(), imageAssetId: asset.id, consentId, gender } },
        { signal: controller.signal },
      );
      // The photo and the consent now belong to the avatar.
      source.adopt();
      consentRecord.forget();
      void session.refresh();
      onCreated(avatar);
    } catch (err) {
      const failure = toApiError(err);
      if (failure.code === 'ABORTED') return;
      // A rejected consent record cannot be reused; a photo already in use neither.
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
      <section aria-labelledby="photo-step-1">
        <h2 id="photo-step-1" className="flex items-baseline gap-2.5 text-xl">
          <span className="nums font-mono text-sm text-fg-subtle">01</span>
          {t('photo.pick')}
        </h2>
        <div className="mt-3 grid gap-5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
          {file && previewUrl ? (
            <div className="flex flex-col gap-2">
              <div className="relative aspect-[4/5] overflow-hidden rounded-xl bg-media">
                <img
                  src={previewUrl}
                  alt={t('photo.previewAlt')}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                leftIcon={<RefreshCcw aria-hidden="true" />}
                disabled={busy}
                onClick={clearPhoto}
              >
                {t('photo.change')}
              </Button>
            </div>
          ) : (
            <FileDropzone
              onFiles={choose}
              accept={PHOTO_ACCEPT}
              maxSizeBytes={session.plan.limits.maxUploadBytes}
              disabled={busy}
              icon={<Camera aria-hidden="true" />}
              title={t('photo.drop')}
              description={t('photo.formats')}
              error={touched && !file ? t('problem.photoRequired') : undefined}
              aria-label={t('photo.drop')}
              className="sm:col-span-1"
            />
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t('photo.tipsTitle')}</p>
            <ul className="mt-2 flex flex-col gap-1.5 text-sm text-fg-muted">
              {(['front', 'light', 'alone', 'clear', 'size'] as const).map((tip) => (
                <li key={tip} className="flex gap-2">
                  <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                  {t(`photo.tips.${tip}`)}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-pretty text-fg-muted">{t('photo.private')}</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="photo-step-2">
        <h2 id="photo-step-2" className="flex items-baseline gap-2.5 text-xl">
          <span className="nums font-mono text-sm text-fg-subtle">02</span>
          {t('details.title')}
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
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
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-sm font-semibold">{t('details.gender')}</span>
            <SegmentedControl
              aria-label={t('details.gender')}
              value={gender}
              onValueChange={setGender}
              disabled={busy}
              options={GENDERS.map((value) => ({ value, label: t(`gender.${value}`) }))}
            />
            <span className="text-sm text-fg-muted">{t('details.genderHint')}</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="photo-step-3">
        <h2 id="photo-step-3" className="flex items-baseline gap-2.5 text-xl">
          <span className="nums font-mono text-sm text-fg-subtle">03</span>
          {t('photo.consent')}
        </h2>
        <ConsentForm
          className="mt-3"
          kind="photo_avatar"
          value={consent}
          onChange={setConsent}
          problems={touched ? consentIssues : {}}
          disabled={busy}
        />
      </section>

      <div className="flex flex-col gap-3 border-t border-line pt-5">
        <CostLine
          cost={cost}
          allowanceFull={allowance !== null && !allowance.room}
          allowanceText={
            allowance
              ? t('allowance', {
                  used: allowance.used,
                  max: allowance.max,
                  plan: session.plan.name,
                })
              : null
          }
        />
        {!canPrepare && (
          <Callout tone="warning" role="status" title={t('photo.engineOffTitle')}>
            {t('photo.engineOffText')}
          </Callout>
        )}
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
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={blocked}>
            {t('photo.submit')}
          </Button>
          {busy && (
            <Button type="button" variant="ghost" onClick={() => abort.current?.abort()}>
              {t('cancel')}
            </Button>
          )}
          <p className="min-w-0 flex-1 basis-56 text-xs text-pretty text-fg-muted">
            {t('photo.submitHint')}
          </p>
        </div>
      </div>
    </form>
  );
}
