import { describe, expect, it } from 'vitest';
import { EtaEstimator } from './eta';
import { isJobActive, isJobSettled, jobPhaseOf } from './status';

describe('jobPhaseOf', () => {
  it('maps the status words of every async resource to one vocabulary', () => {
    expect(jobPhaseOf('draft')).toBe('idle');
    expect(jobPhaseOf('queued')).toBe('queued');
    expect(jobPhaseOf('pending')).toBe('queued');
    expect(jobPhaseOf('rendering')).toBe('running');
    expect(jobPhaseOf('processing')).toBe('running');
    expect(jobPhaseOf('ready')).toBe('completed');
    expect(jobPhaseOf('completed')).toBe('completed');
    expect(jobPhaseOf('partial')).toBe('partial');
    expect(jobPhaseOf('failed')).toBe('failed');
    expect(jobPhaseOf('canceled')).toBe('canceled');
    expect(jobPhaseOf('something-new')).toBe('idle');
    expect(jobPhaseOf(null)).toBe('idle');
  });

  it('knows which phases are worth polling', () => {
    expect(isJobActive('queued')).toBe(true);
    expect(isJobActive('running')).toBe(true);
    expect(isJobActive('completed')).toBe(false);
    expect(isJobSettled('failed')).toBe(true);
    expect(isJobSettled('idle')).toBe(false);
  });
});

describe('EtaEstimator', () => {
  it('needs a couple of seconds of signal before estimating', () => {
    const eta = new EtaEstimator();
    expect(eta.estimateSec()).toBeNull();
    eta.push({ t: 0, progress: 0 });
    expect(eta.estimateSec()).toBeNull();
    eta.push({ t: 1000, progress: 2 });
    expect(eta.estimateSec()).toBeNull();
  });

  it('extrapolates the recent progress rate', () => {
    const eta = new EtaEstimator();
    eta.push({ t: 0, progress: 0 });
    eta.push({ t: 5_000, progress: 10 });
    // 10 % in 5 s → 90 % left takes 45 s
    expect(eta.estimateSec()).toBe(45);
    eta.push({ t: 10_000, progress: 50 });
    expect(eta.estimateSec()).toBe(10);
  });

  it('returns null while progress is stalled and 0 once complete', () => {
    const stalled = new EtaEstimator();
    stalled.push({ t: 0, progress: 30 });
    stalled.push({ t: 6_000, progress: 30 });
    expect(stalled.estimateSec()).toBeNull();

    const done = new EtaEstimator();
    done.push({ t: 0, progress: 60 });
    done.push({ t: 4_000, progress: 100 });
    expect(done.estimateSec()).toBe(0);
  });

  it('restarts when progress goes backwards (new attempt) and forgets old samples', () => {
    const eta = new EtaEstimator();
    eta.push({ t: 0, progress: 80 });
    eta.push({ t: 5_000, progress: 90 });
    eta.push({ t: 6_000, progress: 5 });
    expect(eta.estimateSec()).toBeNull();

    const windowed = new EtaEstimator();
    windowed.push({ t: 0, progress: 0 });
    windowed.push({ t: 1_000, progress: 40 });
    windowed.push({ t: 40_000, progress: 41 });
    windowed.push({ t: 50_000, progress: 42 });
    // only the slow recent stretch counts: 1 % per 10 s → 58 % left ≈ 580 s
    expect(windowed.estimateSec()).toBe(580);
  });
});
