import { languageName } from '@parlante/shared';
import type { Video } from '@parlante/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Clapperboard,
  Copy,
  FileQuestion,
  History,
  Languages,
  MoreHorizontal,
  PenLine,
  SquarePen,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { JobStatus } from '@/components/JobStatus';
import { VideoPlayer } from '@/components/VideoPlayer';
import type { VideoPlayerHandle } from '@/components/VideoPlayer';
import { api, apiQueryKey, useApiMutation, useInvalidateApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { currentLocale } from '@/lib/i18n';
import { useJobPolling } from '@/lib/jobs';
import { useSession } from '@/lib/session';
import { DocumentTitle } from '@/shell';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  PageHeader,
  Skeleton,
  cn,
  toast,
  useErrorText,
} from '@/ui';
import { DownloadsPanel } from './components/DownloadsPanel';
import { ProvidersPanel } from './components/ProvidersPanel';
import { RenderDialog } from './components/RenderDialog';
import { RenderHistory } from './components/RenderHistory';
import { SharePanel } from './components/SharePanel';
import { TranscriptPanel } from './components/TranscriptPanel';
import { useVideoActions } from './components/useVideoActions';
import { VideoPoster } from './components/VideoPoster';
import { VideoStatusBadge } from './components/VideoStatusBadge';
import { ROUTES, useAvailableRoutes } from './lib/routes';
import { useStableMedia } from './lib/useStableMedia';
import { useStoredErrorText } from './lib/useStoredErrorText';
import { isOutdated, isVideoActive, narrationLanguage } from './lib/video';

/** Width of the stage for each shape, so vertical videos do not fill the whole screen height. */
const STAGE_WIDTH = {
  '16:9': 'w-full',
  '1:1': 'mx-auto w-full max-w-xl',
  '9:16': 'mx-auto w-full max-w-[22rem]',
} as const;

function DetailSkeleton() {
  return (
    <div aria-hidden="true">
      <Skeleton className="mb-3 h-4 w-24" />
      <Skeleton className="mb-8 h-10 w-2/3 max-w-md" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_23rem]">
        <Skeleton className="aspect-video h-auto rounded-lg" />
        <div className="flex flex-col gap-5">
          <Skeleton className="h-36 rounded-lg" />
          <Skeleton className="h-44 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

function Notice({
  tone,
  icon,
  title,
  children,
  action,
}: {
  tone: 'warning' | 'danger';
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex flex-col gap-3 rounded-lg p-4 sm:flex-row sm:items-center',
        tone === 'danger' ? 'bg-danger-soft text-danger-text' : 'bg-warning-soft text-warning-text',
      )}
    >
      <span className="flex min-w-0 flex-1 gap-3">
        <span className="mt-0.5 shrink-0 [&_svg]:size-[1.125rem]" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0 text-sm">
          <span className="block font-semibold">{title}</span>
          {children && <span className="mt-0.5 block break-words">{children}</span>}
        </span>
      </span>
      {action && <span className="shrink-0">{action}</span>}
    </div>
  );
}

function Details({ video }: { video: Video }) {
  const { t } = useTranslation('videos');
  const format = useFormat();
  const rows: [string, ReactNode][] = [
    [t('details.format'), `${video.aspect}${video.resolution ? ` · ${video.resolution}` : ''}`],
    [
      video.durationMs ? t('details.duration') : t('details.estimatedDuration'),
      format.duration(
        Math.max(1000, Math.round((video.durationMs ?? video.estimatedDurationMs) / 1000) * 1000),
      ),
    ],
    [t('details.scenes'), format.number(video.composition.scenes.length)],
    [t('details.source'), t(`source.${video.source}`)],
    ...(video.createdBy
      ? [[t('details.createdBy'), video.createdBy.name] as [string, ReactNode]]
      : []),
    [t('details.created'), format.dateTime(video.createdAt)],
    [t('details.updated'), format.relative(video.updatedAt)],
    ...(video.renderedAt
      ? [[t('details.rendered'), format.dateTime(video.renderedAt)] as [string, ReactNode]]
      : []),
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('details.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="nums truncate text-right font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/** One video: player or render progress, transcript, downloads, sharing and provenance. */
export default function VideoDetailPage() {
  const { t } = useTranslation('videos');
  const { videoId = '' } = useParams();
  const navigate = useNavigate();
  const session = useSession();
  const format = useFormat();
  const client = useQueryClient();
  const invalidate = useInvalidateApi();
  const describe = useErrorText();
  const describeStored = useStoredErrorText();
  const available = useAvailableRoutes();
  const canEdit = session.can('editor');

  const [renderOpen, setRenderOpen] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const player = useRef<VideoPlayerHandle | null>(null);
  // A cancelled render falls back to the previous output: that is not "render finished".
  const canceled = useRef(false);

  const job = useJobPolling(
    api.videos.get,
    { params: { videoId } },
    {
      select: (data) => ({
        status: data.status,
        progress: data.progress,
        etaSec: data.renderEtaSec,
      }),
      onSettled: (data, phase) => {
        void invalidate(api.videos.list, api.videos.renderJobs, api.billing.overview);
        void session.refresh();
        if (canceled.current) {
          canceled.current = false;
          return;
        }
        if (phase === 'completed') toast.success(t('render.done', { title: data.title }));
        else if (phase === 'failed') toast.error(t('render.failedToast', { title: data.title }));
      },
    },
  );
  const video = job.data;
  // Frozen per render so a background refetch (new signatures) never restarts playback.
  const media = useStableMedia(`${videoId}|${video?.renderedAt ?? ''}`, {
    videoUrl: video?.videoUrl ?? null,
    thumbnailUrl: video?.thumbnailUrl ?? null,
    vttUrl: video?.vttUrl ?? null,
    downloadUrl: video?.downloadUrl ?? null,
  });
  const lang = (video ? narrationLanguage(video.composition) : null) ?? currentLocale();
  const subtitles = useMemo(
    () =>
      media.vttUrl
        ? [{ lang, label: languageName(lang, currentLocale()), src: media.vttUrl }]
        : undefined,
    [media.vttUrl, lang],
  );
  const setCached = (next: Video) =>
    client.setQueryData(apiQueryKey(api.videos.get, { params: { videoId } }), next);

  const cancel = useApiMutation(api.videos.cancelRender, {
    invalidates: [api.videos.list, api.videos.renderJobs, api.billing.overview],
    onMutate: () => {
      canceled.current = true;
    },
    onSuccess: (next) => {
      setCached(next);
      void session.refresh();
      toast.success(t('render.canceled'));
    },
    onError: (error) => {
      canceled.current = false;
      toast.error(t('render.cancelFailed'), { description: describe(error).title });
    },
  });

  const actions = useVideoActions({
    onRemoved: () => void navigate(ROUTES.videos, { replace: true }),
    onDuplicated: (copy) => {
      toast.success(t('duplicate.done', { title: copy.title }));
      void navigate(ROUTES.video(copy.id));
    },
  });

  if (!video) {
    if (job.error) {
      const missing = job.error.is('NOT_FOUND', 'VALIDATION_ERROR');
      return missing ? (
        <EmptyState
          icon={<FileQuestion />}
          title={t('detail.notFoundTitle')}
          description={t('detail.notFoundText')}
          action={
            <Button asChild variant="primary">
              <Link to={ROUTES.videos}>{t('detail.backToList')}</Link>
            </Button>
          }
        />
      ) : (
        <ErrorState error={job.error} onRetry={job.refetch} />
      );
    }
    return <DetailSkeleton />;
  }

  const active = isVideoActive(video);
  const outdated = isOutdated(video);
  const hasOutput = video.videoUrl !== null;
  const subtitlesUrl = video.vttUrl ?? video.srtUrl;
  const failure = video.status === 'failed' && video.error ? describeStored(video.error) : null;

  // One loud action in the header: the next sensible step for the state of the video.
  const renderIsPrimary = outdated || (!hasOutput && !available.studio);
  const editButton =
    canEdit && available.studio ? (
      <Button
        asChild
        variant={!hasOutput && !active ? 'primary' : 'secondary'}
        leftIcon={<SquarePen aria-hidden="true" />}
      >
        <Link to={ROUTES.studio(video.id)}>{t('actions.edit')}</Link>
      </Button>
    ) : null;
  const renderButton =
    canEdit && !active ? (
      <Button
        variant={renderIsPrimary ? 'primary' : 'secondary'}
        leftIcon={<Clapperboard aria-hidden="true" />}
        onClick={() => setRenderOpen(true)}
      >
        {hasOutput ? t('actions.renderAgain') : t('actions.render')}
      </Button>
    ) : null;

  return (
    <>
      <DocumentTitle title={video.title} />
      <PageHeader
        back={{ to: ROUTES.videos, label: t('list.title') }}
        title={video.title}
        meta={
          <>
            <VideoStatusBadge status={video.status} />
            {outdated && !active && <Badge tone="warning">{t('detail.outdated')}</Badge>}
            {video.usesPhotorealAvatars && (
              <Badge tone="saffron" icon={<Bot aria-hidden="true" />}>
                {t('providers.aiGenerated')}
              </Badge>
            )}
          </>
        }
        actions={
          canEdit ? (
            <>
              {editButton}
              {renderButton}
              <Menu>
                <MenuTrigger asChild>
                  <IconButton
                    label={t('detail.more')}
                    variant="secondary"
                    loading={actions.duplicatingId === video.id}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </IconButton>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem
                    icon={<PenLine aria-hidden="true" />}
                    onSelect={() => actions.rename(video)}
                  >
                    {t('actions.rename')}
                  </MenuItem>
                  <MenuItem
                    icon={<Copy aria-hidden="true" />}
                    onSelect={() => actions.duplicate(video)}
                  >
                    {t('actions.duplicate')}
                  </MenuItem>
                  {hasOutput && available.translate && (
                    <MenuItem
                      icon={<Languages aria-hidden="true" />}
                      onSelect={() => void navigate(ROUTES.translateVideo(video.id))}
                    >
                      {t('actions.translate')}
                    </MenuItem>
                  )}
                  <MenuSeparator />
                  <MenuItem
                    tone="danger"
                    icon={<Trash2 aria-hidden="true" />}
                    onSelect={() => actions.remove(video)}
                  >
                    {t('actions.delete')}
                  </MenuItem>
                </MenuContent>
              </Menu>
            </>
          ) : null
        }
      />

      {/* Phones read top to bottom: stage, then downloads and sharing, then the history. From
          `lg` the history moves under the stage and the panels become a side column. */}
      <div className="grid gap-x-6 gap-y-5 lg:grid-cols-[minmax(0,1fr)_23rem] lg:grid-rows-[auto_1fr] lg:items-start">
        <div className="flex min-w-0 flex-col gap-5">
          {failure && (
            <Notice
              tone="danger"
              icon={<TriangleAlert />}
              title={t('detail.failedTitle', { reason: failure.title })}
              action={
                canEdit ? (
                  <Button size="sm" onClick={() => setRenderOpen(true)}>
                    {t('detail.retryRender')}
                  </Button>
                ) : undefined
              }
            >
              {failure.detail}
            </Notice>
          )}
          {outdated && !active && !failure && (
            <Notice
              tone="warning"
              icon={<History />}
              title={t('detail.outdatedTitle')}
              action={
                canEdit ? (
                  <Button size="sm" onClick={() => setRenderOpen(true)}>
                    {t('actions.renderAgain')}
                  </Button>
                ) : undefined
              }
            >
              {t('detail.outdatedText')}
            </Notice>
          )}

          <div className={STAGE_WIDTH[video.aspect]}>
            {active ? (
              <div className="@container overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
                <VideoPoster
                  thumbnailUrl={video.thumbnailUrl}
                  aspect={video.aspect}
                  frame={video.aspect}
                  className="[&>img]:opacity-45"
                >
                  <div className="absolute inset-x-0 bottom-0 flex items-center gap-2.5 bg-gradient-to-t from-media/90 to-transparent px-4 pt-10 pb-3.5 text-sm font-semibold">
                    <span className="relative flex size-2.5">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-70" />
                      <span className="relative inline-flex size-2.5 rounded-full bg-accent" />
                    </span>
                    <span className="eyebrow">{t('detail.onAir')}</span>
                  </div>
                </VideoPoster>
                <div className="flex flex-col gap-3 p-4 sm:p-5">
                  <JobStatus
                    label={t('progress.label', { title: video.title })}
                    status={job.phase}
                    progress={job.progress}
                    etaSec={job.etaSec}
                    etaEstimated={job.etaEstimated}
                    stage={
                      video.renderStage ? t(`stage.${video.renderStage}`) : t('progress.starting')
                    }
                    labels={{ queued: t('status.queued'), running: t('status.rendering') }}
                  />
                  <div className="flex flex-col gap-3 @md:flex-row @md:items-center @md:justify-between">
                    <p className="min-w-0 flex-1 text-sm text-fg-muted">
                      {video.usesPhotorealAvatars
                        ? t('detail.renderingPhotoreal')
                        : t('detail.renderingHint')}
                      {job.elapsedSec >= 5
                        ? ` ${t('detail.elapsed', { time: format.duration(job.elapsedSec * 1000) })}`
                        : ''}
                    </p>
                    {canEdit && (
                      <Button
                        size="sm"
                        className="self-start"
                        leftIcon={<X aria-hidden="true" />}
                        loading={cancel.isPending}
                        onClick={() => cancel.mutate({ params: { videoId: video.id } })}
                      >
                        {t('actions.cancelRender')}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ) : video.videoUrl && media.videoUrl ? (
              <VideoPlayer
                key={video.renderedAt ?? video.id}
                src={media.videoUrl}
                title={video.title}
                poster={media.thumbnailUrl}
                aspect={video.aspect}
                subtitles={subtitles}
                // Burnt-in subtitles are already in the picture: the caption overlay starts off
                // so the same line is not drawn twice (it can still be turned on).
                defaultSubtitleLang={video.composition.subtitles.enabled ? null : undefined}
                downloadUrl={media.downloadUrl}
                onTimeUpdate={setCurrentMs}
                controls={player}
                className="shadow-md"
              />
            ) : (
              <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
                <VideoPoster
                  thumbnailUrl={video.thumbnailUrl}
                  aspect={video.aspect}
                  frame={video.aspect}
                />
                <div className="p-4 sm:p-5">
                  <h2 className="text-lg">{t('detail.draftTitle')}</h2>
                  <p className="mt-0.5 text-sm text-fg-muted">
                    {!canEdit
                      ? t('detail.draftTextViewer')
                      : available.studio
                        ? t('detail.draftText')
                        : t('detail.draftTextNoStudio')}
                  </p>
                </div>
              </div>
            )}
          </div>

          {!active && hasOutput && subtitlesUrl && (
            <TranscriptPanel
              videoId={video.id}
              subtitlesUrl={subtitlesUrl}
              renderedAt={video.renderedAt}
              currentMs={currentMs}
              lang={lang}
              onSeek={(ms) => player.current?.seek(ms, { play: true })}
            />
          )}
        </div>

        <aside
          className="flex min-w-0 flex-col gap-5 lg:col-start-2 lg:row-span-2 lg:row-start-1"
          aria-label={t('detail.sidebar')}
        >
          <DownloadsPanel video={video} />
          <SharePanel video={video} canEdit={canEdit} />
          <ProvidersPanel video={video} />
          <Details video={video} />
        </aside>

        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          <RenderHistory videoId={video.id} polling={active} />
        </div>
      </div>

      {canEdit && (
        <RenderDialog
          video={video}
          open={renderOpen}
          onOpenChange={setRenderOpen}
          billingAvailable={available.billing}
          onStarted={(started) => {
            setCached(started);
            job.refetch();
            toast.success(t('render.started'));
          }}
        />
      )}
      {actions.dialogs}
    </>
  );
}
