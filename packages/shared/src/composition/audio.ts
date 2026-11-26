/**
 * Audio mixing constants shared by the Studio preview player (WebAudio) and the export mix
 * (ffmpeg in the worker), so a video SOUNDS the same before and after rendering. Both sides
 * import these; neither hard-codes its own.
 *
 * Mix model (per video): narration of each scene at gain 1, starting at
 * `SceneTiming.speechStartMs`; video backgrounds / video layers at their `volume`; the music
 * track at `music.volume`, faded in/out with `fadeInMs`/`fadeOutMs`, looped when `loop`, and —
 * when `music.ducking` — multiplied by `duckGain` while any narration is audible.
 */
export const AUDIO_MIX = {
  /** Music gain multiplier while narration plays (≈ -9 dB). */
  duckGain: 0.35,
  /** Linear ramp down to the ducked gain, ending when the narration starts. */
  duckAttackMs: 150,
  /** Linear ramp back up, starting when the narration ends. */
  duckReleaseMs: 400,
  /** Fade-out applied to a narration that is cut by a fixed-duration scene. */
  narrationCutFadeMs: 120,
  /** Sample rate and channel layout of the exported AAC track. */
  sampleRate: 48_000,
  channels: 2,
} as const;

export interface DuckingWindow {
  /** Video-clock ms: the ramp down starts at `startMs - duckAttackMs`. */
  startMs: number;
  /** The ramp up ends at `endMs + duckReleaseMs`. */
  endMs: number;
}

/**
 * Music gain multiplier (duckGain..1) at video time `tMs`, given when narration is audible.
 * Pure: the preview schedules WebAudio ramps from the same windows, the worker turns them
 * into an ffmpeg volume expression.
 */
export function duckingGainAt(windows: readonly DuckingWindow[], tMs: number): number {
  let gain = 1;
  for (const w of windows) {
    if (w.endMs <= w.startMs) continue;
    let g = 1;
    if (tMs >= w.startMs && tMs <= w.endMs) {
      g = AUDIO_MIX.duckGain;
    } else if (tMs < w.startMs && tMs > w.startMs - AUDIO_MIX.duckAttackMs) {
      const k = (w.startMs - tMs) / AUDIO_MIX.duckAttackMs;
      g = AUDIO_MIX.duckGain + (1 - AUDIO_MIX.duckGain) * k;
    } else if (tMs > w.endMs && tMs < w.endMs + AUDIO_MIX.duckReleaseMs) {
      const k = (tMs - w.endMs) / AUDIO_MIX.duckReleaseMs;
      g = AUDIO_MIX.duckGain + (1 - AUDIO_MIX.duckGain) * k;
    }
    gain = Math.min(gain, g);
  }
  return gain;
}
