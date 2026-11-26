import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '@parlante/shared/node';
import { canvasToJpeg, canvasToPng, createNodeCanvas } from '@parlante/renderer/node';

/* Real media files for the integration tests of the library modules: pictures drawn with the
 * canvas, audio and video encoded with ffmpeg. Nothing here is used by the application. */

/** A PNG with a two-colour diagonal design (optionally with a transparent background). */
export function pngBytes(width = 64, height = 48, options: { transparent?: boolean } = {}): Buffer {
  const { canvas, ctx } = createNodeCanvas(width, height);
  if (!options.transparent) {
    ctx.fillStyle = '#6d5efc';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.fillStyle = '#ffb547';
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.lineTo(width, 0);
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();
  return canvasToPng(canvas);
}

export function jpegBytes(width = 80, height = 60): Buffer {
  const { canvas, ctx } = createNodeCanvas(width, height);
  ctx.fillStyle = '#1b1f3b';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(width / 4, height / 4, width / 2, height / 2);
  return canvasToJpeg(canvas, 90);
}

export interface MediaFixtures {
  /** H.264 + AAC, 320×240, 1.2 s. */
  mp4: Buffer;
  /** VP8 + Vorbis, 160×120, 1 s. */
  webm: Buffer;
  /** PCM 16-bit mono, 0.8 s. */
  wav: Buffer;
  /** MP3, 1 s. */
  mp3: Buffer;
  /** An MP4 container (brand `isom`) that only carries an AAC track, 1 s. */
  audioOnlyMp4: Buffer;
  /** Animated GIF, 48×32, 4 frames. */
  gif: Buffer;
}

/** Encode the audio / video fixtures once (≈ 1 s). Call it in `beforeAll`. */
export async function createMediaFixtures(): Promise<MediaFixtures> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-fixtures-'));
  const file = (name: string) => path.join(dir, name);
  const video = ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25'];
  const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'];
  try {
    await runFfmpeg([
      ...video,
      ...tone,
      '-t',
      '1.2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      file('clip.mp4'),
    ]);
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=15',
      ...tone,
      '-t',
      '1',
      '-c:v',
      'libvpx',
      '-c:a',
      'libvorbis',
      file('clip.webm'),
    ]);
    await runFfmpeg([...tone, '-t', '0.8', '-ac', '1', '-c:a', 'pcm_s16le', file('tone.wav')]);
    await runFfmpeg([...tone, '-t', '1', '-c:a', 'libmp3lame', file('tone.mp3')]);
    await runFfmpeg([...tone, '-t', '1', '-c:a', 'aac', '-f', 'mp4', file('audio-only.mp4')]);
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=48x32:rate=4',
      '-frames:v',
      '4',
      file('anim.gif'),
    ]);
    return {
      mp4: await fs.readFile(file('clip.mp4')),
      webm: await fs.readFile(file('clip.webm')),
      wav: await fs.readFile(file('tone.wav')),
      mp3: await fs.readFile(file('tone.mp3')),
      audioOnlyMp4: await fs.readFile(file('audio-only.mp4')),
      gif: await fs.readFile(file('anim.gif')),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
