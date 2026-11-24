import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parseEnv } from '@parlante/shared/node';
import { providerEnvSchema } from '../env';
import {
  KOKORO_SOURCE,
  KOKORO_VARIANTS,
  KOKORO_VARIANT_IDS,
  PIPER_SOURCE,
  resolveVoiceModelDir,
} from '../tts/neural-models';
import type { KokoroVariant, VoiceModelFile, VoiceModelSource } from '../tts/neural-models';
import { inspectNeuralVoice, kokoroVoiceFiles, piperVoiceFiles } from '../tts/neural';
import { installVoiceFiles, removeVoiceFiles } from '../tts/neural-setup';
import type { VoiceInstallProgress } from '../tts/neural-setup';
import { KOKORO_VOICES, NEURAL_VOICES } from '../tts/neural-voices';
import type { NeuralVoiceDef } from '../tts/neural-voices';

/* -------------------------------------------------------------------------------------------
 * `pnpm voices:setup` — installs the local neural voices (Kokoro and Piper). Plain Node: works
 * the same on Windows, macOS and Linux.
 *
 *   pnpm voices:setup                       the default set: every Kokoro voice (Spanish,
 *                                           English, French, Italian, Portuguese)
 *   pnpm voices:setup --languages de,nl     the voices of those languages (and only those)
 *   pnpm voices:setup --voices <id>,<id>    those voices (ids as `--list` prints them)
 *   pnpm voices:setup --all                 every voice of the catalogue
 *   pnpm voices:setup --variant fp32        Kokoro in another precision (= VOICE_KOKORO_VARIANT)
 *   pnpm voices:setup --remove --voices …   delete the files of those voices
 *   pnpm voices:setup --dir D:\models       install somewhere else (= VOICE_MODEL_DIR)
 *   pnpm voices:setup --force               download and verify everything again
 *   pnpm voices:setup --list                show the catalogue and what is installed
 *
 * Files come only from huggingface.co, from pinned revisions, and each one is checked against
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
    languages: { type: 'string' },
    voices: { type: 'string' },
    all: { type: 'boolean', default: false },
    variant: { type: 'string' },
    dir: { type: 'string' },
    remove: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const voiceId = (def: NeuralVoiceDef): string => `${def.engine}:${def.providerVoiceId}`;
const languagesOffered = [...new Set(NEURAL_VOICES.map((def) => def.language.slice(0, 2)))];

if (values.help) {
  console.log(
    [
      'Usage: pnpm voices:setup [--languages es,en,…] [--voices <id>,…] [--all]',
      '                         [--variant <precision>] [--dir <path>] [--remove] [--force] [--list]',
      '',
      'Without options it installs the default set: Kokoro with all its voices',
      '(Spanish, English, French, Italian and Portuguese).',
      `Languages: ${languagesOffered.join(', ')}`,
      `Kokoro precisions: ${KOKORO_VARIANT_IDS.join(', ')}`,
      'Voice ids: run with --list.',
    ].join('\n'),
  );
  process.exit(0);
}

const baseEnv = parseEnv(providerEnvSchema);
if (values.variant !== undefined && !(values.variant in KOKORO_VARIANTS)) {
  console.error(
    `Unknown Kokoro precision "${values.variant}". Available: ${KOKORO_VARIANT_IDS.join(', ')}`,
  );
  process.exit(2);
}
const env = {
  ...baseEnv,
  VOICE_MODEL_DIR: values.dir ?? baseEnv.VOICE_MODEL_DIR,
  VOICE_KOKORO_VARIANT:
    (values.variant as KokoroVariant | undefined) ?? baseEnv.VOICE_KOKORO_VARIANT,
};
const modelsDir = resolveVoiceModelDir(env);

const filesOf = (def: NeuralVoiceDef): VoiceModelFile[] =>
  def.engine === 'kokoro' ? kokoroVoiceFiles(env, def) : piperVoiceFiles(def);
const sourceOf = (def: NeuralVoiceDef): VoiceModelSource =>
  def.engine === 'kokoro' ? KOKORO_SOURCE : PIPER_SOURCE;
const bytesOf = (files: readonly VoiceModelFile[]): number =>
  [...new Map(files.map((file) => [file.path, file])).values()].reduce(
    (sum, file) => sum + file.sizeBytes,
    0,
  );

if (values.list) {
  console.log(`Directory  ${modelsDir}`);
  console.log(
    `Kokoro     ${KOKORO_SOURCE.repo}@${KOKORO_SOURCE.revision.slice(0, 12)}  precision ${env.VOICE_KOKORO_VARIANT} (${mb(KOKORO_VARIANTS[env.VOICE_KOKORO_VARIANT].sizeBytes)}, shared by its voices)`,
  );
  console.log(`Piper      ${PIPER_SOURCE.repo}@${PIPER_SOURCE.revision.slice(0, 12)}`);
  console.log('');
  for (const def of NEURAL_VOICES) {
    const state = inspectNeuralVoice(env, def);
    const own =
      def.engine === 'kokoro' ? mb(filesOf(def).at(-1)?.sizeBytes ?? 0) : mb(bytesOf(filesOf(def)));
    console.log(
      `${voiceId(def).padEnd(34)} ${def.language.padEnd(6)} ${def.gender.padEnd(7)} ${def.name.padEnd(16)} ${own.padStart(9)}  ${def.license.padEnd(16)} ${
        state.installed ? 'installed' : (state.reasonCode ?? 'not installed')
      }`,
    );
  }
  process.exit(0);
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

const wantedLanguages = splitList(values.languages).map((code) => code.slice(0, 2).toLowerCase());
const wantedVoices = splitList(values.voices);
for (const code of wantedLanguages) {
  if (!languagesOffered.includes(code)) {
    console.error(
      `No neural voice for the language "${code}". Available: ${languagesOffered.join(', ')}`,
    );
    process.exit(2);
  }
}
const selected = new Map<string, NeuralVoiceDef>();
for (const id of wantedVoices) {
  const def = NEURAL_VOICES.find((voice) => voiceId(voice) === id || voice.providerVoiceId === id);
  if (!def) {
    console.error(`Unknown voice "${id}". Run "pnpm voices:setup --list" to see the ids.`);
    process.exit(2);
  }
  selected.set(voiceId(def), def);
}
for (const def of NEURAL_VOICES) {
  if (values.all || wantedLanguages.includes(def.language.slice(0, 2))) {
    selected.set(voiceId(def), def);
  }
}
if (selected.size === 0 && !values.remove) {
  // The default set: one model, every voice it has.
  for (const def of KOKORO_VOICES) selected.set(voiceId(def), def);
}
if (selected.size === 0) {
  console.error('Nothing selected: --remove needs --voices, --languages or --all.');
  process.exit(2);
}

const groups = [
  { label: 'Kokoro', source: KOKORO_SOURCE, license: 'Apache-2.0' },
  { label: 'Piper', source: PIPER_SOURCE, license: 'per voice (see --list)' },
].map((group) => {
  const voices = [...selected.values()].filter((def) => sourceOf(def) === group.source);
  return { ...group, voices, files: voices.flatMap(filesOf) };
});

if (values.remove) {
  for (const group of groups) {
    if (group.voices.length === 0) continue;
    // The Kokoro model and its symbol table are shared: they go only with the last voice.
    const keep = new Set(
      NEURAL_VOICES.filter((def) => sourceOf(def) === group.source && !selected.has(voiceId(def)))
        .filter((def) => inspectNeuralVoice(env, def).installed)
        .flatMap(filesOf)
        .map((file) => file.path),
    );
    const files = group.files.filter((file) => !keep.has(file.path));
    await removeVoiceFiles(modelsDir, group.source, files);
    console.log(
      `Removed ${group.voices.map(voiceId).join(', ')} (${mb(bytesOf(files))}) from ${modelsDir}`,
    );
  }
  process.exit(0);
}

const interactive = process.stdout.isTTY === true;
let lastLine = '';
let lastStep = -1;
function report(progress: VoiceInstallProgress): void {
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

console.log(`Directory      ${modelsDir}`);
let anyChange = false;
try {
  for (const group of groups) {
    if (group.voices.length === 0) continue;
    console.log('');
    console.log(
      `${group.label}: ${group.voices.map((def) => `${def.name} (${def.language})`).join(', ')}`,
    );
    console.log(
      `Source         https://huggingface.co/${group.source.repo}  revision ${group.source.revision}`,
    );
    console.log(`Licence        ${group.license}`);
    console.log(`Size           ${mb(bytesOf(group.files))}`);
    const startedAt = Date.now();
    const result = await installVoiceFiles({
      modelsDir,
      source: group.source,
      files: group.files,
      force: values.force,
      onProgress: report,
    });
    anyChange ||= result.changed;
    if (!result.changed) {
      console.log(`Already installed and verified in ${result.dir}. Nothing to do.`);
    } else {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `Installed in ${result.dir} (${mb(result.downloadedBytes)} downloaded, ${seconds} s).`,
      );
    }
  }
  if (env.VOICE_KOKORO_VARIANT !== baseEnv.VOICE_KOKORO_VARIANT) {
    console.log(
      `\nTo use this precision, set VOICE_KOKORO_VARIANT=${env.VOICE_KOKORO_VARIANT} in .env and restart API and worker.`,
    );
  } else if (anyChange) {
    console.log(
      '\nThe voices are available right away (the voice library and the selectors list them); no restart needed.',
    );
  }
} catch (err) {
  if (interactive && lastLine !== '') process.stdout.write('\n');
  console.error(
    `Could not install the voices: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    'Nothing unverified was kept. Check the connection to huggingface.co and run it again.',
  );
  process.exit(1);
}
