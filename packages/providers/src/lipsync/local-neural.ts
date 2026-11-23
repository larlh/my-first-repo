import type { LipSyncProvider, LipSyncRequest, LipSyncResult, ProviderRef } from '@parlante/shared';
import { createEngineJobDir, engineImageExtension, engineStatus, runEngineJob } from '../engine';
import type { EngineHttpOptions } from '../engine';
import type { ProviderEnv } from '../env';

const INFO: ProviderRef = {
  id: 'local-neural',
  name: 'Motor neuronal local',
  quality: 'premium',
  local: true,
};

/** Limits of `EngineAnimateRequest` (the engine clamps further to what its model renders). */
const MIN_SIZE = 128;
const MAX_SIZE = 1024;

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * `local-neural`: animates photorealistic portraits with the local engine
 * (services/avatar-engine — open-source models, no paid service).
 *
 * `animate` copies the caller's portrait, matte and narration into a private directory of the
 * engine work dir, runs `POST /v1/animations` there (progress and ETA from the engine's own
 * measurements), copies the clip and its matte into `request.outputDir` and removes the
 * directory. `request.clientRef` re-attaches to a job that is still running after a worker
 * restart; aborting `request.signal` cancels the engine job.
 */
export function createLocalNeuralLipSyncProvider(
  env: ProviderEnv,
  http: EngineHttpOptions = {},
): LipSyncProvider {
  return {
    info: INFO,
    status: () => engineStatus(env, 'lipsync', http),
    async animate(request: LipSyncRequest): Promise<LipSyncResult> {
      const job = await createEngineJobDir(env, { clientRef: request.clientRef });
      try {
        const [portraitPath, maskPath, audioPath] = await Promise.all([
          job.importFile(
            request.portraitPath,
            `portrait.${engineImageExtension(request.portraitPath)}`,
          ),
          request.maskPath ? job.importFile(request.maskPath, 'mask.png') : null,
          job.importFile(request.audioPath, 'audio.wav'),
        ]);
        const result = await runEngineJob(env, {
          ...http,
          path: '/v1/animations',
          kind: 'animate',
          body: {
            portraitPath,
            maskPath,
            audioPath,
            // An empty timeline means "no hint": the engine then works from the audio alone.
            ...(request.visemes && request.visemes.length > 0 ? { visemes: request.visemes } : {}),
            fps: clampInt(request.fps, 1, 60),
            maxSize: clampInt(request.maxSize, MIN_SIZE, MAX_SIZE),
            outputDir: job.dir,
            ...(request.clientRef ? { clientRef: request.clientRef } : {}),
          },
          onProgress: request.onProgress,
          signal: request.signal,
        });
        const videoPath = await job.exportFile(result.videoPath, request.outputDir, 'avatar.mp4');
        const hasMatte = result.alpha !== 'none' && result.maskPath !== null;
        const matteName = result.alpha === 'mask-image' ? 'avatar-matte.png' : 'avatar-matte.mp4';
        const matte =
          hasMatte && result.maskPath
            ? await job.exportFile(result.maskPath, request.outputDir, matteName)
            : null;
        return {
          videoPath,
          alpha: matte ? result.alpha : 'none',
          maskPath: matte,
          width: result.width,
          height: result.height,
          fps: result.fps,
          frameCount: result.frameCount,
          provider: INFO,
        };
      } finally {
        await job.remove();
      }
    },
  };
}
