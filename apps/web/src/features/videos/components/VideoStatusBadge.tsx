import type { VideoStatus } from '@parlante/shared';
import { useTranslation } from 'react-i18next';
import { JobStatusBadge } from '@/components/JobStatus';

/** Status pill of a video with the words of this feature ("Borrador", "Renderizando"…). */
export function VideoStatusBadge({
  status,
  size,
  className,
}: {
  status: VideoStatus;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { t } = useTranslation('videos');
  return (
    <JobStatusBadge
      status={status}
      size={size}
      className={className}
      labels={{
        idle: t('status.draft'),
        queued: t('status.queued'),
        running: t('status.rendering'),
        completed: t('status.completed'),
        failed: t('status.failed'),
      }}
    />
  );
}
