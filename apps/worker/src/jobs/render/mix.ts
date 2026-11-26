import fs from 'node:fs/promises';
import { AUDIO_MIX, duckingGainAt, mediaRefKey } from '@parlante/shared';
import type { Composition, DuckingWindow, MusicTrack } from '@parlante/shared';
import type { Timeline } from '@parlante/renderer';
import { runFfmpeg } from '../../lib/ffmpeg';
import type { MediaFile } from './media';
import type { RenderRun } from './run';

/* -------------------------------------------------------------------------------------------
 * Stage `audio` (second half): the soundtrack, as ONE 48 kHz stereo WAV exactly as long as
 * the video — narrations at their place on the timeline, the music track at its volume with
 * fades and ducking, and the sound of video backgrounds / video layers.
 *
 * Mix model = `AUDIO_MIX` in @parlante/shared (the Studio player uses the same numbers).
 * The music gain is not written as an ffmpeg expression: the job computes the gain curve
 * with `duckingGainAt` itself, hands it to ffmpeg as a low-rate control signal and multiplies
 * (`amultiply`), so the export follows the shared definition sample for sample however many
 * scenes the video has.
 * ----------------------------------------------------------------------------------------- */

const RATE = AUDIO_MIX.sampleRate;
/** Sample rate of the music gain curve (1 ms resolution; ramps are ≥ 120 ms long). */
export const ENVELOPE_RATE = 1000;
/** Peak ceiling of the mix: narration + music may add up to more than full scale. */
const LIMIT = 0.97;

/** Samples per channel of a soundtrack that lasts exactly `totalFrames` video frames. */
export function soundtrackSamples(timeline: Pick<Timeline, 'totalFrames' | 'fps'>): number {
  return Math.round((timeline.totalFrames * RATE) / timeline.fps);
}

/** When narration is audible on the video clock (what the music ducks under). */
export function narrationWindows(timeline: Timeline): DuckingWindow[] {
  return timeline.scenes
    .filter((scene) => scene.speechDurationMs > 0)
    .map((scene) => ({
      startMs: scene.speechStartMs,
      endMs: scene.speechStartMs + scene.speechDurationMs,
    }));
}

/**
 * Gain of the music track over the whole video, sampled at `ENVELOPE_RATE`:
 * volume × fade-in × fade-out (ending with the video) × ducking under narration.
 */
export function musicEnvelope(
  music: Pick<MusicTrack, 'volume' | 'ducking' | 'fadeInMs' | 'fadeOutMs'>,
  windows: readonly DuckingWindow[],
  totalMs: number,
): Float32Array {
  // One extra second so the control signal never ends before the music it multiplies.
  const length = Math.ceil((totalMs * ENVELOPE_RATE) / 1000) + ENVELOPE_RATE;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const tMs = (i * 1000) / ENVELOPE_RATE;
    let gain = music.volume;
    if (music.fadeInMs > 0) gain *= Math.min(1, tMs / music.fadeInMs);
    if (music.fadeOutMs > 0) gain *= Math.min(1, Math.max(0, (totalMs - tMs) / music.fadeOutMs));
    if (music.ducking) gain *= duckingGainAt(windows, tMs);
    out[i] = gain;
  }
  return out;
}

/** One piece of video sound on the video clock. */
export interface VideoSound {
  key: string;
  /** Video-clock ms at which it starts, and for how long it plays. */
  startMs: number;
  playMs: number;
  /** Position inside the media where playback starts. */
  mediaStartMs: number;
  loop: boolean;
  volume: number;
}

/**
 * Sound of video backgrounds and video layers, scene by scene — the same clocks the renderer
 * uses for their pictures (`backgroundVideoRawMs`, `videoLayerRawMs`). A scene held frozen
 * under a transition is silent, so each scene simply sounds from its start to its end.
 */
export function collectVideoSounds(composition: Composition, timeline: Timeline): VideoSound[] {
  const out: VideoSound[] = [];
  for (const timing of timeline.scenes) {
    const scene = composition.scenes[timing.index];
    if (!scene) continue;
    const background = scene.background;
    if (background.type === 'video' && background.volume > 0) {
      out.push({
        key: mediaRefKey(background.src),
        startMs: timing.startMs,
        playMs: timing.durationMs,
        mediaStartMs: background.trimStartMs,
        loop: background.loop,
        volume: background.volume,
      });
    }
    for (const layer of scene.layers) {
      if (layer.type !== 'video' || !layer.visible || layer.volume <= 0) continue;
      const from = Math.min(timing.durationMs, Math.max(0, layer.timing?.startMs ?? 0));
      const to = Math.min(timing.durationMs, layer.timing?.endMs ?? timing.durationMs);
      if (to <= from) continue;
      out.push({
        key: mediaRefKey(layer.src),
        startMs: timing.startMs + from,
        playMs: to - from,
        mediaStartMs: layer.trimStartMs,
        loop: layer.loop,
        volume: layer.volume,
      });
    }
  }
  return out;
}

export interface SoundtrackInput {
  composition: Composition;
  timeline: Timeline;
  /** sceneId → local narration file and its full length. */
  narrations: ReadonlyMap<string, { path: string; durationMs: number }>;
  audio: ReadonlyMap<string, MediaFile>;
  video: ReadonlyMap<string, MediaFile>;
  /** Where the music gain curve (raw f32le mono at `ENVELOPE_RATE`) is / will be written. */
  envelopePath: string;
  outputPath: string;
}

const sec = (ms: number) => (ms / 1000).toFixed(6);
const toSamples = (ms: number) => Math.max(0, Math.round((ms * RATE) / 1000));
/**
 * Chain that brings any source to 48 kHz float stereo WITHOUT changing its level: a mono
 * source is copied to both channels (ffmpeg's default up-mix would attenuate it by 3 dB, and
 * the Studio's WebAudio player does not); anything wider is down-mixed the standard way.
 */
function stereo(channels: number | null): string {
  return channels === 1
    ? `aresample=${RATE},aformat=sample_fmts=fltp,pan=stereo|c0=c0|c1=c0`
    : `aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
}

/**
 * ffmpeg arguments (an ARRAY — nothing is interpolated into a shell line, and every path is
 * server generated) that mix the soundtrack. Pure, so the graph can be unit tested.
 * `usesEnvelope` tells the caller whether `envelopePath` must exist.
 */
export function soundtrackArgs(input: SoundtrackInput): { args: string[]; usesEnvelope: boolean } {
  const { composition, timeline } = input;
  const total = soundtrackSamples(timeline);
  const inputs: string[] = [];
  const filters: string[] = [];
  const mixed: string[] = [];
  let index = 0;
  const addInput = (options: string[], file: string) => {
    inputs.push(...options, '-i', file);
    index += 1;
    return index - 1;
  };

  // Narrations: mono voice centred, cut (with a short fade) when a fixed scene is too short.
  for (const timing of timeline.scenes) {
    const narration = input.narrations.get(timing.sceneId);
    if (!narration || timing.speechDurationMs <= 0) continue;
    const i = addInput([], narration.path);
    const chain = [
      `aresample=${RATE}`,
      'aformat=sample_fmts=fltp:channel_layouts=mono',
      'pan=stereo|c0=c0|c1=c0',
      `atrim=end=${sec(timing.speechDurationMs)}`,
    ];
    if (narration.durationMs > timing.speechDurationMs + 1) {
      const fade = Math.min(AUDIO_MIX.narrationCutFadeMs, timing.speechDurationMs);
      chain.push(`afade=t=out:st=${sec(timing.speechDurationMs - fade)}:d=${sec(fade)}`);
    }
    chain.push(`adelay=delays=${toSamples(timing.speechStartMs)}S:all=1`);
    filters.push(`[${i}:a:0]${chain.join(',')}[n${i}]`);
    mixed.push(`[n${i}]`);
  }

  // Music: looped, multiplied by the gain curve (volume, fades, ducking).
  let usesEnvelope = false;
  const music = composition.music;
  const musicFile = music ? input.audio.get(mediaRefKey(music.src)) : undefined;
  if (music && musicFile && music.volume > 0) {
    const stockLoop = music.loop && musicFile.aloopFilter !== undefined;
    const m = addInput(music.loop && !stockLoop ? ['-stream_loop', '-1'] : [], musicFile.path);
    const e = addInput(
      ['-f', 'f32le', '-ar', String(ENVELOPE_RATE), '-ac', '1'],
      input.envelopePath,
    );
    usesEnvelope = true;
    const chain = [
      ...(stockLoop && musicFile.aloopFilter ? [musicFile.aloopFilter] : []),
      stereo(musicFile.info.channels),
      `atrim=end_sample=${total}`,
    ];
    filters.push(`[${m}:a:0]${chain.join(',')}[m${m}]`);
    filters.push(`[${e}:a:0]${stereo(1)}[e${e}]`);
    filters.push(`[m${m}][e${e}]amultiply[music]`);
    mixed.push('[music]');
  }

  // Sound of video backgrounds and video layers.
  for (const sound of collectVideoSounds(composition, timeline)) {
    const file = input.video.get(sound.key);
    if (!file || !file.info.hasAudio) continue;
    const mediaMs = file.info.durationMs ?? 0;
    if (!sound.loop && mediaMs > 0 && sound.mediaStartMs >= mediaMs) continue;
    const startInMedia =
      sound.loop && mediaMs > 0 ? sound.mediaStartMs % mediaMs : sound.mediaStartMs;
    const v = addInput(
      sound.loop ? ['-stream_loop', '-1', '-t', sec(startInMedia + sound.playMs + 1000)] : [],
      file.path,
    );
    const chain = [
      `atrim=start=${sec(startInMedia)}:duration=${sec(sound.playMs)}`,
      'asetpts=PTS-STARTPTS',
      stereo(file.info.channels),
      `volume=${sound.volume.toFixed(4)}`,
      `adelay=delays=${toSamples(sound.startMs)}S:all=1`,
    ];
    filters.push(`[${v}:a:0]${chain.join(',')}[v${v}]`);
    mixed.push(`[v${v}]`);
  }

  // Exactly `total` samples: padded with silence, never longer than the video.
  const tail = `apad=whole_len=${total},atrim=end_sample=${total}`;
  if (mixed.length === 0) {
    filters.push(`anullsrc=r=${RATE}:cl=stereo,atrim=end_sample=${total}[out]`);
  } else {
    const sum =
      mixed.length === 1
        ? `${mixed[0]}anull`
        : `${mixed.join('')}amix=inputs=${mixed.length}:duration=longest:dropout_transition=0:normalize=0`;
    filters.push(`${sum},alimiter=limit=${LIMIT}:level=disabled:latency=1,${tail}[out]`);
  }

  return {
    usesEnvelope,
    args: [
      ...inputs,
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[out]',
      '-c:a',
      'pcm_s16le',
      '-ar',
      String(RATE),
      '-ac',
      String(AUDIO_MIX.channels),
      '-f',
      'wav',
      input.outputPath,
    ],
  };
}

/** Mix the soundtrack of the video into `input.outputPath` (WAV PCM16, 48 kHz stereo). */
export async function mixSoundtrack(run: RenderRun, input: SoundtrackInput): Promise<void> {
  const { args, usesEnvelope } = soundtrackArgs(input);
  if (usesEnvelope && input.composition.music) {
    const envelope = musicEnvelope(
      input.composition.music,
      narrationWindows(input.timeline),
      input.timeline.totalMs,
    );
    await fs.writeFile(
      input.envelopePath,
      Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength),
    );
  }
  await runFfmpeg(args, {
    signal: run.signal,
    timeoutMs: 600_000 + input.timeline.totalMs * 2,
  });
}
