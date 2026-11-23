import { CREDIT_COSTS, defaultVoiceId } from '@parlante/shared';
import type { Avatar, AvatarFraming } from '@parlante/shared';
import { Clapperboard, Copy, Pencil, Play, Square, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { JobStatus } from '@/components/JobStatus';
import { ProviderBadge } from '@/components/ProviderBadge';
import { api, useApiMutation } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Dialog,
  Input,
  SegmentedControl,
  cn,
  toast,
  useConfirm,
  useErrorText,
} from '@/ui';
import {
  AvatarStage,
  Callout,
  EngineStrip,
  animationSeconds,
  engineCan,
  nonCommercialModels,
  useSpeechPreview,
  useStartVideo,
} from '../kit';
import type { EngineStatus } from '../kit';
import { avatarOrigin, isOwnAvatar } from '../lib/filters';
import { OriginBadge, backdropStyle } from './AvatarCard';

const FRAMINGS: readonly AvatarFraming[] = ['bust', 'half', 'closeup'];
/** Length of video used for the worked time example. */
const EXAMPLE_VIDEO_SEC = 10;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function RenameForm({ avatar, onDone }: { avatar: Avatar; onDone: () => void }) {
  const { t } = useTranslation('avatars');
  const describe = useErrorText();
  const [name, setName] = useState(avatar.name);
  const rename = useApiMutation(api.photoAvatars.update, {
    invalidates: [api.avatars.list, api.avatars.get],
    onSuccess: () => {
      toast.success(t('sheet.renamed'));
      onDone();
    },
    onError: (error) =>
      toast.error(t('sheet.renameFailed'), { description: describe(error).title }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === avatar.name) return onDone();
    rename.mutate({ params: { avatarId: avatar.id }, body: { name: trimmed } });
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <Input
        label={t('sheet.nameLabel')}
        value={name}
        maxLength={60}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        wrapperClassName="min-w-0 flex-1 basis-48"
      />
      <Button type="submit" variant="solid" loading={rename.isPending}>
        {t('sheet.save')}
      </Button>
      <Button type="button" variant="ghost" onClick={onDone}>
        {t('sheet.cancel')}
      </Button>
    </form>
  );
}

export interface AvatarSheetProps {
  /** The avatar to show; null closes the sheet. */
  avatar: Avatar | null;
  engine: EngineStatus | null;
  onClose: () => void;
}

/**
 * The card of one avatar: a large live preview (it can introduce itself with a real
 * synthesized voice, lips in sync), what it is and where it comes from, the honest cost of
 * using it, and "use in a video".
 */
export function AvatarSheet({ avatar, engine, onClose }: AvatarSheetProps) {
  const { t, i18n } = useTranslation('avatars');
  const format = useFormat();
  const session = useSession();
  const describe = useErrorText();
  const confirm = useConfirm();
  const speech = useSpeechPreview();
  const [framing, setFraming] = useState<AvatarFraming>('bust');
  const [renaming, setRenaming] = useState(false);

  // Keep showing the last avatar while the dialog animates out.
  const [shown, setShown] = useState<Avatar | null>(avatar);
  useEffect(() => {
    if (avatar) setShown(avatar);
  }, [avatar]);
  const stopSpeech = speech.stop;
  const avatarId = avatar?.id ?? null;
  useEffect(() => {
    stopSpeech();
    setRenaming(false);
    setFraming('bust');
  }, [avatarId, stopSpeech]);

  const startVideo = useStartVideo({
    onCreated: () => toast.success(t('sheet.videoCreated')),
    onError: (error) => toast.error(t('sheet.videoFailed'), { description: describe(error).title }),
  });
  const remove = useApiMutation(api.photoAvatars.remove, {
    invalidates: [api.avatars.list],
    onSuccess: () => {
      toast.success(t('sheet.deleted'));
      onClose();
    },
    onError: (error) =>
      toast.error(t('sheet.deleteFailed'), { description: describe(error).title }),
  });

  if (!shown) return null;
  const current = shown;
  const locale = i18n.language.startsWith('en') ? 'en' : 'es';
  const origin = avatarOrigin(current);
  const instant = current.rendering === 'instant';
  const own = isOwnAvatar(current);
  const ready = current.status === 'ready';
  const canEdit = session.can('editor');
  const speaking = speech.status === 'playing';
  const canAnimate = engineCan(engine, 'animate');
  const example = animationSeconds(engine, EXAMPLE_VIDEO_SEC);
  const restricted = nonCommercialModels(engine).length > 0;

  const introduce = () => {
    if (speech.status === 'playing' || speech.status === 'loading') return speech.stop();
    void speech.play(current.id, {
      text: t('sheet.intro', { name: current.name }),
      voiceId: defaultVoiceId(locale, current.gender === 'male' ? 'male' : 'female'),
      language: locale,
    });
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(current.id);
      toast.success(t('sheet.idCopied'));
    } catch {
      toast.error(t('sheet.idCopyFailed'));
    }
  };

  const askDelete = async () => {
    const ok = await confirm({
      title: t('sheet.deleteTitle', { name: current.name }),
      description: t(`sheet.deleteText.${current.kind === 'photo' ? 'photo' : 'generated'}`),
      confirmLabel: t('sheet.delete'),
      tone: 'danger',
    });
    if (ok) remove.mutate({ params: { avatarId: current.id } });
  };

  return (
    <Dialog
      open={avatar !== null}
      onOpenChange={(open) => !open && onClose()}
      title={current.name}
      description={current.description || t(`originHint.${origin}`)}
      size="xl"
      footer={
        <>
          <Button
            variant="ghost"
            leftIcon={<Copy aria-hidden="true" />}
            onClick={() => void copyId()}
          >
            {t('sheet.copyId')}
          </Button>
          <Button
            variant="primary"
            leftIcon={<Clapperboard aria-hidden="true" />}
            disabled={!ready || !canEdit || !startVideo.canOpen}
            loading={startVideo.isPending}
            onClick={() =>
              startVideo.start({
                title: t('sheet.videoTitle', { name: current.name }),
                text: t('sheet.videoScript', { name: current.name }),
                locale,
                avatarId: current.id,
              })
            }
          >
            {t('sheet.use')}
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {/* ---- stage ---- */}
        <div className="flex min-w-0 flex-col gap-3">
          <div
            className={cn(
              'relative mx-auto aspect-[4/5] w-full max-w-sm overflow-hidden rounded-xl bg-surface-3 text-fg-subtle lg:max-w-none',
              !instant && 'bg-media',
            )}
            style={instant ? backdropStyle(current) : undefined}
          >
            {instant && (
              <span aria-hidden="true" className="absolute inset-0 booth-grid opacity-60" />
            )}
            {!instant && (
              <span
                aria-hidden="true"
                className="absolute inset-0 bg-[radial-gradient(90%_70%_at_50%_10%,color-mix(in_srgb,var(--saffron)_22%,transparent),transparent_70%)]"
              />
            )}
            <AvatarStage
              avatar={current}
              mode={speaking ? 'speech' : 'idle'}
              runtime={speech.resultKey === current.id ? (speech.result?.runtime ?? null) : null}
              clock={speech.clock}
              framing={framing}
              label={t('sheet.live', { name: current.name })}
              className={cn('absolute inset-x-0 bottom-0', instant ? 'top-[6%]' : 'top-0')}
            />
            <OriginBadge avatar={current} size="md" className="absolute top-3 left-3" />
            {!instant && ready && (
              <span className="absolute inset-x-3 bottom-3 rounded-md bg-media/80 px-2.5 py-1.5 text-center text-xs text-on-media">
                {t('sheet.standIn')}
              </span>
            )}
          </div>
          {ready && (
            <SegmentedControl
              aria-label={t('sheet.framing')}
              value={framing}
              onValueChange={setFraming}
              block
              size="sm"
              options={FRAMINGS.map((value) => ({ value, label: t(`framing.${value}`) }))}
            />
          )}
        </div>

        {/* ---- facts ---- */}
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderBadge provider={current.provider} />
            <Badge tone="neutral" variant="outline">
              {t(`gender.${current.gender}`)}
            </Badge>
            {current.ageGroup && (
              <Badge tone="neutral" variant="outline">
                {t(`age.${current.ageGroup}`)}
              </Badge>
            )}
            {current.style && (
              <Badge tone="neutral" variant="outline">
                {t(`style.${current.style}`)}
              </Badge>
            )}
          </div>

          <p className="text-sm text-pretty text-fg-muted">{t(`originText.${origin}`)}</p>

          {current.status === 'processing' && (
            <JobStatus
              label={t('card.preparing', { name: current.name })}
              status="processing"
              progress={current.progress}
              etaSec={current.etaSec}
              stage={t('sheet.processing')}
            />
          )}
          {current.status === 'failed' && (
            <Callout
              tone="danger"
              role="alert"
              icon={<TriangleAlert />}
              title={t('sheet.failedTitle')}
            >
              {current.error?.message ?? t('sheet.failedText')}
            </Callout>
          )}

          {ready && (
            <div className="rounded-lg border border-line bg-surface-2 p-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="solid"
                  leftIcon={
                    speaking || speech.status === 'loading' ? (
                      <Square aria-hidden="true" />
                    ) : (
                      <Play aria-hidden="true" />
                    )
                  }
                  loading={speech.status === 'loading'}
                  onClick={introduce}
                >
                  {speaking ? t('sheet.stop') : t('sheet.listen')}
                </Button>
                {speech.result && speech.resultKey === current.id && (
                  <ProviderBadge provider={speech.result.provider} size="sm" />
                )}
              </div>
              <p className="mt-2 text-xs text-pretty text-fg-muted">
                {instant ? t('sheet.listenHint.instant') : t('sheet.listenHint.photoreal')}
              </p>
              {speech.status === 'error' && speech.error && (
                <p role="alert" className="mt-2 text-sm text-danger-text">
                  {describe(speech.error).title}
                </p>
              )}
            </div>
          )}

          {!instant && ready && (
            <div className="flex flex-col gap-2">
              <EngineStrip engine={engine} needs={['animate']} />
              <p className="text-xs text-pretty text-fg-muted">
                {canAnimate
                  ? example !== null
                    ? t('sheet.renderCost.measured', {
                        video: format.duration(EXAMPLE_VIDEO_SEC * 1000),
                        time: format.duration(example * 1000),
                      })
                    : t('sheet.renderCost.unmeasured')
                  : t('sheet.renderCost.off')}{' '}
                {t('sheet.renderCost.credits', { factor: CREDIT_COSTS.renderPhotorealMultiplier })}
              </p>
              {restricted && (
                <Callout
                  tone="warning"
                  icon={<TriangleAlert />}
                  title={t('sheet.nonCommercialTitle')}
                >
                  {t('sheet.nonCommercialText')}
                </Callout>
              )}
            </div>
          )}

          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {current.tags.length > 0 && (
              <Fact label={t('sheet.tags')}>{current.tags.join(' · ')}</Fact>
            )}
            <Fact label={t('sheet.id')}>
              <code className="font-mono text-xs">{current.id}</code>
            </Fact>
            {current.prompt && (
              <div className="sm:col-span-2">
                <Fact label={t('sheet.prompt')}>{current.prompt}</Fact>
              </div>
            )}
            {current.model && <Fact label={t('sheet.model')}>{current.model}</Fact>}
            {current.seed !== null && (
              <Fact label={t('sheet.seed')}>
                <span className="nums font-mono text-xs">{current.seed}</span>
              </Fact>
            )}
            {current.rig && (
              <Fact label={t('sheet.landmarks')}>
                {t(`sheet.landmarksSource.${current.rig.landmarksSource}`)}
              </Fact>
            )}
            {current.createdAt && (
              <Fact label={t('sheet.created')}>{format.date(current.createdAt)}</Fact>
            )}
          </dl>

          {own && canEdit && (
            <div className="border-t border-line pt-4">
              {renaming ? (
                <RenameForm avatar={current} onDone={() => setRenaming(false)} />
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    leftIcon={<Pencil aria-hidden="true" />}
                    onClick={() => setRenaming(true)}
                  >
                    {t('sheet.rename')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger-text"
                    leftIcon={<Trash2 aria-hidden="true" />}
                    loading={remove.isPending}
                    onClick={() => void askDelete()}
                  >
                    {t('sheet.delete')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
