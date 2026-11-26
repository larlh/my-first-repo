import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parseEnv } from '@parlante/shared/node';
import { providerEnvSchema } from '../env';
import {
  WHISPER_MODELS,
  WHISPER_MODEL_IDS,
  inspectWhisperInstall,
  resolveDictationModelDir,
  whisperModel,
  whisperModelBytes,
} from '../stt/whisper-models';
import type { WhisperModelId } from '../stt/whisper-models';
import { installWhisperModel } from '../stt/whisper-setup';
import type { InstallProgress } from '../stt/whisper-setup';

/* -------------------------------------------------------------------------------------------
 * `pnpm dictation:setup` — installs the local speech model used by dictation (and by video
 * translation when no STT key is set). Plain Node: works the same on Windows, macOS and Linux.
 *
 *   pnpm dictation:setup                         install DICTATION_MODEL (default model)
 *   pnpm dictation:setup --model whisper-small   install another model of the catalogue
 *   pnpm dictation:setup --dir D:\models         install somewhere else (= DICTATION_MODEL_DIR)
 *   pnpm dictation:setup --force                 download and verify everything again
 *   pnpm dictation:setup --list                  show the catalogue and what is installed
 *
 * Files come only from huggingface.co, from a pinned revision, and each one is checked against
 * the size and SHA-256 of the catalogue before it is accepted. Running it again is harmless.
 * ----------------------------------------------------------------------------------------- */

const MB = 1000 * 1000;
const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

// Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set BEFORE it starts: behind
// a proxy, run this same script again with it (once).
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
if (proxy && process.env.NODE_USE_ENV_PROXY !== '1') {
  const child = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  });
  process.exit(child.status ?? 1);
}

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    dir: { type: 'string' },
    force: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(
    [
      'Usage: pnpm dictation:setup [--model <id>] [--dir <path>] [--force] [--list]',
      '',
      `Models: ${WHISPER_MODEL_IDS.join(', ')}`,
      'Without --model it installs DICTATION_MODEL (see .env.example).',
    ].join('\n'),
  );
  process.exit(0);
}

const env = parseEnv(providerEnvSchema);
if (values.model !== undefined && !(values.model in WHISPER_MODELS)) {
  console.error(`Unknown model "${values.model}". Available: ${WHISPER_MODEL_IDS.join(', ')}`);
  process.exit(2);
}
const modelId = (values.model as WhisperModelId | undefined) ?? env.DICTATION_MODEL;
const modelsDir = resolveDictationModelDir({
  DICTATION_MODEL_DIR: values.dir ?? env.DICTATION_MODEL_DIR,
});

if (values.list) {
  for (const id of WHISPER_MODEL_IDS) {
    const def = whisperModel(id);
    const state = inspectWhisperInstall(modelsDir, def);
    console.log(
      `${id.padEnd(16)} ${mb(whisperModelBytes(def)).padStart(9)}  ${def.repo}@${def.revision.slice(0, 12)}  ${def.license}  ${
        state.installed ? `installed in ${state.dir}` : (state.reasonCode ?? 'not installed')
      }${id === env.DICTATION_MODEL ? '  (DICTATION_MODEL)' : ''}`,
    );
  }
  process.exit(0);
}

const model = whisperModel(modelId);
const total = whisperModelBytes(model);
console.log(`Speech model   ${model.id} (${model.label})`);
console.log(`Source         https://huggingface.co/${model.repo}  revision ${model.revision}`);
console.log(`Licence        ${model.license}`);
console.log(`Download size  ${mb(total)} in ${model.files.length} files`);
console.log(`Directory      ${modelsDir}`);

const interactive = process.stdout.isTTY === true;
let lastLine = '';
let lastStep = -1;
function report(progress: InstallProgress): void {
  const percent = Math.floor((progress.receivedBytes / progress.totalBytes) * 100);
  if (progress.phase === 'done') {
    const line = `  ${progress.reused ? 'verified  ' : 'downloaded'} ${progress.file} (${mb(progress.totalBytes)}, sha256 ok)`;
    if (interactive) process.stdout.write(`\r${' '.repeat(lastLine.length)}\r`);
    console.log(line);
    lastLine = '';
    lastStep = -1;
    return;
  }
  const verb = progress.phase === 'verify' ? 'verifying  ' : 'downloading';
  const line = `  ${verb} ${progress.file} ${String(percent).padStart(3)}% of ${mb(progress.totalBytes)}`;
  if (interactive) {
    if (line === lastLine) return;
    process.stdout.write(`\r${line}`);
    lastLine = line;
  } else {
    // Not a terminal (CI, a log file): one line every 25 %.
    const step = Math.floor(percent / 25);
    if (step === lastStep) return;
    lastStep = step;
    console.log(line);
  }
}

try {
  const startedAt = Date.now();
  const result = await installWhisperModel({
    modelsDir,
    model,
    force: values.force,
    onProgress: report,
  });
  if (!result.changed) {
    console.log(`Already installed and verified in ${result.dir}. Nothing to do.`);
  } else {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `Installed in ${result.dir} (${mb(result.downloadedBytes)} downloaded, ${seconds} s).`,
    );
  }
  if (modelId !== env.DICTATION_MODEL) {
    console.log(`To use it, set DICTATION_MODEL=${modelId} in .env and restart API and worker.`);
  } else if (result.changed) {
    console.log(
      'Dictation uses it right away. Restart API and worker so that STT_PROVIDER=auto (video translation) picks it up too.',
    );
  }
} catch (err) {
  if (interactive && lastLine !== '') process.stdout.write('\n');
  console.error(
    `Could not install ${model.id}: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    'Nothing unverified was kept. Check the connection to huggingface.co and run it again.',
  );
  process.exit(1);
}
