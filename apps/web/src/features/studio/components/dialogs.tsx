import { TEMPLATE_CATEGORIES, resolutionAllowed, usesPhotorealAvatars } from '@parlante/shared';
import type { Resolution, TemplateCategory } from '@parlante/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Clapperboard, Download, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { JobStatus } from '@/components/JobStatus';
import { PhotorealNotice, RenderSettings, renderGate } from '@/components/RenderSettings';
import { api, apiClient, apiQueryKey, downloadUrl, useApiMutation } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useJobPolling } from '@/lib/jobs';
import { useSession } from '@/lib/session';
import { PATHS, hasRoute, useRegistry } from '@/shell';
import {
  Button,
  Dialog,
  Input,
  Select,
  Textarea,
  toast,
  useErrorText,
  useServerMessage,
} from '@/ui';
import { quoteRender } from '../model/timing';
import { selectComposition, useEditor, usePreviewState, useStudio } from '../state/context';

interface DialogState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ErrorNote({ error, title }: { error: unknown; title?: string }) {
  const describe = useErrorText();
  const text = describe(error);
  return (
    <div role="alert" className="rounded-lg bg-danger-soft p-3.5 text-sm text-danger-text">
      <p className="font-semibold">{title ?? text.title}</p>
      {(title ? (text.message ?? text.title) : text.message) && (
        <p className="mt-0.5 break-words">{title ? (text.message ?? text.title) : text.message}</p>
      )}
    </div>
  );
}

/**
 * Render: resolution, credit cost, honest time notice for photorealistic avatars, then live
 * progress of the job and the link to the finished video. The sequence (moderation, limits,
 * charge, queue) is the API's; its refusals are shown as they come.
 */
export function RenderDialog({ open, onOpenChange }: DialogState) {
  const { t } = useTranslation('studio');
  const { t: tShell } = useTranslation('shell');
  const billing = hasRoute(useRegistry(), PATHS.billing);
  const format = useFormat();
  const session = useSession();
  const client = useQueryClient();
  const serverMessage = useServerMessage();
  const { video, saver, save, library } = useStudio();
  const composition = useEditor(selectComposition);
  const { timeline } = usePreviewState();
  const [resolution, setResolution] = useState<Resolution>('720p');
  const [error, setError] = useState<unknown>(null);
  const [showResult, setShowResult] = useState(false);
  const [starting, setStarting] = useState(false);
  const videoKey = apiQueryKey(api.videos.get, { params: { videoId: video.id } });

  // Polls GET /api/videos/:id while a render is queued or running (also with the dialog closed).
  const job = useJobPolling(
    api.videos.get,
    { params: { videoId: video.id } },
    {
      select: (v) => ({ status: v.status, progress: v.progress, etaSec: v.renderEtaSec }),
      onSettled: (finished, phase) => {
        setShowResult(true);
        void session.refresh();
        if (phase === 'completed') {
          toast.success(t('render.doneToast'), {
            action: { label: t('render.open'), onClick: () => onOpenChange(true) },
          });
        } else if (phase === 'failed') {
          toast.error(t('render.failedToast'), {
            description: serverMessage(finished.error?.message, {
              code: finished.error?.code,
              reason: finished.error?.reason,
            }),
          });
        }
      },
    },
  );

  const cancel = useApiMutation(api.videos.cancelRender, {
    onSuccess: (canceled) => {
      client.setQueryData(videoKey, canceled);
      void session.refresh();
      setShowResult(false);
    },
    onError: setError,
  });

  useEffect(() => {
    if (!open) return;
    setError(null);
    setResolution(
      video.resolution && resolutionAllowed(session.plan.id, video.resolution)
        ? video.resolution
        : '720p',
    );
    void saver.flush();
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const photoreal = usesPhotorealAvatars(composition);
  const audioDurations: Record<string, number> = {};
  for (const scene of composition.scenes) {
    if (scene.script.kind !== 'audio') continue;
    const length = library.media(`asset:${scene.script.assetId}`)?.durationMs;
    if (length) audioDurations[scene.script.assetId] = length;
  }
  // `credits` is what the render will cost; the API may hold one 30 s step more (or less)
  // while it runs, because it prices its estimate: the balance has to cover both.
  const quote = quoteRender(composition, timeline.totalMs, resolution, audioDurations);
  const gate = renderGate({
    plan: session.plan.id,
    balance: session.credits,
    resolution,
    cost: quote,
  });
  const active = job.isActive || video.status === 'queued' || video.status === 'rendering';
  const upToDate =
    video.status === 'completed' &&
    video.videoUrl !== null &&
    video.renderedRevision === save.baseRevision &&
    save.status === 'saved';
  const failed = video.status === 'failed' && showResult;
  const view = active ? 'progress' : failed ? 'failed' : upToDate && showResult ? 'done' : 'form';
  const limits = session.plan.limits;
  const tooLong = timeline.totalMs > limits.maxVideoDurationSec * 1000;
  const tooManyScenes = composition.scenes.length > limits.maxScenesPerVideo;

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      // The API renders what it has stored: everything must be saved first.
      if (!(await saver.flush())) {
        setError(new Error(t('render.saveFirst')));
        return;
      }
      const started = await apiClient.videos.render({
        params: { videoId: video.id },
        body: { resolution },
      });
      client.setQueryData(videoKey, started.video);
      void session.refresh();
      job.refetch();
    } catch (err) {
      setError(err);
    } finally {
      setStarting(false);
    }
  };

  const footer =
    view === 'progress' ? (
      <>
        <Button
          variant="ghost"
          loading={cancel.isPending}
          onClick={() => cancel.mutate({ params: { videoId: video.id } })}
        >
          {t('render.cancel')}
        </Button>
        <Button onClick={() => onOpenChange(false)}>{t('render.keepEditing')}</Button>
      </>
    ) : view === 'done' ? (
      <>
        <Button variant="ghost" onClick={() => setShowResult(false)}>
          {t('render.again')}
        </Button>
        {video.downloadUrl && (
          <Button
            leftIcon={<Download aria-hidden="true" />}
            onClick={() => video.downloadUrl && downloadUrl(video.downloadUrl)}
          >
            {t('render.download')}
          </Button>
        )}
        <Button asChild variant="primary" rightIcon={<ExternalLink aria-hidden="true" />}>
          <Link to={`/videos/${video.id}`}>{t('render.view')}</Link>
        </Button>
      </>
    ) : view === 'failed' ? (
      <>
        <Button onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        <Button variant="primary" onClick={() => setShowResult(false)}>
          {t('render.retry')}
        </Button>
      </>
    ) : (
      <>
        <Button onClick={() => onOpenChange(false)} disabled={starting}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          leftIcon={<Clapperboard aria-hidden="true" />}
          loading={starting}
          disabled={gate.blocked || save.status === 'conflict'}
          onClick={() => void start()}
        >
          {tShell('render.start')}
        </Button>
      </>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={view === 'form' ? tShell('render.title') : t(`render.title.${view}`)}
      description={view === 'form' ? t('render.text') : undefined}
      dismissible={!starting}
      footer={footer}
    >
      {view === 'progress' && (
        <div className="flex flex-col gap-4">
          <JobStatus
            label={t('render.progressLabel', { title: video.title })}
            status={job.phase === 'idle' ? video.status : job.phase}
            progress={job.progress}
            etaSec={job.etaSec}
            etaEstimated={job.etaEstimated}
            stage={video.renderStage ? t(`render.stage.${video.renderStage}`) : undefined}
          />
          {video.usesPhotorealAvatars && (
            <PhotorealNotice engine={library.avatarEngine} durationMs={timeline.totalMs} />
          )}
          <p className="text-sm text-fg-muted">{t('render.progressText')}</p>
          {error !== null && <ErrorNote error={error} />}
        </div>
      )}
      {view === 'done' && (
        <div className="flex items-start gap-3">
          <CircleCheck className="mt-0.5 size-6 shrink-0 text-success" aria-hidden="true" />
          <div className="min-w-0 text-sm">
            <p className="font-semibold">{t('render.doneTitle')}</p>
            <p className="mt-0.5 text-fg-muted">
              {t('render.doneText', {
                resolution: video.resolution ?? '',
                duration: format.duration(video.durationMs ?? 0),
              })}
            </p>
          </div>
        </div>
      )}
      {view === 'failed' && (
        <ErrorNote
          title={t('render.failedTitle')}
          error={
            video.error
              ? Object.assign(new Error(video.error.message), {
                  code: video.error.code,
                  reason: video.error.reason,
                })
              : new Error(t('render.failedToast'))
          }
        />
      )}
      {view === 'form' && (
        <RenderSettings
          resolution={resolution}
          onResolutionChange={setResolution}
          durationMs={timeline.totalMs}
          cost={quote}
          photoreal={photoreal}
          engine={library.avatarEngine}
          error={error}
          billingPath={billing ? PATHS.billing : null}
        >
          {video.videoUrl && !upToDate && (
            <p className="text-sm text-fg-muted">{t('render.outdated')}</p>
          )}
          {(tooLong || tooManyScenes) && (
            <p role="alert" className="rounded-lg bg-warning-soft p-3 text-sm text-warning-text">
              {tooLong
                ? t('video.tooLong', {
                    duration: format.duration(timeline.totalMs),
                    max: format.duration(limits.maxVideoDurationSec * 1000),
                    plan: session.plan.name,
                  })
                : t('scenes.planLimit', {
                    count: limits.maxScenesPerVideo,
                    plan: session.plan.name,
                  })}
            </p>
          )}
        </RenderSettings>
      )}
    </Dialog>
  );
}

/** "Save as template": the current composition becomes a custom workspace template. */
export function SaveTemplateDialog({ open, onOpenChange }: DialogState) {
  const { t } = useTranslation('studio');
  const { video, saver, store } = useStudio();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<TemplateCategory>('other');
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(store.getState().history.present.title.slice(0, 120));
    setDescription('');
    setCategory('other');
    setError(null);
  }, [open, store]);

  const submit = async () => {
    setError(null);
    setPending(true);
    try {
      if (!(await saver.flush())) throw new Error(t('render.saveFirst'));
      const template = await apiClient.videos.saveAsTemplate({
        params: { videoId: video.id },
        body: { name: name.trim(), description: description.trim(), category },
      });
      toast.success(t('template.saved', { name: template.name }));
      onOpenChange(false);
    } catch (err) {
      setError(err as ApiError | Error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('template.title')}
      description={t('template.text')}
      dismissible={!pending}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={name.trim() === ''}
            onClick={() => void submit()}
          >
            {t('template.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '') void submit();
        }}
      >
        <Input
          label={t('template.name')}
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Textarea
          label={t('template.description')}
          rows={3}
          maxLength={300}
          showCount
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <Select
          label={t('template.category')}
          value={category}
          onValueChange={setCategory}
          options={TEMPLATE_CATEGORIES.map((value) => ({
            value,
            label: t(`template.categories.${value}`),
          }))}
        />
        {error && <ErrorNote error={error} />}
      </form>
    </Dialog>
  );
}

const SHORTCUTS: { keys: string[]; id: string }[] = [
  { keys: ['Space'], id: 'play' },
  { keys: ['Shift', 'Space'], id: 'playScene' },
  { keys: ['Ctrl', 'Z'], id: 'undo' },
  { keys: ['Ctrl', 'Shift', 'Z'], id: 'redo' },
  { keys: ['Ctrl', 'S'], id: 'save' },
  { keys: ['Ctrl', 'D'], id: 'duplicate' },
  { keys: ['Supr'], id: 'delete' },
  { keys: ['← ↑ ↓ →'], id: 'nudge' },
  { keys: ['Shift', '← ↑ ↓ →'], id: 'nudgeBig' },
  { keys: ['[', ']'], id: 'order' },
  { keys: ['Re Pág', 'Av Pág'], id: 'scenes' },
  { keys: ['Esc'], id: 'deselect' },
  { keys: ['Shift'], id: 'ratio' },
  { keys: ['Alt'], id: 'noSnap' },
  { keys: ['Ctrl', 'Enter'], id: 'render' },
];

export function ShortcutsDialog({ open, onOpenChange }: DialogState) {
  const { t } = useTranslation('studio');
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('shortcuts.title')} size="md">
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-5 gap-y-2.5 text-sm">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.id} className="contents">
            <dt className="flex gap-1">
              {shortcut.keys.map((key) => (
                <kbd
                  key={key}
                  className="rounded-sm border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-xs"
                >
                  {key}
                </kbd>
              ))}
            </dt>
            <dd className="text-fg-muted">{t(`shortcuts.${shortcut.id}`)}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

/**
 * Revision conflict: the video changed elsewhere since this editor last saved. Nothing is
 * overwritten until the user chooses which version to keep.
 */
export function ConflictDialog() {
  const { t } = useTranslation('studio');
  const client = useQueryClient();
  const { video, save, saver, store } = useStudio();
  const [pending, setPending] = useState<'mine' | 'theirs' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const open = save.status === 'conflict';

  const resolve = async (choice: 'mine' | 'theirs') => {
    setPending(choice);
    setError(null);
    try {
      const latest = await apiClient.videos.get({ params: { videoId: video.id } });
      client.setQueryData(apiQueryKey(api.videos.get, { params: { videoId: video.id } }), latest);
      if (choice === 'mine') {
        await saver.resolveConflict('overwrite', latest.revision);
      } else {
        store.getState().reset({ title: latest.title, composition: latest.composition });
        saver.adopt(latest.revision);
        toast.info(t('conflict.loaded'));
      }
    } catch (err) {
      setError(err);
    } finally {
      setPending(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={() => undefined}
      dismissible={false}
      title={t('conflict.title')}
      description={t('conflict.text')}
      footer={
        <>
          <Button
            loading={pending === 'theirs'}
            disabled={pending !== null}
            onClick={() => void resolve('theirs')}
          >
            {t('conflict.theirs')}
          </Button>
          <Button
            variant="primary"
            loading={pending === 'mine'}
            disabled={pending !== null}
            onClick={() => void resolve('mine')}
          >
            {t('conflict.mine')}
          </Button>
        </>
      }
    >
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-fg-muted">
        <li>{t('conflict.mineHint')}</li>
        <li>{t('conflict.theirsHint')}</li>
      </ul>
      {error !== null && (
        <div className="mt-4">
          <ErrorNote error={error} />
        </div>
      )}
    </Dialog>
  );
}
