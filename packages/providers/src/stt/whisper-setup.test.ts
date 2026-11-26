import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WHISPER_MODEL,
  WHISPER_INSTALL_MARKER,
  WHISPER_MODELS,
  WHISPER_MODEL_IDS,
  inspectWhisperInstall,
  whisperFileUrl,
  whisperModelBytes,
  whisperModelFolder,
} from './whisper-models';
import type { WhisperModelDef } from './whisper-models';
import { ModelIntegrityError, installWhisperModel } from './whisper-setup';
import type { FetchLike, InstallProgress } from './whisper-setup';

/*
 * The installer against a scripted download server and a tiny made-up model: the logic is the
 * same for the real catalogue, whose files are far too large for a unit test. The real
 * download was exercised by hand with `pnpm dictation:setup` (docs/MODELS.md).
 */

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const CONTENT: Record<string, Buffer> = {
  'config.json': Buffer.from('{"model_type":"whisper"}'),
  'onnx/encoder_model.onnx': Buffer.alloc(70_000, 7),
  'onnx/decoder_model_merged_quantized.onnx': Buffer.alloc(30_000, 9),
};
const MODEL: WhisperModelDef = {
  id: 'test-model',
  label: 'Test model',
  repo: 'acme/whisper-test',
  revision: '0123456789abcdef0123456789abcdef01234567',
  license: 'Apache-2.0',
  commercialUse: true,
  dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
  files: Object.entries(CONTENT).map(([file, data]) => ({
    path: file,
    sizeBytes: data.length,
    sha256: sha(data),
  })),
};

function server(overrides: Record<string, Buffer | number> = {}) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const file = MODEL.files.find((candidate) => whisperFileUrl(MODEL, candidate) === url);
    if (!file) return new Response('not found', { status: 404 });
    const override = overrides[file.path];
    if (typeof override === 'number') return new Response('nope', { status: override });
    const body = override ?? CONTENT[file.path] ?? Buffer.alloc(0);
    // Two chunks, so progress is reported more than once.
    const half = Math.floor(body.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(body.subarray(0, half)));
        controller.enqueue(new Uint8Array(body.subarray(half)));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
  return { calls, fetch: fetchImpl };
}

let modelsDir: string;
beforeEach(async () => {
  modelsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-models-'));
});
afterEach(async () => {
  await fs.rm(modelsDir, { recursive: true, force: true });
});

const modelDir = () => path.join(modelsDir, whisperModelFolder(MODEL));
const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

describe('catalogue', () => {
  it('pins every model to a repository revision with a size and SHA-256 per file', () => {
    expect(WHISPER_MODEL_IDS).toContain(DEFAULT_WHISPER_MODEL);
    for (const id of WHISPER_MODEL_IDS) {
      const model: WhisperModelDef = WHISPER_MODELS[id];
      expect(model.id).toBe(id);
      expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(model.repo).toMatch(/^[\w-]+\/[\w.-]+$/);
      expect(model.license).toBe('Apache-2.0');
      const paths = model.files.map((file) => file.path);
      expect(new Set(paths).size).toBe(paths.length);
      // Data formats only: ONNX graphs and JSON configuration — never pickled code.
      for (const file of model.files) {
        expect(file.path).toMatch(/\.(onnx|json)$/);
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.sizeBytes).toBeGreaterThan(0);
        expect(whisperFileUrl(model, file)).toBe(
          `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`,
        );
      }
      // The files the runtime asks for, given the data types of the model.
      const suffix = (dtype: string) => (dtype === 'q8' ? '_quantized' : '');
      expect(paths).toEqual(
        expect.arrayContaining([
          'config.json',
          'generation_config.json',
          'preprocessor_config.json',
          'tokenizer.json',
          'tokenizer_config.json',
          `onnx/encoder_model${suffix(model.dtype.encoder_model)}.onnx`,
          `onnx/decoder_model_merged${suffix(model.dtype.decoder_model_merged)}.onnx`,
        ]),
      );
      expect(whisperModelBytes(model)).toBeGreaterThan(50 * 1024 * 1024);
      // `--` keeps the folder from ever being a valid Hub id (the runtime reads it as a path).
      expect(whisperModelFolder(model)).toContain('--');
    }
  });
});

describe('installWhisperModel', () => {
  it('downloads, verifies and marks a model; a second run does nothing', async () => {
    const { calls, fetch } = server();
    expect(inspectWhisperInstall(modelsDir, MODEL)).toMatchObject({
      installed: false,
      reasonCode: 'model_not_installed',
    });
    const progress: InstallProgress[] = [];
    const result = await installWhisperModel({
      modelsDir,
      model: MODEL,
      fetch,
      onProgress: (p) => progress.push({ ...p }),
    });
    expect(result).toMatchObject({
      dir: modelDir(),
      changed: true,
      downloadedBytes: whisperModelBytes(MODEL),
      totalBytes: whisperModelBytes(MODEL),
    });
    expect(calls).toEqual(MODEL.files.map((file) => whisperFileUrl(MODEL, file)));
    for (const [file, data] of Object.entries(CONTENT)) {
      expect(await fs.readFile(path.join(modelDir(), ...file.split('/')))).toEqual(data);
      expect(await exists(path.join(modelDir(), ...`${file}.part`.split('/')))).toBe(false);
    }
    // Progress: bytes grow, and every file ends with a `done`.
    expect(progress.filter((p) => p.phase === 'done').map((p) => p.file)).toEqual(
      MODEL.files.map((file) => file.path),
    );
    const encoder = progress.filter(
      (p) => p.file === 'onnx/encoder_model.onnx' && p.phase === 'download',
    );
    expect(encoder.map((p) => p.receivedBytes)).toEqual([35_000, 70_000]);
    expect(inspectWhisperInstall(modelsDir, MODEL)).toEqual({
      installed: true,
      reasonCode: null,
      reason: null,
      dir: modelDir(),
    });

    const again = await installWhisperModel({ modelsDir, model: MODEL, fetch });
    expect(again).toMatchObject({ changed: false, downloadedBytes: 0 });
    expect(calls).toHaveLength(MODEL.files.length); // no new request
  });

  it('rejects a file whose content does not match its SHA-256 and leaves nothing behind', async () => {
    const tampered = Buffer.alloc(70_000, 8); // right size, wrong bytes
    const { fetch } = server({ 'onnx/encoder_model.onnx': tampered });
    const error = await installWhisperModel({ modelsDir, model: MODEL, fetch }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ModelIntegrityError);
    expect(error).toMatchObject({ file: 'onnx/encoder_model.onnx', problem: 'sha256' });
    expect(await exists(path.join(modelDir(), 'onnx', 'encoder_model.onnx'))).toBe(false);
    expect(await exists(path.join(modelDir(), 'onnx', 'encoder_model.onnx.part'))).toBe(false);
    expect(await exists(path.join(modelDir(), WHISPER_INSTALL_MARKER))).toBe(false);
    expect(inspectWhisperInstall(modelsDir, MODEL)).toMatchObject({
      installed: false,
      reasonCode: 'model_incomplete',
    });
  });

  it('rejects files that are shorter or longer than the catalogue says', async () => {
    const short = server({ 'config.json': Buffer.from('{}') });
    await expect(
      installWhisperModel({ modelsDir, model: MODEL, fetch: short.fetch }),
    ).rejects.toMatchObject({ problem: 'size', file: 'config.json' });
    const long = server({ 'config.json': Buffer.alloc(5000, 1) });
    await expect(
      installWhisperModel({ modelsDir, model: MODEL, fetch: long.fetch }),
    ).rejects.toMatchObject({ problem: 'size', file: 'config.json' });
    expect(await exists(path.join(modelDir(), 'config.json'))).toBe(false);
  });

  it('fails clearly when the server refuses a file', async () => {
    const { fetch } = server({ 'onnx/decoder_model_merged_quantized.onnx': 503 });
    await expect(installWhisperModel({ modelsDir, model: MODEL, fetch })).rejects.toThrow(
      /decoder_model_merged_quantized\.onnx: download failed with HTTP 503/,
    );
    expect(inspectWhisperInstall(modelsDir, MODEL).installed).toBe(false);
  });

  it('resumes an interrupted install: verified files are kept, damaged ones fetched again', async () => {
    const interrupted = server({ 'onnx/decoder_model_merged_quantized.onnx': 500 });
    await expect(
      installWhisperModel({ modelsDir, model: MODEL, fetch: interrupted.fetch }),
    ).rejects.toThrow();
    // Someone damaged a file that had been downloaded (same size, other content).
    await fs.writeFile(path.join(modelDir(), 'config.json'), Buffer.alloc(24, 0x20));

    const { calls, fetch } = server();
    const result = await installWhisperModel({ modelsDir, model: MODEL, fetch });
    expect(result.files).toEqual([
      { path: 'config.json', reused: false },
      { path: 'onnx/encoder_model.onnx', reused: true },
      { path: 'onnx/decoder_model_merged_quantized.onnx', reused: false },
    ]);
    expect(calls).toHaveLength(2);
    expect(result.downloadedBytes).toBe(24 + 30_000);
    expect(inspectWhisperInstall(modelsDir, MODEL).installed).toBe(true);
  });

  it('notices files removed or resized after the install, and --force restores them', async () => {
    const { calls, fetch } = server();
    await installWhisperModel({ modelsDir, model: MODEL, fetch });
    await fs.truncate(path.join(modelDir(), 'onnx', 'encoder_model.onnx'), 10);
    expect(inspectWhisperInstall(modelsDir, MODEL)).toMatchObject({
      installed: false,
      reasonCode: 'model_incomplete',
      reason: expect.stringContaining('onnx/encoder_model.onnx'),
    });
    await installWhisperModel({ modelsDir, model: MODEL, fetch });
    expect(inspectWhisperInstall(modelsDir, MODEL).installed).toBe(true);
    expect(calls).toHaveLength(MODEL.files.length + 1);

    await installWhisperModel({ modelsDir, model: MODEL, fetch, force: true });
    expect(calls).toHaveLength(MODEL.files.length * 2 + 1);
  });

  it('does not trust a marker written for other files', async () => {
    const { fetch } = server();
    await installWhisperModel({ modelsDir, model: MODEL, fetch });
    const pinnedElsewhere: WhisperModelDef = {
      ...MODEL,
      files: MODEL.files.map((file, index) =>
        index === 0 ? { ...file, sha256: 'f'.repeat(64) } : file,
      ),
    };
    expect(inspectWhisperInstall(modelsDir, pinnedElsewhere)).toMatchObject({
      installed: false,
      reasonCode: 'model_incomplete',
    });
  });
});
