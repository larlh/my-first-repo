import type { VideoSummary } from '@parlante/shared';
import { Copy, Eye, MoreVertical, PenLine, Sparkles, SquarePen, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useFormat } from '@/lib/format';
import {
  Badge,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  ProgressBar,
  cn,
} from '@/ui';
import { ROUTES } from '../lib/routes';
import { useStoredErrorText } from '../lib/useStoredErrorText';
import { cardDurationMs, isVideoActive } from '../lib/video';
import type { VideoActions } from './useVideoActions';
import { VideoPoster } from './VideoPoster';
import { VideoStatusBadge } from './VideoStatusBadge';

export interface VideoCardProps {
  video: VideoSummary;
  /** Rename / duplicate / delete. Omit (or pass `canEdit={false}`) for read-only cards. */
  actions?: VideoActions;
  canEdit?: boolean;
  /** The Studio is mounted in this build: offer "edit". */
  studioAvailable?: boolean;
  className?: string;
}

/**
 * One video in a grid: poster with duration, title, status and — while it renders — live
 * progress with the current stage. The whole card opens the detail; the menu holds the rest.
 */
export function VideoCard({
  video,
  actions,
  canEdit = false,
  studioAvailable = false,
  className,
}: VideoCardProps) {
  const { t } = useTranslation('videos');
  const format = useFormat();
  const navigate = useNavigate();
  const describeError = useStoredErrorText();
  const active = isVideoActive(video);
  const percent = Math.round(Math.min(100, Math.max(0, video.progress)));
  const editable = canEdit && actions !== undefined;

  const stage =
    video.status === 'queued'
      ? t('progress.queued')
      : video.renderStage
        ? t(`stage.${video.renderStage}`)
        : t('progress.starting');
  const eta =
    video.status === 'rendering' && video.renderEtaSec !== null && video.renderEtaSec > 1
      ? t('progress.eta', { time: format.duration(video.renderEtaSec * 1000) })
      : null;

  return (
    <article
      className={cn(
        'group relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xs',
        'transition-[box-shadow,border-color,transform] duration-200 ease-out-expo',
        'focus-within:border-line-strong hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md',
        className,
      )}
    >
      <VideoPoster
        thumbnailUrl={video.thumbnailUrl}
        aspect={video.aspect}
        durationMs={cardDurationMs(video)}
      >
        <div className="absolute top-2 left-2 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1.5">
          <VideoStatusBadge status={video.status} size="sm" className="shadow-sm" />
          {video.usesPhotorealAvatars && (
            <Badge tone="saffron" size="sm" icon={<Sparkles aria-hidden="true" />}>
              {t('card.photoreal')}
            </Badge>
          )}
        </div>
        {video.aspect !== '16:9' && (
          <span className="nums absolute bottom-2 left-2 rounded-xs bg-media/85 px-1.5 py-0.5 font-mono text-2xs font-medium text-on-media">
            {video.aspect}
          </span>
        )}
      </VideoPoster>

      <div className="flex items-start gap-1 px-3.5 pt-3 pb-3.5">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base leading-6">
            <Link
              to={ROUTES.video(video.id)}
              className="rounded-xs outline-offset-4 after:absolute after:inset-0 after:content-['']"
            >
              {video.title}
            </Link>
          </h3>
          <p className="mt-0.5 truncate text-xs text-fg-muted">
            {t('card.updated', { when: format.relative(video.updatedAt) })}
            {video.createdBy ? ` · ${video.createdBy.name}` : ''}
          </p>
        </div>
        {editable && (
          <Menu>
            <MenuTrigger asChild>
              <IconButton
                label={t('card.menu', { title: video.title })}
                size="sm"
                noTooltip
                className="relative z-10 -mt-0.5 -mr-1.5"
                loading={actions.duplicatingId === video.id}
              >
                <MoreVertical aria-hidden="true" />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem
                icon={<Eye aria-hidden="true" />}
                onSelect={() => void navigate(ROUTES.video(video.id))}
              >
                {t('actions.open')}
              </MenuItem>
              {studioAvailable && (
                <MenuItem
                  icon={<SquarePen aria-hidden="true" />}
                  onSelect={() => void navigate(ROUTES.studio(video.id))}
                >
                  {t('actions.edit')}
                </MenuItem>
              )}
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
        )}
      </div>

      {active && (
        <div className="border-t border-line px-3.5 py-3">
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 truncate font-medium text-fg">{stage}</span>
            <span className="nums shrink-0 text-fg-muted">
              {video.status === 'rendering' ? `${percent} %` : null}
              {eta ? ` · ${eta}` : ''}
            </span>
          </div>
          <ProgressBar
            size="sm"
            label={t('progress.label', { title: video.title })}
            value={video.status === 'queued' ? null : percent}
            valueText={[`${percent} %`, stage, eta].filter(Boolean).join(', ')}
            tone={video.status === 'queued' ? 'saffron' : 'accent'}
          />
        </div>
      )}

      {video.status === 'failed' && video.error && (
        <p className="border-t border-line px-3.5 py-2.5 text-xs text-danger-text">
          {describeError(video.error).title}
        </p>
      )}
    </article>
  );
}
