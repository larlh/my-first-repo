import fs from 'node:fs/promises';
import type { ProviderRef, TimedText, WordCue } from '@parlante/shared';
import { synthesizeCached } from '@parlante/jobs';
import type { CachedSpeech } from '@parlante/jobs';
import type { WorkerContext } from '../../context';
import { runFfmpeg } from '../../lib/ffmpeg';
import type { TempDir } from '../../lib/tmp';

/* -------------------------------------------------------------------------------------------
 * Dubbing: every translated segment is spoken by the TTS voice of the language and FITTED to
 * the time the original speaker had, so the dub never drifts away from the picture.
 *
 *   slot      from the start of the segment to the start of the next one (minus a short gap);
 *             the last segment may run to the end of the video
 *   fit       1. natural speed. Fits → done.
 *             2. slightly long (≤ 12 %) → time-stretched with ffmpeg `atempo` (pitch kept)
 *             3. longer → synthesised again FASTER by the voice itself (cleaner than
 *                stretching), up to ×1.6; what is still missing is stretched, up to ×1.3
 *             4. still too long (a sentence far longer than its slot) → cut at the end of
 *                the slot with a short fade, and counted in `stats.truncated`
 *   track     the fitted segments are written at their offsets into ONE raw PCM file
 *             (s16le mono 48 kHz, silence elsewhere) that the final mix reads as the dub.
 *             Segments never overlap by construction, so no mixing is needed here.
 *
 * Narrations come from `synthesizeCached` (shared TTS cache): re-running a job, or dubbing
 * the same sentence twice, synthesises nothing new.
 * ----------------------------------------------------------------------------------------- */

export const DUB_SAMPLE_RATE = 48_000;
/** Silence kept before the next segment starts. */
export const SLOT_GAP_MS = 80;
/** A slot is never considered shorter than this (overlapping source cues). */
export const MIN_SLOT_MS = 300;
/** Up to this ratio the natural take is simply time-stretched. */
export const STRETCH_ONLY_RATIO = 1.12;
/** Fastest rate asked from the voice, and largest stretch applied on top of it. */
export const MAX_VOICE_SPEED = 1.6;
export const MAX_TEMPO = 1.3;
const FADE_MS = 60;
/** Trailing silence of a take is not speech: it may overlap the gap. */
const TAIL_ALLOWANCE_MS = 60;

export interface DubSlot {
  startMs: number;
  /** Time the dubbed sentence may take. */
  availableMs: number;
}

/** The slot of every segment (segments sorted by start; `totalMs` = length of the video). */
export function dubSlots(segments: readonly TimedText[], totalMs: number): DubSlot[] {
  return segments.map((segment, index) => {
    const next = segments[index + 1];
    const limit = next ? next.startMs - SLOT_GAP_MS : totalMs;
    return {
      startMs: segment.startMs,
      availableMs: Math.max(MIN_SLOT_MS, Math.min(limit, totalMs) - segment.startMs),
    };
  });
}

/** Length of the SPEECH of a take: up to the end of its last word when the provider timed it. */
export function speechLengthMs(runtime: CachedSpeech['runtime']): number {
  const last = runtime.words[runtime.words.length - 1];
  if (!last) return runtime.audioDurationMs;
  return Math.min(runtime.audioDurationMs, last.tMs + last.durMs + TAIL_ALLOWANCE_MS);
}

export interface FitDecision {
  /** Synthesize again with this voice speed (1 = keep the natural take). */
  voiceSpeed: number;
  /** `atempo` factor applied to the take that is kept (1 = none). */
  tempo: number;
  /** True when even the fastest take does not fit and the end is cut. */
  truncated: boolean;
}

/** Step 2 / 3 of the fit: what to do with a natural take of `speechMs` for a slot. */
export function planNaturalTake(speechMs: number, availableMs: number): FitDecision {
  const ratio = speechMs / Math.max(1, availableMs);
  if (ratio <= 1) return { voiceSpeed: 1, tempo: 1, truncated: false };
  if (ratio <= STRETCH_ONLY_RATIO) return { voiceSpeed: 1, tempo: ratio, truncated: false };
  // 4 % of margin: voices are not exactly linear in their speed parameter.
  return { voiceSpeed: Math.min(MAX_VOICE_SPEED, ratio * 1.04), tempo: 1, truncated: false };
}

/** Step 3 / 4: the stretch (and cut) a faster take still needs. */
export function planFastTake(speechMs: number, availableMs: number): number {
  return Math.min(MAX_TEMPO, Math.max(1, speechMs / Math.max(1, availableMs)));
}

export interface DubbedSegment {
  index: number;
  startMs: number;
  /** Time the sentence takes in the dub after fitting (≤ the slot). */
  spokenMs: number;
  text: string;
  /** Words of the dub on the clock of the VIDEO (empty when the provider timed none). */
  words: WordCue[];
  audioKey: string;
  tempo: number;
  voiceSpeed: number;
  truncated: boolean;
  /** Samples to keep after stretching (the slot), so segments never overlap. */
  maxMs: number;
}

export interface DubStats {
  segments: number;
  stretched: number;
  resynthesised: number;
  truncated: number;
  /** Narrations that came from the TTS cache. */
  cached: number;
}

export interface DubResult {
  segments: DubbedSegment[];
  provider: ProviderRef | null;
  stats: DubStats;
}

export interface DubOptions {
  workspaceId: string;
  voiceId: string;
  language: string;
  /** Called after every segment with the fraction done (0..1). May throw to stop the job. */
  onProgress?: (fraction: number) => Promise<void> | void;
}

/**
 * Speak and fit every segment. `segments` are the TRANSLATED cues with the timing of the
 * source; empty texts are skipped (nothing to say there).
 */
export async function dubSegments(
  ctx: Pick<WorkerContext, 'db' | 'providers'>,
  segments: readonly TimedText[],
  totalMs: number,
  options: DubOptions,
): Promise<DubResult> {
  const deps = { db: ctx.db, providers: ctx.providers };
  const slots = dubSlots(segments, totalMs);
  const stats: DubStats = { segments: 0, stretched: 0, resynthesised: 0, truncated: 0, cached: 0 };
  const out: DubbedSegment[] = [];
  let provider: ProviderRef | null = null;

  for (const [index, segment] of segments.entries()) {
    const slot = slots[index];
    const text = segment.text.trim();
    if (!slot || text === '' || slot.startMs >= totalMs) {
      await options.onProgress?.((index + 1) / segments.length);
      continue;
    }
    const request = { text, voiceId: options.voiceId, language: options.language };
    let take = await synthesizeCached(deps, options.workspaceId, request);
    let speechMs = speechLengthMs(take.runtime);
    if (speechMs <= 0) {
      // The voice produced no sound for this text (only symbols, for instance).
      await options.onProgress?.((index + 1) / segments.length);
      continue;
    }
    const decision = planNaturalTake(speechMs, slot.availableMs);
    if (decision.voiceSpeed > 1) {
      take = await synthesizeCached(deps, options.workspaceId, {
        ...request,
        speed: Math.round(decision.voiceSpeed * 100) / 100,
      });
      speechMs = speechLengthMs(take.runtime);
      decision.tempo = planFastTake(speechMs, slot.availableMs);
      stats.resynthesised += 1;
    }
    const fittedMs = speechMs / decision.tempo;
    decision.truncated = fittedMs > slot.availableMs + 1;
    if (decision.tempo > 1.001) stats.stretched += 1;
    if (decision.truncated) stats.truncated += 1;
    if (take.cached) stats.cached += 1;
    stats.segments += 1;
    provider = take.provider;

    const spokenMs = Math.min(fittedMs, slot.availableMs);
    out.push({
      index,
      startMs: slot.startMs,
      spokenMs,
      text,
      words: take.runtime.words
        .map((word) => ({
          tMs: slot.startMs + word.tMs / decision.tempo,
          durMs: word.durMs / decision.tempo,
          text: word.text,
        }))
        .filter((word) => word.tMs < slot.startMs + spokenMs && word.text.trim() !== ''),
      audioKey: take.audioKey,
      tempo: decision.tempo,
      voiceSpeed: decision.voiceSpeed,
      truncated: decision.truncated,
      // A take that fits keeps its natural tail (it dies away inside the gap); the hard
      // limit is the next segment.
      maxMs: decision.truncated ? slot.availableMs : slot.availableMs + SLOT_GAP_MS / 2,
    });
    await options.onProgress?.((index + 1) / segments.length);
  }
  return { segments: out, provider, stats };
}

/** ffmpeg audio filter chain that turns one take into its fitted form. */
export function fitFilters(segment: Pick<DubbedSegment, 'tempo' | 'truncated' | 'maxMs'>): string {
  const filters: string[] = [];
  if (segment.tempo > 1.001) filters.push(`atempo=${segment.tempo.toFixed(4)}`);
  const maxSec = segment.maxMs / 1000;
  filters.push(`atrim=end=${maxSec.toFixed(3)}`);
  if (segment.truncated) {
    const fadeStart = Math.max(0, (segment.maxMs - FADE_MS) / 1000);
    filters.push(`afade=t=out:st=${fadeStart.toFixed(3)}:d=${(FADE_MS / 1000).toFixed(3)}`);
  }
  return filters.join(',');
}

/**
 * Write the dub track: `totalMs` of s16le mono 48 kHz PCM with every fitted segment at its
 * offset. Returns the path of the raw file (inside `tmp`).
 */
export async function buildDubTrack(
  ctx: Pick<WorkerContext, 'providers'>,
  tmp: TempDir,
  segments: readonly DubbedSegment[],
  totalMs: number,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => Promise<void> | void } = {},
): Promise<string> {
  const { storage } = ctx.providers;
  const trackPath = tmp.file('dub.s16le');
  const totalSamples = Math.ceil((totalMs * DUB_SAMPLE_RATE) / 1000);
  const totalBytes = totalSamples * 2;
  const track = await fs.open(trackPath, 'w');
  try {
    await track.truncate(totalBytes); // sparse: silence wherever nobody speaks
    for (const [position, segment] of segments.entries()) {
      let takePath = storage.localPath(segment.audioKey);
      if (!takePath) {
        takePath = tmp.file('take.wav');
        await storage.downloadTo(segment.audioKey, takePath);
      }
      const { stdout } = await runFfmpeg(
        [
          '-v',
          'error',
          '-i',
          takePath,
          '-af',
          fitFilters(segment),
          '-ac',
          '1',
          '-ar',
          String(DUB_SAMPLE_RATE),
          '-f',
          's16le',
          '-c:a',
          'pcm_s16le',
          'pipe:1',
        ],
        { signal: options.signal, timeoutMs: 120_000, maxStdoutBytes: 256 * 1024 * 1024 },
      );
      const offset = Math.round((segment.startMs * DUB_SAMPLE_RATE) / 1000) * 2;
      const room = Math.max(0, totalBytes - offset);
      const pcm = stdout.subarray(0, Math.min(stdout.length - (stdout.length % 2), room));
      if (pcm.length > 0) await track.write(pcm, 0, pcm.length, offset);
      await options.onProgress?.((position + 1) / segments.length);
    }
  } finally {
    await track.close();
  }
  return trackPath;
}
