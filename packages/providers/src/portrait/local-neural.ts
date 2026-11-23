import type {
  PortraitGenerationRequest,
  PortraitPreparationRequest,
  PortraitProvider,
  PreparedPortrait,
  ProviderRef,
} from '@parlante/shared';
import { createEngineJobDir, engineImageExtension, engineStatus, runEngineJob } from '../engine';
import type { EngineHttpOptions } from '../engine';
import type { ProviderEnv } from '../env';

const INFO: ProviderRef = {
  id: 'local-neural',
  name: 'Motor neuronal local',
  quality: 'premium',
  local: true,
};

/** `EngineGenerateRequest.prompt` is limited to 1000 characters. */
const MAX_PROMPT_CHARS = 1000;

/**
 * `local-neural`: portraits with the local engine (services/avatar-engine).
 *  - `generate`: text → portrait of a SYNTHETIC person (`POST /v1/portraits/generate`, side
 *    AVATAR_PORTRAIT_SIZE). Returns the model and the seed actually kept (the engine retries
 *    with derived seeds when its quality control fails).
 *  - `prepare`:  photo → upright, framed portrait + background matte + landmarks
 *    (`POST /v1/portraits/prepare`). No usable face ⇒ AppError('UNPROCESSABLE') with the
 *    engine's message and `details.reason` (`no_face`, `multiple_faces`, `not_frontal`…).
 * Files travel through a private directory of the engine work dir (`createEngineJobDir`);
 * results always end up in `request.outputDir`.
 */
export function createLocalNeuralPortraitProvider(
  env: ProviderEnv,
  http: EngineHttpOptions = {},
): PortraitProvider {
  return {
    info: INFO,
    status: () => engineStatus(env, 'portrait', http),

    async generate(request: PortraitGenerationRequest) {
      const job = await createEngineJobDir(env, { clientRef: request.clientRef });
      try {
        const result = await runEngineJob(env, {
          ...http,
          path: '/v1/portraits/generate',
          kind: 'generate',
          body: {
            prompt: request.prompt.trim().slice(0, MAX_PROMPT_CHARS),
            seed: Math.abs(Math.trunc(request.seed)),
            width: env.AVATAR_PORTRAIT_SIZE,
            height: env.AVATAR_PORTRAIT_SIZE,
            outputDir: job.dir,
            ...(request.gender ? { gender: request.gender } : {}),
            ...(request.clientRef ? { clientRef: request.clientRef } : {}),
          },
          onProgress: request.onProgress,
          signal: request.signal,
        });
        const imagePath = await job.exportFile(
          result.imagePath,
          request.outputDir,
          `generated.${engineImageExtension(result.imagePath)}`,
        );
        return {
          imagePath,
          provider: INFO,
          model: result.model,
          ...(result.seedUsed !== undefined ? { seed: result.seedUsed } : {}),
        };
      } finally {
        await job.remove();
      }
    },

    async prepare(request: PortraitPreparationRequest): Promise<PreparedPortrait> {
      const job = await createEngineJobDir(env, { clientRef: request.clientRef });
      try {
        const imagePath = await job.importFile(
          request.imagePath,
          `source.${engineImageExtension(request.imagePath)}`,
        );
        const result = await runEngineJob(env, {
          ...http,
          path: '/v1/portraits/prepare',
          kind: 'prepare',
          body: {
            imagePath,
            ...(request.landmarks ? { landmarks: request.landmarks } : {}),
            outputDir: job.dir,
            ...(request.clientRef ? { clientRef: request.clientRef } : {}),
          },
          onProgress: request.onProgress,
          signal: request.signal,
        });
        const portraitPath = await job.exportFile(
          result.portraitPath,
          request.outputDir,
          `portrait.${engineImageExtension(result.portraitPath)}`,
        );
        const maskPath = result.maskPath
          ? await job.exportFile(result.maskPath, request.outputDir, 'mask.png')
          : null;
        return {
          portraitPath,
          maskPath,
          width: result.width,
          height: result.height,
          landmarks: result.landmarks,
          landmarksSource: result.landmarksSource,
          provider: INFO,
        };
      } finally {
        await job.remove();
      }
    },
  };
}
