import type { RouteDef } from '@parlante/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApiQuery } from '../api/hooks';
import type { ApiQueryOptions } from '../api/hooks';
import type { RouteArgs, RouteResult } from '../api/client';
import type { ApiError } from '../api/errors';
import { EtaEstimator } from './eta';
import { isJobActive, isJobSettled, jobPhaseOf } from './status';
import type { JobPhase } from './status';

/** What the hook needs to read from the polled resource. */
export interface JobSnapshot {
  /** Raw status word of the resource (`rendering`, `processing`, `completed`…). */
  status: string | null | undefined;
  /** 0..100 */
  progress?: number | null;
  /** Server-side estimate (measured). When null the hook estimates from the progress rate. */
  etaSec?: number | null;
}

export interface JobPollingOptions<R extends RouteDef> {
  /** Extract status/progress/eta from the resource. */
  select: (data: RouteResult<R>) => JobSnapshot;
  /** Poll interval while the job is active (default 1500 ms). */
  intervalMs?: number;
  enabled?: boolean;
  /** Fired once when the job goes from active to an end state while this hook is mounted. */
  onSettled?: (data: RouteResult<R>, phase: JobPhase) => void;
}

export interface JobPollingResult<R extends RouteDef> {
  data: RouteResult<R> | undefined;
  phase: JobPhase;
  /** 0..100 (100 once completed). */
  progress: number;
  /** Seconds remaining: server value, else estimated from the observed rate, else null. */
  etaSec: number | null;
  /** True when `etaSec` was estimated by the client instead of reported by the server. */
  etaEstimated: boolean;
  /** Seconds since this hook first saw the job active. */
  elapsedSec: number;
  isActive: boolean;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
}

/**
 * Poll a resource that represents an asynchronous job until it settles.
 *
 *   const job = useJobPolling(api.videos.get, { params: { videoId } }, {
 *     select: (v) => ({ status: v.status, progress: v.progress, etaSec: v.renderEtaSec }),
 *     onSettled: () => toast.success(t('rendered')),
 *   });
 *   <JobStatus phase={job.phase} progress={job.progress} etaSec={job.etaSec} />
 */
export function useJobPolling<R extends RouteDef>(
  route: R,
  ...args: RouteArgs<R, JobPollingOptions<R>>
): JobPollingResult<R> {
  const [input, options] = args;
  if (!options) throw new Error('useJobPolling needs options with a `select` function');
  const { select, intervalMs = 1500, enabled = true, onSettled } = options;

  const selectRef = useRef(select);
  selectRef.current = select;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const queryOptions: ApiQueryOptions<R> = {
    enabled,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return query.state.status === 'error' ? false : intervalMs;
      return isJobActive(jobPhaseOf(selectRef.current(data).status)) ? intervalMs : false;
    },
    refetchIntervalInBackground: false,
  };
  const query = useApiQuery<R>(
    route,
    ...([input, queryOptions] as unknown as RouteArgs<R, ApiQueryOptions<R>>),
  );

  const snapshot = query.data === undefined ? undefined : select(query.data);
  const phase = jobPhaseOf(snapshot?.status);
  const active = isJobActive(phase);
  const progress =
    phase === 'completed' ? 100 : Math.min(100, Math.max(0, snapshot?.progress ?? 0));

  const estimator = useRef(new EtaEstimator());
  const startedAt = useRef<number | null>(null);
  const wasActive = useRef(false);
  const [clientEta, setClientEta] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Feed the estimator on every poll result.
  useEffect(() => {
    if (!active) {
      estimator.current.reset();
      setClientEta(null);
      return;
    }
    estimator.current.push({ t: performance.now(), progress });
    setClientEta(estimator.current.estimateSec());
  }, [active, progress, query.dataUpdatedAt]);

  // Elapsed clock while active.
  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      return;
    }
    startedAt.current ??= performance.now();
    const tick = () =>
      setElapsedSec(
        Math.round((performance.now() - (startedAt.current ?? performance.now())) / 1000),
      );
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [active]);

  // Fire onSettled once on the active → settled transition.
  const data = query.data;
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return;
    }
    if (wasActive.current && isJobSettled(phase) && data !== undefined) {
      wasActive.current = false;
      onSettledRef.current?.(data, phase);
    }
  }, [active, phase, data]);

  const serverEta = snapshot?.etaSec ?? null;
  const { refetch } = query;
  return useMemo(
    () => ({
      data,
      phase,
      progress,
      etaSec: active ? (serverEta ?? clientEta) : null,
      etaEstimated: active && serverEta === null && clientEta !== null,
      elapsedSec: active ? elapsedSec : 0,
      isActive: active,
      isLoading: query.isLoading,
      error: query.error,
      refetch: () => void refetch(),
    }),
    [
      data,
      phase,
      progress,
      active,
      serverEta,
      clientEta,
      elapsedSec,
      query.isLoading,
      query.error,
      refetch,
    ],
  );
}
