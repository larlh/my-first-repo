/* -------------------------------------------------------------------------------------------
 * Splitting long recordings for speech-to-text services with an upload limit: cut points are
 * placed in the quietest moment near the end of each chunk, so words are not cut in half.
 * Pure and deterministic.
 * ----------------------------------------------------------------------------------------- */

export interface AudioChunk {
  /** Sample range [start, end) in the source. */
  start: number;
  end: number;
}

export interface ChunkPlanOptions {
  /** Hard maximum length of a chunk in seconds. */
  maxChunkSec: number;
  /** How far back from the maximum a cut point is searched. Default: a fifth, up to 45 s. */
  searchSec?: number;
}

const WINDOW_SEC = 0.3;
const STEP_SEC = 0.05;
/** A final piece shorter than this is glued to the previous chunk instead of sent alone. */
const MIN_TAIL_SEC = 1.5;

/** Plan the chunks of `samples`. A recording that fits in one chunk yields a single range. */
export function planAudioChunks(
  samples: ArrayLike<number>,
  sampleRate: number,
  options: ChunkPlanOptions,
): AudioChunk[] {
  const total = samples.length;
  if (total === 0 || !(sampleRate > 0)) return [];
  const maxSamples = Math.max(1, Math.floor(options.maxChunkSec * sampleRate));
  const search = Math.floor(
    Math.min(options.searchSec ?? Math.min(45, options.maxChunkSec / 5), options.maxChunkSec / 2) *
      sampleRate,
  );
  const window = Math.max(1, Math.floor(WINDOW_SEC * sampleRate));
  const step = Math.max(1, Math.floor(STEP_SEC * sampleRate));
  const minTail = Math.floor(MIN_TAIL_SEC * sampleRate);
  const chunks: AudioChunk[] = [];
  let start = 0;
  while (total - start > maxSamples) {
    const limit = start + maxSamples;
    const from = Math.max(start + window, limit - search);
    // Sliding energy over [from, limit): keep the quietest window (ties: the latest one).
    let bestEnergy = Infinity;
    let bestCentre = limit;
    let energy = 0;
    for (let i = from; i < Math.min(from + window, limit); i += 1) {
      const v = samples[i] ?? 0;
      energy += v * v;
    }
    for (let at = from; at + window <= limit; at += step) {
      if (energy <= bestEnergy) {
        bestEnergy = energy;
        bestCentre = at + (window >> 1);
      }
      for (let i = at; i < at + step; i += 1) {
        const out = samples[i] ?? 0;
        const inn = samples[i + window] ?? 0;
        energy += inn * inn - out * out;
      }
    }
    const end = Math.min(limit, Math.max(start + 1, bestCentre));
    chunks.push({ start, end });
    start = end;
  }
  const last = chunks[chunks.length - 1];
  if (last && total - start < minTail && total - last.start <= maxSamples + minTail) {
    last.end = total; // glue a tiny tail (the caller's limit has room for it)
  } else if (total > start) {
    chunks.push({ start, end: total });
  }
  return chunks;
}
