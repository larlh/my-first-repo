import fs from 'node:fs';
import path from 'node:path';
import type { DictationReasonCode } from '@parlante/shared';
import { findRepoRoot } from '@parlante/shared/node';
import type { ProviderEnv } from '../env';

/* -------------------------------------------------------------------------------------------
 * Catalogue of the local speech-recognition models (Whisper, multilingual, ONNX).
 *
 * Supply chain (docs/MODELS.md): weights are DATA files (ONNX + JSON) downloaded only from
 * huggingface.co, from a pinned repository REVISION, and every file is checked against the
 * size and SHA-256 written here. Nothing is fetched at run time: `pnpm dictation:setup`
 * installs a model, and the provider only ever reads the files it finds on disk.
 *
 * The SHA-256 of the .onnx files are the ones the Hub publishes for the LFS objects of the
 * pinned revision; the ones of the small JSON files were computed from that same revision.
 * ----------------------------------------------------------------------------------------- */

export interface WhisperModelFile {
  /** Path inside the repository and inside the install directory (always `/` separated). */
  path: string;
  sizeBytes: number;
  sha256: string;
}

/** ONNX data type per session, as @huggingface/transformers names them. */
export type WhisperDtype = 'fp32' | 'q8';

export interface WhisperModelDef {
  /** Value of DICTATION_MODEL. */
  id: string;
  /** Human name used in the provider reference ("Whisper base"). */
  label: string;
  /** Hugging Face repository and pinned commit. */
  repo: string;
  revision: string;
  license: string;
  commercialUse: boolean;
  dtype: { encoder_model: WhisperDtype; decoder_model_merged: WhisperDtype };
  files: readonly WhisperModelFile[];
}

const HUB = 'https://huggingface.co';

const TOKENIZER_FILES: readonly WhisperModelFile[] = [
  {
    path: 'preprocessor_config.json',
    sizeBytes: 339,
    sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
  },
  {
    path: 'tokenizer.json',
    sizeBytes: 2_480_466,
    sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
  },
  {
    path: 'tokenizer_config.json',
    sizeBytes: 282_683,
    sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce',
  },
];

const BASE_REPO = {
  repo: 'Xenova/whisper-base',
  revision: '64da57285918e20ea79ea5c88eed7197933abaa8',
  license: 'Apache-2.0',
  commercialUse: true,
} as const;

const BASE_CONFIG_FILES: readonly WhisperModelFile[] = [
  {
    path: 'config.json',
    sizeBytes: 2248,
    sha256: 'd1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b',
  },
  {
    path: 'generation_config.json',
    sizeBytes: 3776,
    sha256: '3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05',
  },
  ...TOKENIZER_FILES,
];

const SMALL_REPO = {
  repo: 'Xenova/whisper-small',
  revision: '2d67713f236afa48a18992566e7647f6ca848e13',
  license: 'Apache-2.0',
  commercialUse: true,
} as const;

const SMALL_CONFIG_FILES: readonly WhisperModelFile[] = [
  {
    path: 'config.json',
    sizeBytes: 2232,
    sha256: '5a6429d21d7a3379dd0861b74510f9f7076f32b563bffc9fcb072482d55ab3be',
  },
  {
    path: 'generation_config.json',
    sizeBytes: 3837,
    sha256: '0b7407a4e53a677f826e03c75d409e6f830663932bf43dda3b08c5efa2223279',
  },
  ...TOKENIZER_FILES,
];

/**
 * Models that can be installed. The default (`DEFAULT_WHISPER_MODEL`) was chosen by measuring
 * on a 4-core CPU (table in docs/MODELS.md); the others are documented alternatives.
 */
export const WHISPER_MODELS = {
  'whisper-base': {
    id: 'whisper-base',
    label: 'Whisper base',
    ...BASE_REPO,
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
    files: [
      ...BASE_CONFIG_FILES,
      {
        path: 'onnx/encoder_model.onnx',
        sizeBytes: 82_474_863,
        sha256: 'f0bd7927234639c6e1f293cef18a210cee4e4aea93e200ebbe48e1d7acf6fdb1',
      },
      {
        path: 'onnx/decoder_model_merged_quantized.onnx',
        sizeBytes: 53_707_539,
        sha256: 'a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861',
      },
    ],
  },
  'whisper-small': {
    id: 'whisper-small',
    label: 'Whisper small',
    ...SMALL_REPO,
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    files: [
      ...SMALL_CONFIG_FILES,
      {
        path: 'onnx/encoder_model_quantized.onnx',
        sizeBytes: 92_324_809,
        sha256: '969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06',
      },
      {
        path: 'onnx/decoder_model_merged_quantized.onnx',
        sizeBytes: 156_780_950,
        sha256: 'fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24',
      },
    ],
  },
} as const satisfies Record<string, WhisperModelDef>;

export type WhisperModelId = keyof typeof WHISPER_MODELS;
export const WHISPER_MODEL_IDS = Object.keys(WHISPER_MODELS) as [
  WhisperModelId,
  ...WhisperModelId[],
];
export const DEFAULT_WHISPER_MODEL: WhisperModelId = 'whisper-base';

export function whisperModel(id: WhisperModelId): WhisperModelDef {
  return WHISPER_MODELS[id];
}

/** Total download size of a model in bytes. */
export function whisperModelBytes(model: WhisperModelDef): number {
  return model.files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

/** URL of one file at the pinned revision (the only place weights are ever fetched from). */
export function whisperFileUrl(model: WhisperModelDef, file: WhisperModelFile): string {
  return `${HUB}/${model.repo}/resolve/${model.revision}/${file.path}`;
}

/** Absolute path of the directory that holds every model (DICTATION_MODEL_DIR). */
export function resolveDictationModelDir(env: Pick<ProviderEnv, 'DICTATION_MODEL_DIR'>): string {
  return path.isAbsolute(env.DICTATION_MODEL_DIR)
    ? env.DICTATION_MODEL_DIR
    : path.resolve(findRepoRoot(), env.DICTATION_MODEL_DIR);
}

/**
 * Folder of one model inside the models directory: `<org>--<repo>-<revision, 12 chars>`. The
 * revision is part of the name so that pinning another commit never mixes two sets of files.
 */
export function whisperModelFolder(model: WhisperModelDef): string {
  return `${model.repo.replace('/', '--')}-${model.revision.slice(0, 12)}`;
}

/** Name of the marker written by the installer once every file passed its SHA-256 check. */
export const WHISPER_INSTALL_MARKER = 'parlante-model.json';

export interface WhisperInstallMarker {
  model: string;
  repo: string;
  revision: string;
  verifiedAt: string;
  files: WhisperModelFile[];
}

export interface WhisperInstallState {
  installed: boolean;
  /** Why not, as a translatable code (null when installed). */
  reasonCode: DictationReasonCode | null;
  reason: string | null;
  /** Absolute path of the model folder (whether or not it exists). */
  dir: string;
}

/**
 * Cheap check (a few `stat` calls, no hashing) that a model is installed: the marker of the
 * installer is there and names every file of the catalogue with its SHA-256, and every file
 * exists with the expected size. Hashes themselves are verified by the installer, which
 * writes the marker last.
 */
export function inspectWhisperInstall(
  modelsDir: string,
  model: WhisperModelDef,
): WhisperInstallState {
  const dir = path.join(modelsDir, whisperModelFolder(model));
  const hint = `run "pnpm dictation:setup"`;
  let marker: WhisperInstallMarker;
  try {
    marker = JSON.parse(
      fs.readFileSync(path.join(dir, WHISPER_INSTALL_MARKER), 'utf8'),
    ) as WhisperInstallMarker;
  } catch {
    const partial = fs.existsSync(dir);
    return {
      installed: false,
      reasonCode: partial ? 'model_incomplete' : 'model_not_installed',
      reason: partial
        ? `The speech model ${model.id} is only partly downloaded: ${hint}`
        : `The speech model ${model.id} is not installed: ${hint}`,
      dir,
    };
  }
  const verified = new Map((marker.files ?? []).map((file) => [file.path, file.sha256]));
  for (const file of model.files) {
    let size: number;
    try {
      size = fs.statSync(path.join(dir, ...file.path.split('/'))).size;
    } catch {
      size = -1;
    }
    if (size !== file.sizeBytes || verified.get(file.path) !== file.sha256) {
      return {
        installed: false,
        reasonCode: 'model_incomplete',
        reason: `The speech model ${model.id} is incomplete (${file.path}): ${hint}`,
        dir,
      };
    }
  }
  return { installed: true, reasonCode: null, reason: null, dir };
}
