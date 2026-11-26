import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KOKORO_SOURCE,
  KOKORO_TOKENIZER,
  KOKORO_VARIANTS,
  KOKORO_VOICE_FILES,
  PIPER_SOURCE,
  PIPER_VOICE_FILES,
  VOICE_INSTALL_MARKER,
  inspectVoiceFiles,
  readVoiceMarker,
  voiceFilePath,
  voiceFileUrl,
  voiceSourceFolder,
} from './neural-models';
import type { VoiceModelFile, VoiceModelSource } from './neural-models';
import { VoiceIntegrityError, installVoiceFiles, removeVoiceFiles } from './neural-setup';
import type { VoiceFetch, VoiceInstallProgress } from './neural-setup';

/* The installer against a fake Hub: small files with real hashes, a fetch that counts. */

const SOURCE: VoiceModelSource = { repo: 'acme/voices', revision: 'a'.repeat(40) };
const sha = (data: string) => createHash('sha256').update(data).digest('hex');
const CONTENT: Record<string, string> = {
  'tokenizer.json': '{"model":{"vocab":{"a":1}}}',
  'onnx/model.onnx': 'onnx '.repeat(4000),
  'voices/ana.bin': 'style '.repeat(100),
};
const FILES: VoiceModelFile[] = Object.entries(CONTENT).map(([file, data]) => ({
  path: file,
  sizeBytes: Buffer.byteLength(data),
  sha256: sha(data),
}));

let dir: string;
let requests: string[];
const hub =
  (content: Record<string, string> = CONTENT): VoiceFetch =>
  async (url) => {
    requests.push(url);
    const prefix = `https://huggingface.co/${SOURCE.repo}/resolve/${SOURCE.revision}/`;
    const body = url.startsWith(prefix) ? content[url.slice(prefix.length)] : undefined;
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
  };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-voice-setup-'));
  requests = [];
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('voice installer', () => {
  it('downloads from the pinned revision, verifies and records every file', async () => {
    expect(inspectVoiceFiles(dir, SOURCE, FILES)).toMatchObject({
      installed: false,
      reasonCode: 'voice_not_installed',
    });
    const progress: VoiceInstallProgress[] = [];
    const result = await installVoiceFiles({
      modelsDir: dir,
      source: SOURCE,
      files: FILES,
      fetch: hub(),
      onProgress: (p) => progress.push(p),
    });
    expect(result.changed).toBe(true);
    expect(result.downloadedBytes).toBe(FILES.reduce((sum, file) => sum + file.sizeBytes, 0));
    expect(result.dir).toBe(path.join(dir, voiceSourceFolder(SOURCE)));
    expect(requests).toEqual(FILES.map((file) => voiceFileUrl(SOURCE, file)));
    for (const file of FILES) {
      expect(await fs.readFile(voiceFilePath(dir, SOURCE, file), 'utf8')).toBe(CONTENT[file.path]);
    }
    expect(readVoiceMarker(dir, SOURCE).files).toEqual(
      Object.fromEntries(FILES.map((file) => [file.path, file.sha256])),
    );
    expect(inspectVoiceFiles(dir, SOURCE, FILES)).toEqual({
      installed: true,
      reasonCode: null,
      reason: null,
    });
    expect(progress.filter((p) => p.phase === 'done').map((p) => p.file)).toEqual(
      FILES.map((file) => file.path),
    );
    expect(progress.some((p) => p.phase === 'download' && p.receivedBytes > 0)).toBe(true);
    // No leftovers.
    const names = await fs.readdir(result.dir, { recursive: true });
    expect(names.some((name) => name.endsWith('.part'))).toBe(false);
  });

  it('does nothing the second time, and downloads only what is new', async () => {
    const [tokenizer, model, voice] = FILES as [VoiceModelFile, VoiceModelFile, VoiceModelFile];
    await installVoiceFiles({
      modelsDir: dir,
      source: SOURCE,
      files: [tokenizer, model],
      fetch: hub(),
    });
    requests = [];
    const again = await installVoiceFiles({
      modelsDir: dir,
      source: SOURCE,
      files: [tokenizer, model],
      fetch: hub(),
    });
    expect(again).toMatchObject({ changed: false, downloadedBytes: 0 });
    expect(requests).toEqual([]);
    // One more voice of the same model: only its file travels.
    const more = await installVoiceFiles({
      modelsDir: dir,
      source: SOURCE,
      files: [tokenizer, model, voice, model],
      fetch: hub(),
    });
    expect(requests).toEqual([voiceFileUrl(SOURCE, voice)]);
    expect(more.files).toEqual([
      { path: tokenizer.path, reused: true },
      { path: model.path, reused: true },
      { path: voice.path, reused: false },
    ]);
  });

  it('discards a file whose hash does not match and installs nothing unverified', async () => {
    const tampered = {
      ...CONTENT,
      'onnx/model.onnx': CONTENT['onnx/model.onnx']?.replace('o', 'X') ?? '',
    };
    const attempt = installVoiceFiles({
      modelsDir: dir,
      source: SOURCE,
      files: FILES,
      fetch: hub(tampered),
    });
    await expect(attempt).rejects.toBeInstanceOf(VoiceIntegrityError);
    await expect(attempt).rejects.toMatchObject({ file: 'onnx/model.onnx', problem: 'sha256' });
    const folder = path.join(dir, voiceSourceFolder(SOURCE));
    const names = await fs.readdir(folder, { recursive: true });
    expect(names).not.toContain(path.join('onnx', 'model.onnx'));
    expect(names.some((name) => name.endsWith('.part'))).toBe(false);
    // What passed before the failure stays verified; the set as a whole is incomplete.
    expect(readVoiceMarker(dir, SOURCE).files).toEqual({ 'tokenizer.json': FILES[0]?.sha256 });
    expect(inspectVoiceFiles(dir, SOURCE, FILES)).toMatchObject({
      installed: false,
      reasonCode: 'voice_incomplete',
    });
  });

  it('stops a download that is larger than the catalogue says', async () => {
    const bloated = { ...CONTENT, 'voices/ana.bin': `${CONTENT['voices/ana.bin']}extra` };
    await expect(
      installVoiceFiles({ modelsDir: dir, source: SOURCE, files: FILES, fetch: hub(bloated) }),
    ).rejects.toMatchObject({ problem: 'size' });
  });

  it('reports a file the Hub does not have', async () => {
    const missing: VoiceModelFile = { path: 'voices/nobody.bin', sizeBytes: 3, sha256: sha('abc') };
    await expect(
      installVoiceFiles({ modelsDir: dir, source: SOURCE, files: [missing], fetch: hub() }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('adopts a file that is already on disk only after hashing it', async () => {
    const [tokenizer] = FILES as [VoiceModelFile];
    const target = voiceFilePath(dir, SOURCE, tokenizer);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, CONTENT[tokenizer.path] ?? '');
    // On disk, right size — but never verified: not installed yet.
    expect(inspectVoiceFiles(dir, SOURCE, [tokenizer]).installed).toBe(false);
    const result = await installVoiceFiles({
      modelsDir: dir,
      source: SOURCE,
      files: [tokenizer],
      fetch: hub(),
    });
    expect(result.files).toEqual([{ path: tokenizer.path, reused: true }]);
    expect(requests).toEqual([]);
    expect(inspectVoiceFiles(dir, SOURCE, [tokenizer]).installed).toBe(true);
    // Same size, other content: replaced by a verified download.
    await fs.writeFile(target, 'x'.repeat(tokenizer.sizeBytes));
    await fs.rm(path.join(dir, voiceSourceFolder(SOURCE), VOICE_INSTALL_MARKER));
    await installVoiceFiles({ modelsDir: dir, source: SOURCE, files: [tokenizer], fetch: hub() });
    expect(requests).toHaveLength(1);
    expect(await fs.readFile(target, 'utf8')).toBe(CONTENT[tokenizer.path]);
  });

  it('notices a file that was deleted or truncated after it was installed', async () => {
    await installVoiceFiles({ modelsDir: dir, source: SOURCE, files: FILES, fetch: hub() });
    await fs.writeFile(voiceFilePath(dir, SOURCE, FILES[1] as VoiceModelFile), 'short');
    expect(inspectVoiceFiles(dir, SOURCE, FILES)).toMatchObject({
      installed: false,
      reasonCode: 'voice_incomplete',
    });
    requests = [];
    await installVoiceFiles({ modelsDir: dir, source: SOURCE, files: FILES, fetch: hub() });
    expect(requests).toEqual([voiceFileUrl(SOURCE, FILES[1] as VoiceModelFile)]);
    expect(inspectVoiceFiles(dir, SOURCE, FILES).installed).toBe(true);
  });

  it('downloads everything again with force', async () => {
    await installVoiceFiles({ modelsDir: dir, source: SOURCE, files: FILES, fetch: hub() });
    requests = [];
    const result = await installVoiceFiles({
      modelsDir: dir,
      source: SOURCE,
      files: FILES,
      fetch: hub(),
      force: true,
    });
    expect(requests).toHaveLength(FILES.length);
    expect(result.changed).toBe(true);
  });

  it('removes files and forgets them', async () => {
    await installVoiceFiles({ modelsDir: dir, source: SOURCE, files: FILES, fetch: hub() });
    const voice = FILES[2] as VoiceModelFile;
    await removeVoiceFiles(dir, SOURCE, [voice]);
    await expect(fs.access(voiceFilePath(dir, SOURCE, voice))).rejects.toThrow();
    expect(readVoiceMarker(dir, SOURCE).files[voice.path]).toBeUndefined();
    expect(inspectVoiceFiles(dir, SOURCE, FILES.slice(0, 2)).installed).toBe(true);
    // Removing from a folder that never existed is not an error.
    await removeVoiceFiles(path.join(dir, 'nowhere'), SOURCE, [voice]);
  });

  it('ignores a marker written for another revision', async () => {
    await installVoiceFiles({ modelsDir: dir, source: SOURCE, files: FILES, fetch: hub() });
    const other = { ...SOURCE, revision: 'b'.repeat(40) };
    expect(readVoiceMarker(dir, other).files).toEqual({});
    expect(inspectVoiceFiles(dir, other, FILES).installed).toBe(false);
  });
});

describe('catalogue of voice files', () => {
  const all: { source: VoiceModelSource; file: VoiceModelFile }[] = [
    { source: KOKORO_SOURCE, file: KOKORO_TOKENIZER },
    ...Object.values(KOKORO_VARIANTS).map((file) => ({ source: KOKORO_SOURCE, file })),
    ...Object.values(KOKORO_VOICE_FILES).map((file) => ({ source: KOKORO_SOURCE, file })),
    ...Object.values(PIPER_VOICE_FILES).flatMap((files) => [
      { source: PIPER_SOURCE, file: files.onnx },
      { source: PIPER_SOURCE, file: files.config },
    ]),
  ];

  it('pins every file to a full commit, a size and a SHA-256', () => {
    expect(KOKORO_SOURCE.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(PIPER_SOURCE.revision).toMatch(/^[0-9a-f]{40}$/);
    const seen = new Set<string>();
    for (const { source, file } of all) {
      expect(file.sha256, file.path).toMatch(/^[0-9a-f]{64}$/);
      expect(file.sizeBytes, file.path).toBeGreaterThan(0);
      const key = `${source.repo}/${file.path}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('only lists data formats, never pickled weights', () => {
    for (const { file } of all) {
      expect(file.path, file.path).toMatch(/\.(onnx|bin|json)$/);
      expect(file.path).not.toMatch(/\.(pt|pth|ckpt|pkl)$/);
    }
    // A Kokoro voice is a raw float32 tensor of 510 styles × 256 values.
    for (const file of Object.values(KOKORO_VOICE_FILES))
      expect(file.sizeBytes).toBe(510 * 256 * 4);
  });

  it('fetches only from huggingface.co and escapes names with accents', () => {
    for (const { source, file } of all) {
      const url = new URL(voiceFileUrl(source, file));
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe('huggingface.co');
      expect(url.pathname).toContain(`/resolve/${source.revision}/`);
    }
    // A path with an accent or a space is escaped, segment by segment.
    expect(
      voiceFileUrl(PIPER_SOURCE, {
        path: 'pt/pt_PT/tugão/medium/pt_PT-tugão-medium.onnx',
        sizeBytes: 1,
        sha256: 'a'.repeat(64),
      }),
    ).toBe(
      `https://huggingface.co/${PIPER_SOURCE.repo}/resolve/${PIPER_SOURCE.revision}/pt/pt_PT/tug%C3%A3o/medium/pt_PT-tug%C3%A3o-medium.onnx`,
    );
  });
});
