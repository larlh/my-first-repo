import fs from 'node:fs';
import path from 'node:path';
import type { VoiceInstallReasonCode } from '@parlante/shared';
import { findRepoRoot } from '@parlante/shared/node';

/* -------------------------------------------------------------------------------------------
 * Files of the local neural voices (Kokoro and Piper), with where each one comes from.
 *
 * Supply chain (docs/MODELS.md): weights are DATA files — ONNX graphs, raw float32 tensors
 * (`.bin`) and JSON — downloaded only from huggingface.co, from a pinned repository REVISION,
 * and every file is checked against the size and SHA-256 written here before it is accepted.
 * Nothing is fetched at run time: `pnpm voices:setup` installs, the providers only read what
 * they find on disk. The inference code is ours (neural-synth.ts, neural-worker.mjs).
 *
 * The SHA-256 of the .onnx / .bin files are the ones the Hub publishes for the LFS objects of
 * the pinned revisions; the ones of the JSON files were computed from those same revisions.
 * ----------------------------------------------------------------------------------------- */

export interface VoiceModelFile {
  /** Path inside the repository and inside the install folder (always `/` separated). */
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface VoiceModelSource {
  repo: string;
  revision: string;
}

const HUB = 'https://huggingface.co';

/* ---------- Kokoro ---------- */

/**
 * ONNX export of Kokoro-82M v1.0 that also returns the predicted duration of every input
 * token (`durations`), which is what makes lip-sync follow the real audio. Apache-2.0.
 */
export const KOKORO_SOURCE: VoiceModelSource = {
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped',
  revision: 'dd4401a9add81ac692d20e240d22ec9dda82cc29',
};

/** Symbol table of the model (`model.vocab`): phoneme → input id. */
export const KOKORO_TOKENIZER: VoiceModelFile = {
  path: 'tokenizer.json',
  sizeBytes: 3497,
  sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
};

/**
 * Precisions of the same weights that Parlante offers. Chosen by measuring on a 4-core CPU
 * (docs/MODELS.md), in interleaved rounds under the same load:
 *
 *   uint8  the default: the fastest (about 15 % quicker than fp32), half its download and
 *          0.15 GB less memory; against the local Whisper model its word error rate is that of
 *          fp32 in English and one word in 139 worse in Spanish (within the noise)
 *   fp32   the original weights, for whoever prefers no quantisation at all
 *   q8     the smallest download and memory (92 MB / 0.6 GB), but about three times slower
 *
 * The repository has five more files that are NOT offered, each for a measured reason:
 * `model_fp16.onnx` and `model_q4f16.onnx` return silence for some sentences on the CPU (word
 * error rate 11–27 % instead of 1–3 %); `model_q8f16.onnx` crashes ONNX Runtime 1.30 while it
 * loads (segmentation fault: the whole process dies); `model_uint8f16.onnx` and `model_q4.onnx`
 * work but are slower than `uint8` without being smaller or better.
 */
export const KOKORO_VARIANTS = {
  uint8: {
    path: 'onnx/model_uint8.onnx',
    sizeBytes: 177_464_571,
    sha256: 'b44c5c0d90458a8d9175cea933ff6d8a6351b74f1e651060df48672f5a167e4f',
  },
  fp32: {
    path: 'onnx/model.onnx',
    sizeBytes: 325_532_171,
    sha256: '651ea8291843a92276a4a003581a215cb07d15e47dde6fcfb1b768f9a1682054',
  },
  q8: {
    path: 'onnx/model_quantized.onnx',
    sizeBytes: 92_361_055,
    sha256: 'c0c02b3299fd97c34ea92a98e6d41eaa1a739c8f77bf685aac34bd7b34c1132c',
  },
} as const satisfies Record<string, VoiceModelFile>;

export type KokoroVariant = keyof typeof KOKORO_VARIANTS;
export const KOKORO_VARIANT_IDS = Object.keys(KOKORO_VARIANTS) as [
  KokoroVariant,
  ...KokoroVariant[],
];

/** Chosen by measurement (docs/MODELS.md). */
export const DEFAULT_KOKORO_VARIANT: KokoroVariant = 'uint8';

/** Style tensors of the Kokoro voices Parlante offers: float32 [510, 1, 256], raw. */
export const KOKORO_VOICE_FILES = {
  ef_dora: {
    path: 'voices/ef_dora.bin',
    sizeBytes: 522_240,
    sha256: 'f66ec66bd295acb18372e37008533a9a3228483ccd294e7538d5d9294ac9a532',
  },
  em_alex: {
    path: 'voices/em_alex.bin',
    sizeBytes: 522_240,
    sha256: '27809e9eafdcbcfff90a3016c697568676531de2a2c39cee29c96c7bd6b83e95',
  },
  af_heart: {
    path: 'voices/af_heart.bin',
    sizeBytes: 522_240,
    sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  },
  af_bella: {
    path: 'voices/af_bella.bin',
    sizeBytes: 522_240,
    sha256: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  },
  am_michael: {
    path: 'voices/am_michael.bin',
    sizeBytes: 522_240,
    sha256: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  },
  am_fenrir: {
    path: 'voices/am_fenrir.bin',
    sizeBytes: 522_240,
    sha256: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43',
  },
  bf_emma: {
    path: 'voices/bf_emma.bin',
    sizeBytes: 522_240,
    sha256: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  },
  bm_george: {
    path: 'voices/bm_george.bin',
    sizeBytes: 522_240,
    sha256: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
  },
  ff_siwis: {
    path: 'voices/ff_siwis.bin',
    sizeBytes: 522_240,
    sha256: 'a35f5675ad08948e326ae75fd0ea16ba5d0042e4f76b5f3d1df77d0a48c54861',
  },
  if_sara: {
    path: 'voices/if_sara.bin',
    sizeBytes: 522_240,
    sha256: '409b69248798fcdc2542330c76953d230710f19b057e59cb82fdc3c4cf71265c',
  },
  im_nicola: {
    path: 'voices/im_nicola.bin',
    sizeBytes: 522_240,
    sha256: 'bc578e510d52a96d6940d46f12e96d7b3df00905dbea075113226d100e6e1ab0',
  },
  pf_dora: {
    path: 'voices/pf_dora.bin',
    sizeBytes: 522_240,
    sha256: '3da7b5b2d91847ebf5646f57631af6ececae3c29a89cd300f06edf9aa6cfe9ee',
  },
  pm_alex: {
    path: 'voices/pm_alex.bin',
    sizeBytes: 522_240,
    sha256: '0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a',
  },
} as const satisfies Record<string, VoiceModelFile>;

export type KokoroVoiceFileId = keyof typeof KOKORO_VOICE_FILES;

/* ---------- Piper ---------- */

/**
 * Piper voices (VITS exported to ONNX, one graph per voice). The repository is MIT; every
 * voice carries its own licence in its MODEL_CARD — only the ones that allow commercial use,
 * for the dataset AND for the checkpoint it was fine-tuned from, are listed (docs/MODELS.md).
 */
export const PIPER_SOURCE: VoiceModelSource = {
  repo: 'rhasspy/piper-voices',
  revision: 'e5349433ed883a32f893a434dc43a6c66b95ef7c',
};

export interface PiperVoiceFiles {
  onnx: VoiceModelFile;
  /** `<voice>.onnx.json`: sample rate, phoneme → id table, inference scales, speakers. */
  config: VoiceModelFile;
}

export const PIPER_VOICE_FILES = {
  'de_DE-thorsten-medium': {
    onnx: {
      path: 'de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx',
      sizeBytes: 63_221_984,
      sha256: 'fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f',
    },
    config: {
      path: 'de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx.json',
      sizeBytes: 6455,
      sha256: 'e5bb7410dcbbcc0be6f4544f6bc66612b315ab5cb3099ec44bb46d860bc7cca9',
    },
  },
  'de_DE-kerstin-medium': {
    onnx: {
      path: 'de/de_DE/kerstin/medium/de_DE-kerstin-medium.onnx',
      sizeBytes: 63_221_984,
      sha256: 'c56d70475fb99248a20e60dafbcd107475e60d7e01deec18ba65201d288d015d',
    },
    config: {
      path: 'de/de_DE/kerstin/medium/de_DE-kerstin-medium.onnx.json',
      sizeBytes: 6390,
      sha256: 'cf620f4fa16400f7e49d16b08fda3979d50f12d245870c0657e3b2e7ebf05081',
    },
  },
  'nl_BE-nathalie-medium': {
    onnx: {
      path: 'nl/nl_BE/nathalie/medium/nl_BE-nathalie-medium.onnx',
      sizeBytes: 63_221_984,
      sha256: '2f12aea027806c24a0e9fb00080d2ee4cb0954604cc74e2fcdfe40b5d1015a09',
    },
    config: {
      path: 'nl/nl_BE/nathalie/medium/nl_BE-nathalie-medium.onnx.json',
      sizeBytes: 6251,
      sha256: 'eb3acc456a61317d72c34a5ca97a047e60a6e7b8b31a9b9cb9318d5217374034',
    },
  },
  'nl_NL-pim-medium': {
    onnx: {
      path: 'nl/nl_NL/pim/medium/nl_NL-pim-medium.onnx',
      sizeBytes: 63_221_984,
      sha256: '1e1ed370c3b60ca734e525bdcd1f05f71b42bfb0a15693f1e89c012d72052d2a',
    },
    config: {
      path: 'nl/nl_NL/pim/medium/nl_NL-pim-medium.onnx.json',
      sizeBytes: 6288,
      sha256: 'eaf09475a6b62191e2f3045202d63b9eb77d5f9769cf2de2f12d4d3c046bf3ac',
    },
  },
  'pl_PL-gosia-medium': {
    onnx: {
      path: 'pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx',
      sizeBytes: 63_221_984,
      sha256: 'd322ded1f1daffeab41bbacd43d6f62ac83a4a5d4d63a297aa39f345f506b358',
    },
    config: {
      path: 'pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx.json',
      sizeBytes: 6131,
      sha256: 'f0cc2f4f53d60274a79bf6ec9d8d17c02e188ae3c7cc170f6d308a97526c351b',
    },
  },
  'pl_PL-darkman-medium': {
    onnx: {
      path: 'pl/pl_PL/darkman/medium/pl_PL-darkman-medium.onnx',
      sizeBytes: 63_221_984,
      sha256: 'cf757ee307e3a7c23d5d8f69934deab51683d01c1c6be376d3e13146020f1530',
    },
    config: {
      path: 'pl/pl_PL/darkman/medium/pl_PL-darkman-medium.onnx.json',
      sizeBytes: 6133,
      sha256: '1208a7d257daba8d0a421e9f55ec8210db009d785cd4f7e0b0c9936b3168f1a0',
    },
  },
  'ru_RU-denis-medium': {
    onnx: {
      path: 'ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx',
      sizeBytes: 63_221_984,
      sha256: '879bc365cb14d1380e3f5ed6044162ccf54c99f6161871569b7f830aec3ce841',
    },
    config: {
      path: 'ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx.json',
      sizeBytes: 6196,
      sha256: '5891b94580ae739a8cdc5d17591db6800333f85164d13599aca893883d99b9eb',
    },
  },
  'sv_SE-nst-medium': {
    onnx: {
      path: 'sv/sv_SE/nst/medium/sv_SE-nst-medium.onnx',
      sizeBytes: 63_104_526,
      sha256: 'df011f56825a59dd1efc080c38a65a1ef70407e60f63050e9246f43a3d7e471e',
    },
    config: {
      path: 'sv/sv_SE/nst/medium/sv_SE-nst-medium.onnx.json',
      sizeBytes: 4157,
      sha256: 'd45dd74cbb4eca58694bf04a97e243044092476f28a55ae26424f0653086980a',
    },
  },
  'sv_SE-alma-medium': {
    onnx: {
      path: 'sv/sv_SE/alma/medium/sv_SE-alma-medium.onnx',
      sizeBytes: 63_434_611,
      sha256: 'f75455eb6afeb1db9e2905d5bd7e4115afcd3710e0d399b6a40981766d32fedc',
    },
    config: {
      path: 'sv/sv_SE/alma/medium/sv_SE-alma-medium.onnx.json',
      sizeBytes: 6059,
      sha256: '6924380892f769afa92fc6b28ff91d558690d7fb4e3ef8cbf821cefadc8f38fe',
    },
  },
  'el_GR-rapunzelina-medium': {
    onnx: {
      path: 'el/el_GR/rapunzelina/medium/el_GR-rapunzelina-medium.onnx',
      sizeBytes: 62_950_044,
      sha256: '3ca9fb3092215ee92edfc019b43feb0115ff4dfe638eb34474833ab1de840952',
    },
    config: {
      path: 'el/el_GR/rapunzelina/medium/el_GR-rapunzelina-medium.onnx.json',
      sizeBytes: 4973,
      sha256: '3a6182ec7c7550e14ef15e5d9badbb18f973a434086ac9658a1b10991fd192f8',
    },
  },
  'ca_ES-upc_ona-x_low': {
    onnx: {
      path: 'ca/ca_ES/upc_ona/x_low/ca_ES-upc_ona-x_low.onnx',
      sizeBytes: 20_628_813,
      sha256: '13661d26423e0c791823823a5971f4e1aaf644a62e65e0e94d299c0e70560e14',
    },
    config: {
      path: 'ca/ca_ES/upc_ona/x_low/ca_ES-upc_ona-x_low.onnx.json',
      sizeBytes: 4159,
      sha256: '00e12b206e6ca676e6f992973551b4e068edd9823608144a60365c010dc6bb2f',
    },
  },
  'ca_ES-upc_pau-x_low': {
    onnx: {
      path: 'ca/ca_ES/upc_pau/x_low/ca_ES-upc_pau-x_low.onnx',
      sizeBytes: 28_130_791,
      sha256: 'c936a1a78b0a795af3c2422a0f2edb26303c389ff961616902ba12e26b489071',
    },
    config: {
      path: 'ca/ca_ES/upc_pau/x_low/ca_ES-upc_pau-x_low.onnx.json',
      sizeBytes: 4159,
      sha256: 'f3e76f0640c73a0a87482b37e5c85dd93532127f81e37ea2875e0dace28bb1e2',
    },
  },
  'es_ES-davefx-medium': {
    onnx: {
      path: 'es/es_ES/davefx/medium/es_ES-davefx-medium.onnx',
      sizeBytes: 63_221_984,
      sha256: 'd2c9224e122321aac3c33343957fff4d0f465226cb74c66b0f520ca3f8c0dd07',
    },
    config: {
      path: 'es/es_ES/davefx/medium/es_ES-davefx-medium.onnx.json',
      sizeBytes: 6175,
      sha256: '7d82d069eccca0f87963bd23c33166fe1ef6d24a6b231543931bfe692397f256',
    },
  },
  'es_ES-sharvard-medium': {
    onnx: {
      path: 'es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx',
      sizeBytes: 76_753_841,
      sha256: '234dc4cf0fdb53ccb76b9b2c4d7ef1330364762674c1b78c1b62d8608c528a54',
    },
    config: {
      path: 'es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx.json',
      sizeBytes: 6160,
      sha256: 'c3d92a576c2fb5ac5120c9feeb6dd09e6577a564e20c75b91981ee1ceb441a90',
    },
  },
  'es_MX-ald-medium': {
    onnx: {
      path: 'es/es_MX/ald/medium/es_MX-ald-medium.onnx',
      sizeBytes: 63_221_984,
      sha256: '6ca4b9bc22b3fa19792c212822186fa0f34cb73c1bdced6be83e4038aa946e10',
    },
    config: {
      path: 'es/es_MX/ald/medium/es_MX-ald-medium.onnx.json',
      sizeBytes: 6173,
      sha256: '94bd0137c7736b2b13ec5c04943e4a0a121b2793ad4bf20c64d625365839edc9',
    },
  },
} as const satisfies Record<string, PiperVoiceFiles>;

export type PiperVoiceFileId = keyof typeof PIPER_VOICE_FILES;

/* ---------- where files live ---------- */

/** URL of one file at the pinned revision (the only place weights are ever fetched from). */
export function voiceFileUrl(source: VoiceModelSource, file: VoiceModelFile): string {
  const encoded = file.path.split('/').map(encodeURIComponent).join('/');
  return `${HUB}/${source.repo}/resolve/${source.revision}/${encoded}`;
}

/** Absolute path of the directory that holds every voice model (VOICE_MODEL_DIR). */
export function resolveVoiceModelDir(env: { VOICE_MODEL_DIR: string }): string {
  return path.isAbsolute(env.VOICE_MODEL_DIR)
    ? env.VOICE_MODEL_DIR
    : path.resolve(findRepoRoot(), env.VOICE_MODEL_DIR);
}

/**
 * Folder of one repository inside the models directory: `<org>--<repo>-<revision, 12 chars>`.
 * The revision is part of the name so that pinning another commit never mixes two sets of files.
 */
export function voiceSourceFolder(source: VoiceModelSource): string {
  return `${source.repo.replace('/', '--')}-${source.revision.slice(0, 12)}`;
}

/** Absolute path of one file of a repository. */
export function voiceFilePath(
  modelsDir: string,
  source: VoiceModelSource,
  file: VoiceModelFile,
): string {
  return path.join(modelsDir, voiceSourceFolder(source), ...file.path.split('/'));
}

/* ---------- what is installed ---------- */

/**
 * Written by the installer in each repository folder: the files that passed their SHA-256
 * check. A file that is on disk but not in the marker was never verified and does not count.
 */
export const VOICE_INSTALL_MARKER = 'parlante-voices.json';

export interface VoiceInstallMarker {
  repo: string;
  revision: string;
  /** path → SHA-256 that was verified. */
  files: Record<string, string>;
}

export function readVoiceMarker(modelsDir: string, source: VoiceModelSource): VoiceInstallMarker {
  const empty: VoiceInstallMarker = { repo: source.repo, revision: source.revision, files: {} };
  try {
    const file = path.join(modelsDir, voiceSourceFolder(source), VOICE_INSTALL_MARKER);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VoiceInstallMarker>;
    if (parsed.repo !== source.repo || parsed.revision !== source.revision) return empty;
    return { ...empty, files: { ...(parsed.files ?? {}) } };
  } catch {
    return empty;
  }
}

export interface VoiceInstallState {
  installed: boolean;
  /** Why not, as a translatable code (null when installed). */
  reasonCode: VoiceInstallReasonCode | null;
  /** English sentence for logs. */
  reason: string | null;
}

/**
 * Cheap check (a few `stat` calls, no hashing) that a set of files is installed: each one is
 * named by the installer's marker with the SHA-256 of the catalogue and exists with the
 * expected size. Hashes themselves are verified by the installer.
 */
export function inspectVoiceFiles(
  modelsDir: string,
  source: VoiceModelSource,
  files: readonly VoiceModelFile[],
  marker: VoiceInstallMarker = readVoiceMarker(modelsDir, source),
): VoiceInstallState {
  let present = 0;
  let missing: string | null = null;
  for (const file of files) {
    let size: number;
    try {
      size = fs.statSync(voiceFilePath(modelsDir, source, file)).size;
    } catch {
      size = -1;
    }
    if (size === file.sizeBytes && marker.files[file.path] === file.sha256) present += 1;
    else missing ??= file.path;
  }
  if (missing === null) return { installed: true, reasonCode: null, reason: null };
  const partial = present > 0;
  return {
    installed: false,
    reasonCode: partial ? 'voice_incomplete' : 'voice_not_installed',
    reason: partial
      ? `The voice model is only partly downloaded (${missing}): run "pnpm voices:setup"`
      : `The voice model is not installed (${missing}): run "pnpm voices:setup"`,
  };
}
