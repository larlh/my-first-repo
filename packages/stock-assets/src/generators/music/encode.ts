import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SAMPLE_RATE, toInterleavedF32 } from './synth';
import type { Bus } from './synth';

export interface EncodedTrack {
  /** AAC-LC in an MP4 container (.m4a). */
  bytes: Buffer;
  samples: number;
  /** Hash of the float PCM that was encoded: identifies the music independently of ffmpeg. */
  pcmSha256: string;
}

export const MUSIC_BITRATE = '128k';
/** Samples per AAC frame: a loop must be a whole number of frames to be cut losslessly. */
export const AAC_FRAME = 1024;

function ffmpeg(args: string[], input?: Buffer): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    ...(input ? { input } : {}),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status}): ${result.stderr.toString().trim()}`);
  }
}

/**
 * Encode a rendered loop as a file that still loops seamlessly AFTER lossy compression.
 *
 * A codec that sees the music start and stop abruptly smears noise over the first and last
 * milliseconds, which clicks when the file is looped. So the loop is encoded three times in a
 * row and the AAC frames of the MIDDLE repetition are copied out untouched: its first and last
 * frames were coded with the real neighbouring audio (the end and the start of the same loop).
 * One extra leading frame is kept as decoder priming and hidden by the MP4 edit list, exactly
 * like the priming of any AAC file, so decoders return precisely `bus.length` samples.
 *
 * ffmpeg is called with argument arrays (no shell).
 */
export function encodeTrack(bus: Bus): EncodedTrack {
  const n = bus.length;
  if (n % AAC_FRAME !== 0) {
    throw new Error(`Loop length ${n} is not a multiple of ${AAC_FRAME} samples`);
  }
  const pcm = toInterleavedF32(bus);
  // The MP4 muxer needs seekable files, hence a private temp directory instead of pipes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parlante-music-'));
  const triple = path.join(dir, 'triple.m4a');
  const target = path.join(dir, 'track.m4a');
  const seconds = (samples: number): string => (samples / SAMPLE_RATE).toFixed(6);
  try {
    ffmpeg(
      [
        ...['-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', 'pipe:0'],
        ...['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact'],
        ...['-c:a', 'aac', '-b:a', MUSIC_BITRATE, triple],
      ],
      Buffer.concat([pcm, pcm, pcm]),
    );
    // Seek half a frame after the priming frame (robust against timestamp rounding), copy the
    // priming frame plus the frames of the middle repetition, and shift timestamps so that the
    // priming frame ends at 0 — the muxer then writes the usual 1024-sample edit list.
    ffmpeg([
      ...['-ss', seconds(n - AAC_FRAME / 2), '-i', triple],
      ...['-frames:a', String(n / AAC_FRAME + 1), '-output_ts_offset', seconds(-AAC_FRAME / 2)],
      ...['-c', 'copy', '-map_metadata', '-1', '-fflags', '+bitexact'],
      ...['-movflags', '+faststart', target],
    ]);
    const decoded = decodeToPcm(target);
    if (decoded.length !== n * 2) {
      throw new Error(`Encoded loop decodes to ${decoded.length / 2} samples, expected ${n}`);
    }
    return {
      bytes: fs.readFileSync(target),
      samples: n,
      pcmSha256: createHash('sha256').update(pcm).digest('hex'),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Decode any audio file to interleaved stereo float PCM at 48 kHz (used by the generator's
 * self-check and by the tests). Extra ffmpeg arguments go before `-i` or before the output.
 */
export function decodeToPcm(
  file: string,
  inputArgs: string[] = [],
  outputArgs: string[] = [],
): Float32Array {
  const result = spawnSync(
    'ffmpeg',
    [
      ...['-hide_banner', '-loglevel', 'error', ...inputArgs, '-i', file, ...outputArgs],
      ...['-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '2', 'pipe:1'],
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status}): ${result.stderr.toString().trim()}`);
  }
  const out = result.stdout;
  return new Float32Array(out.buffer, out.byteOffset, Math.floor(out.length / 4));
}
