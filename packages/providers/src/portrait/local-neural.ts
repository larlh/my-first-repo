import fs from 'node:fs/promises';
import path from 'node:path';
import { engineAvatarCacheFile } from '@parlante/shared';
import type {
  PortraitGenerationRequest,
  PortraitPreparationRequest,
  PortraitProvider,
  PreparedPortrait,
  ProviderRef,
} from '@parlante/shared';
import { createEngineJobDir, engineImageExtension, engineStatus, runEngineJob } from '../engine';
import type { EngineHttpOptions } from '../engine';
import { resolveEngineWorkDir } from '../env';
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
 *    AVATAR_PORTRAIT_SIZE; `gender` steers the presenter template). Returns the model, the
 *    seed actually kept (the engine retries with derived seeds when its quality control fails)
 *    and the verdict of that control (`quality`: `passed`, `issues`, `attempts`).
 *  - `prepare`:  photo → upright, framed portrait + background matte + landmarks
 *    (`POST /v1/portraits/prepare`). No usable face ⇒ AppError('UNPROCESSABLE') with the
 *    engine's message and `details.reason` (`no_face`, `multiple_faces`, `not_frontal`…).
 *    `matteModel` says which model drew the matte: the dedicated one (ORMBG, `matting`) or the
 *    coarser fallback segmenter the engine degrades to when ORMBG is missing — never a failure.
 *  - `forget`:   deletes the features the engine cached for a prepared portrait
 *    (`engineAvatarCacheFile` in the shared work dir) when its avatar is deleted.
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
          // The engine keeps its least bad attempt when none passes its quality control:
          // the verdict travels with the portrait so nobody presents it as a clean one.
          ...(result.qcPassed !== undefined
            ? {
                quality: {
                  passed: result.qcPassed,
                  issues: result.qcIssues ?? [],
                  ...(result.attempts !== undefined ? { attempts: result.attempts } : {}),
                },
              }
            : {}),
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
          ...(result.matteModel !== undefined ? { matteModel: result.matteModel } : {}),
          provider: INFO,
        };
      } finally {
        await job.remove();
      }
    },

    async forget({ portraitSha256 }) {
      // The cache lives in the directory both processes share; a missing entry is fine.
      const file = path.join(resolveEngineWorkDir(env), engineAvatarCacheFile(portraitSha256));
      await fs.rm(file, { force: true });
    },
  };
}
