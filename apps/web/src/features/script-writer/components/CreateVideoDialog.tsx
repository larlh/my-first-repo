import type { AspectRatio, Avatar, Video } from '@parlante/shared';
import { DEFAULT_STOCK_AVATAR_ID } from '@parlante/renderer';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, useApiMutation } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import {
  Button,
  Dialog,
  ErrorState,
  SegmentedControl,
  Skeleton,
  Switch,
  toast,
  useErrorText,
} from '@/ui';
import {
  AvatarPicker,
  Notice,
  VoiceSelect,
  defaultVoiceOf,
  languageShortName,
  usableAvatars,
  useAvatars,
  useUiLocale,
  useVoices,
} from '../kit';
import { draftTiming, draftToComposition } from '../lib/script';
import type { ScriptDraft } from '../lib/script';

const ASPECTS: AspectRatio[] = ['16:9', '9:16', '1:1'];
const ASPECT_KEYS: Record<AspectRatio, string> = {
  '16:9': 'landscape',
  '9:16': 'portrait',
  '1:1': 'square',
};

export interface CreateVideoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: ScriptDraft;
  onCreated: (video: Video) => void;
}

/**
 * Last step of the script writer: who tells the script (avatar + voice) and in which shape.
 * It creates a DRAFT video (`source: 'script'`); rendering — and its credits — happen later.
 */
export function CreateVideoDialog({
  open,
  onOpenChange,
  draft,
  onCreated,
}: CreateVideoDialogProps) {
  const { t } = useTranslation('script-writer');
  const format = useFormat();
  const locale = useUiLocale();
  const describe = useErrorText();
  const avatars = useAvatars();
  const voices = useVoices(draft.language, open);
  const choices = useMemo(() => usableAvatars(avatars.data?.items ?? []), [avatars.data]);

  const [avatar, setAvatar] = useState<Avatar | null>(null);
  const [voiceId, setVoiceId] = useState<string | undefined>(undefined);
  const [aspect, setAspect] = useState<AspectRatio>('16:9');
  const [subtitles, setSubtitles] = useState(true);

  // Start from the default presenter and the default voice of the script language.
  useEffect(() => {
    if (avatar === null && choices.length > 0) {
      setAvatar(choices.find((a) => a.id === DEFAULT_STOCK_AVATAR_ID) ?? choices[0] ?? null);
    }
  }, [avatar, choices]);
  const voiceList = voices.data?.items;
  useEffect(() => {
    if (!voiceList) return;
    if (voiceId === undefined || !voiceList.some((voice) => voice.id === voiceId)) {
      setVoiceId(defaultVoiceOf(voiceList, draft.language)?.id);
    }
  }, [voiceList, voiceId, draft.language]);

  const create = useApiMutation(api.videos.create, {
    invalidates: [api.videos.list],
    onSuccess: (video) => {
      onOpenChange(false);
      onCreated(video);
    },
    onError: (error: ApiError) => {
      const text = describe(error);
      toast.error(t('create.failed'), { description: text.message || text.title });
    },
  });

  const timing = draftTiming(draft);
  const ready = avatar !== null && voiceId !== undefined;
  const submit = () => {
    if (!avatar || !voiceId) return;
    create.mutate({
      body: {
        title: draft.title.trim(),
        source: 'script',
        composition: draftToComposition(draft, { avatarId: avatar.id, voiceId, aspect, subtitles }),
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!create.isPending}
      size="lg"
      title={t('create.title')}
      description={t('create.description', {
        count: draft.scenes.length,
        time: format.duration(timing.totalMs),
        language: languageShortName(draft.language, locale),
      })}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!ready}>
            {t('create.submit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {avatars.isPending ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="aspect-square" />
            ))}
          </div>
        ) : avatars.isError ? (
          <ErrorState
            size="sm"
            error={avatars.error}
            onRetry={() => void avatars.refetch()}
            retrying={avatars.isRefetching}
          />
        ) : (
          <AvatarPicker
            legend={t('create.avatar')}
            avatars={choices}
            value={avatar?.id ?? null}
            onChange={setAvatar}
          />
        )}

        <VoiceSelect
          label={t('create.voice')}
          hint={t('create.voiceHint', { language: languageShortName(draft.language, locale) })}
          language={draft.language}
          value={voiceId}
          onValueChange={(next) => setVoiceId(next)}
        />

        <div>
          <p aria-hidden="true" className="mb-1.5 text-sm font-semibold">
            {t('create.aspect')}
          </p>
          <SegmentedControl<AspectRatio>
            aria-label={t('create.aspect')}
            value={aspect}
            onValueChange={setAspect}
            options={ASPECTS.map((value) => ({
              value,
              label: t(`create.aspects.${ASPECT_KEYS[value]}`),
            }))}
          />
        </div>

        <Switch
          checked={subtitles}
          onCheckedChange={setSubtitles}
          label={t('create.subtitles')}
          description={t('create.subtitlesHint')}
        />

        {avatar?.rendering === 'photoreal' && <Notice tone="info">{t('create.photoreal')}</Notice>}
        <Notice>{t('create.draftNote')}</Notice>
      </div>
    </Dialog>
  );
}
