import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { useFormat } from '@/lib/format';
import { isJobActive, jobPhaseOf } from '@/lib/jobs/status';
import type { JobPhase } from '@/lib/jobs/status';
import { Badge } from '@/ui/Badge';
import type { BadgeTone } from '@/ui/Badge';
import { ProgressBar } from '@/ui/ProgressBar';

const TONES: Record<JobPhase, BadgeTone> = {
  idle: 'neutral',
  queued: 'saffron',
  running: 'accent',
  completed: 'success',
  partial: 'warning',
  failed: 'danger',
  canceled: 'neutral',
};

export interface JobStatusBadgeProps {
  /** A JobPhase, or the raw status word of any API resource (`rendering`, `processing`…). */
  status: JobPhase | string | null | undefined;
  /** Override the default text of a phase (e.g. `{ idle: t('draft') }`). */
  labels?: Partial<Record<JobPhase, ReactNode>>;
  size?: 'sm' | 'md';
  className?: string;
}

/** Status pill shared by every asynchronous resource. */
export function JobStatusBadge({ status, labels, size, className }: JobStatusBadgeProps) {
  const { t } = useTranslation('shell');
  const phase = jobPhaseOf(status);
  return (
    <Badge tone={TONES[phase]} dot pulse={isJobActive(phase)} size={size} className={className}>
      {labels?.[phase] ?? t(`job.phase.${phase}`)}
    </Badge>
  );
}

export interface JobStatusProps extends JobStatusBadgeProps {
  /** 0..100 */
  progress?: number | null;
  /** Seconds remaining, when known. */
  etaSec?: number | null;
  /** The ETA was extrapolated by the client (shown as approximate). */
  etaEstimated?: boolean;
  /** Human name of the current pipeline stage ("Generando audio"). */
  stage?: ReactNode;
  /** Failure reason (already translated or the stored error message). */
  error?: ReactNode;
  /** Accessible name of the progress bar ("Render de «Bienvenida»"). */
  label: string;
}

/**
 * Status + progress + time remaining of a job. Feed it from `useJobPolling`:
 *   <JobStatus label={video.title} status={job.phase} progress={job.progress}
 *              etaSec={job.etaSec} etaEstimated={job.etaEstimated} stage={t(`stage.${video.renderStage}`)} />
 */
export function JobStatus({
  status,
  labels,
  progress,
  etaSec,
  etaEstimated = false,
  stage,
  error,
  label,
  size,
  className,
}: JobStatusProps) {
  const { t } = useTranslation('shell');
  const format = useFormat();
  const phase = jobPhaseOf(status);
  const active = isJobActive(phase);
  const percent = Math.round(Math.min(100, Math.max(0, progress ?? 0)));

  let eta: string | null = null;
  if (phase === 'running') {
    if (etaSec === null || etaSec === undefined) eta = t('job.etaUnknown');
    else if (etaSec <= 1) eta = t('job.etaAlmost');
    else {
      eta = t(etaEstimated ? 'job.etaApprox' : 'job.eta', {
        time: format.duration(etaSec * 1000),
      });
    }
  } else if (phase === 'queued') {
    eta = t('job.waiting');
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <JobStatusBadge status={phase} labels={labels} size={size} />
        {active && stage && <span className="min-w-0 truncate text-sm text-fg">{stage}</span>}
        {active && (
          <span className="nums ml-auto shrink-0 text-sm text-fg-muted" aria-live="off">
            {phase === 'running' ? `${percent} %` : null}
            {phase === 'running' && eta ? ' · ' : ''}
            {eta}
          </span>
        )}
      </div>
      {active && (
        <ProgressBar
          label={label}
          value={phase === 'queued' ? null : percent}
          valueText={[`${percent} %`, eta].filter(Boolean).join(', ')}
          tone={phase === 'queued' ? 'saffron' : 'accent'}
        />
      )}
      {phase === 'failed' && error && (
        <p role="alert" className="text-sm break-words text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
