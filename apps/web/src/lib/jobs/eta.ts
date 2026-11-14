/**
 * Remaining-time estimate from observed progress, for jobs whose API resource does not report
 * an ETA. Keeps a short window of (time, progress) samples and extrapolates the recent rate.
 * Pure and clock-free: callers pass the timestamp.
 */
export interface ProgressSample {
  /** Milliseconds (any monotonic origin). */
  t: number;
  /** 0..100 */
  progress: number;
}

const WINDOW_MS = 30_000;
const MIN_SPAN_MS = 2_000;

export class EtaEstimator {
  private samples: ProgressSample[] = [];

  reset(): void {
    this.samples = [];
  }

  /** Record a sample. Progress going backwards (a new attempt) restarts the window. */
  push(sample: ProgressSample): void {
    const last = this.samples[this.samples.length - 1];
    if (last && sample.progress < last.progress) this.samples = [];
    if (last && sample.t <= last.t) return;
    this.samples.push(sample);
    const cutoff = sample.t - WINDOW_MS;
    while (this.samples.length > 2 && (this.samples[0]?.t ?? 0) < cutoff) this.samples.shift();
  }

  /** Estimated seconds remaining, or null while there is not enough signal. */
  estimateSec(): number | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last === first) return null;
    const span = last.t - first.t;
    const gained = last.progress - first.progress;
    if (span < MIN_SPAN_MS || gained <= 0) return null;
    if (last.progress >= 100) return 0;
    const ratePerMs = gained / span;
    return Math.max(1, Math.round((100 - last.progress) / ratePerMs / 1000));
  }
}
