import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@parlante/shared';
import type { EngineStatus, LipSyncProvider, LipSyncRequest, ProviderRef } from '@parlante/shared';
import { ffprobe, runFfmpeg } from '../../../lib/ffmpeg';

/* -------------------------------------------------------------------------------------------
 * In-process `LipSyncProvider` for the render tests (the real `local-neural` provider needs
 * the Python engine and a second of CPU per frame). It honours the contract the job relies
 * on: a real H.264 clip exactly as long as the audio, with the framing of the portrait
 * (square), plus a greyscale matte clip — here a flat MAGENTA picture inside a centred white
 * box of the matte, so tests can find the composited clip in the exported frames.
 * ----------------------------------------------------------------------------------------- */

export const FAKE_LIPSYNC_INFO: ProviderRef = {
  id: 'fake-neural',
  name: 'Fake neural engine (tests)',
  quality: 'premium',
  local: true,
};

export interface FakeLipSync extends LipSyncProvider {
  /** Every `animate` request received. */
  calls: LipSyncRequest[];
  /**
   * What the audio file of each request really contained when it arrived (the worker deletes
   * its temp files afterwards): length and loudest 16-bit sample (0 = digital silence).
   */
  audio: { durationMs: number; peak: number }[];
  /** `EngineStatus.animationKey` reported by `status()` (null = an engine that does not say). */
  animationKey: string | null;
  /** Driver the clips say they were made with (null = a provider that does not say). */
  driver: 'audio' | 'visemes' | null;
  /** Make `animate` reject with this error. */
  failWith: Error | null;
  /** Wait this long inside `animate` (cancellation tests); aborting the signal rejects. */
  delayMs: number;
  /** Signals that were aborted while animating. */
  aborted: number;
}

/** Loudest absolute sample of a PCM 16-bit WAV (its `data` chunk). */
function wavPeak(file: Buffer): number {
  const at = file.indexOf('data', 12, 'latin1');
  if (at < 0) return 0;
  let peak = 0;
  for (let o = at + 8; o + 1 < file.length; o += 2)
    peak = Math.max(peak, Math.abs(file.readInt16LE(o)));
  return peak;
}

export function createFakeLipSync(size = 256): FakeLipSync {
  const provider: FakeLipSync = {
    info: FAKE_LIPSYNC_INFO,
    calls: [],
    audio: [],
    animationKey: null,
    driver: null,
    failWith: null,
    delayMs: 0,
    aborted: 0,
    status(): Promise<EngineStatus> {
      return Promise.resolve({
        available: true,
        reason: null,
        device: 'cpu',
        secondsPerVideoSecond: 30,
        operations: { generate: false, prepare: false, animate: true },
        models: [
          {
            id: 'fake-animator-v1',
            role: 'animation',
            downloaded: true,
            license: 'MIT',
            commercialUse: true,
          },
        ],
        ...(provider.animationKey === null ? {} : { animationKey: provider.animationKey }),
      });
    },
    async animate(request) {
      provider.calls.push(request);
      if (provider.failWith) throw provider.failWith;
      const info = await ffprobe(request.audioPath);
      provider.audio.push({
        durationMs: info.durationMs ?? 0,
        peak: wavPeak(await fs.readFile(request.audioPath)),
      });
      const frameCount = Math.max(1, Math.ceil(((info.durationMs ?? 0) * request.fps) / 1000));
      request.onProgress?.({ fraction: 0.1, etaSec: 9 });
      if (provider.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, provider.delayMs);
          request.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              provider.aborted += 1;
              reject(new AppError('PROVIDER_ERROR', 'The animation was aborted'));
            },
            { once: true },
          );
        });
      }
      const videoPath = path.join(request.outputDir, 'avatar.mp4');
      const maskPath = path.join(request.outputDir, 'avatar-matte.mp4');
      const encode = ['-frames:v', String(frameCount), '-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
      await runFfmpeg(
        [
          '-f',
          'lavfi',
          '-i',
          `color=c=0xff00ff:s=${size}x${size}:r=${request.fps}`,
          ...encode,
          videoPath,
        ],
        { signal: request.signal },
      );
      const box = `drawbox=x=${size / 4}:y=${size / 8}:w=${size / 2}:h=${(size * 3) / 4}:color=white:t=fill`;
      await runFfmpeg(
        [
          '-f',
          'lavfi',
          '-i',
          `color=c=black:s=${size}x${size}:r=${request.fps},${box}`,
          ...encode,
          maskPath,
        ],
        { signal: request.signal },
      );
      request.onProgress?.({ fraction: 1, etaSec: 0 });
      return {
        videoPath,
        alpha: 'mask-video',
        maskPath,
        width: size,
        height: size,
        fps: request.fps,
        frameCount,
        provider: FAKE_LIPSYNC_INFO,
        ...(provider.driver === null ? {} : { driver: provider.driver }),
      };
    },
  };
  return provider;
}
