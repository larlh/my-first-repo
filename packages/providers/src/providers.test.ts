import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilitiesSchema, isAppError } from '@parlante/shared';
import {
  LocalStorageProvider,
  ProviderNotImplementedError,
  createProvidersFromEnv,
  describeCapabilities,
  providerEnvSchema,
  resolveChoice,
} from './index';

let dir: string;
let storage: LocalStorageProvider;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-storage-'));
  storage = new LocalStorageProvider(dir);
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('registry', () => {
  it('selects local providers when no keys are configured', async () => {
    const providers = createProvidersFromEnv({ STORAGE_LOCAL_DIR: dir });
    const caps = await describeCapabilities(providers);
    expect(CapabilitiesSchema.parse(caps)).toEqual(caps);
    expect(caps.active.tts.id).toBe('espeak');
    expect(caps.active.llm).toMatchObject({ id: 'local', quality: 'basic', local: true });
    expect(caps.active.stt.id).toBe('manual');
    expect(caps.sttRequiresTranscript).toBe(true);
    expect(caps.active.lipsync).toMatchObject({ id: 'local-neural', local: true });
    expect(caps.active.portrait.id).toBe('local-neural');
    // The engine client is still a stub: it must report itself unavailable, with a reason.
    expect(caps.avatarEngine.available).toBe(false);
    expect(caps.avatarEngine.reason).toMatch(/avatar engine/i);
    expect(caps.active.storage.id).toBe('local');
    expect(caps.ttsProviders.map((p) => p.id)).toEqual(['espeak']);
    expect(providers.tts.get('espeak')).toBe(providers.tts.default);
    expect(providers.tts.get('nope')).toBeNull();
  });

  it('auto-selects external adapters when their keys are present', async () => {
    const providers = createProvidersFromEnv({
      STORAGE_LOCAL_DIR: dir,
      ANTHROPIC_API_KEY: 'test-key',
      ELEVENLABS_API_KEY: 'test-key',
      OPENAI_API_KEY: 'test-key',
    });
    const caps = await describeCapabilities(providers);
    expect(caps.active.llm.id).toBe('anthropic');
    expect(caps.active.translation.id).toBe('anthropic');
    expect(caps.active.tts.id).toBe('elevenlabs');
    expect(caps.active.voiceClone.id).toBe('elevenlabs');
    expect(caps.active.stt.id).toBe('openai');
    expect(caps.ttsProviders.map((p) => p.id)).toEqual(['espeak', 'elevenlabs', 'openai']);
  });

  it('honours explicit choices and fails loudly when the key is missing', () => {
    const local = createProvidersFromEnv({
      STORAGE_LOCAL_DIR: dir,
      ANTHROPIC_API_KEY: 'test-key',
      LLM_PROVIDER: 'local',
    });
    expect(local.llm.info.id).toBe('local');
    expect(() =>
      createProvidersFromEnv({ STORAGE_LOCAL_DIR: dir, LLM_PROVIDER: 'anthropic' }),
    ).toThrow(/ANTHROPIC_API_KEY/);
    expect(() =>
      createProvidersFromEnv({ STORAGE_LOCAL_DIR: dir, TTS_PROVIDER: 'openai' }),
    ).toThrow(/OPENAI_API_KEY/);
    expect(() => providerEnvSchema.parse({ TTS_PROVIDER: 'festival' })).toThrow();
  });

  it('resolveChoice prefers the first available candidate on auto', () => {
    const candidates = [
      { id: 'a' as const, available: false },
      { id: 'b' as const, available: true },
    ];
    expect(resolveChoice<'a' | 'b' | 'z'>('auto', candidates, 'z')).toBe('b');
    expect(resolveChoice<'a' | 'b' | 'z'>('a', candidates, 'z')).toBe('a');
    expect(resolveChoice<'a' | 'z'>('auto', [{ id: 'a', available: false }], 'z')).toBe('z');
  });

  it('stubs throw a typed NOT_IMPLEMENTED AppError', async () => {
    const providers = createProvidersFromEnv({ STORAGE_LOCAL_DIR: dir });
    let caught: unknown;
    try {
      await providers.moderation.check({ text: 'hola', context: 'script' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderNotImplementedError);
    expect(isAppError(caught)).toBe(true);
    expect(caught).toMatchObject({
      code: 'NOT_IMPLEMENTED',
      status: 501,
      capability: 'moderation',
    });
  });

  it('manual STT asks for a user transcript', async () => {
    const providers = createProvidersFromEnv({ STORAGE_LOCAL_DIR: dir });
    await expect(providers.stt.transcribe({ audio: new Uint8Array() })).rejects.toMatchObject({
      code: 'TRANSCRIPT_REQUIRED',
    });
  });
});

describe('LocalStorageProvider', () => {
  const key = 'ws/ws_test/assets/ast_1/original.txt';

  it('puts bytes, stats, reads, streams ranges and exposes a local path', async () => {
    const info = await storage.put(key, Buffer.from('hello world'), { contentType: 'text/plain' });
    expect(info).toMatchObject({ key, size: 11, contentType: 'text/plain' });
    expect(await storage.exists(key)).toBe(true);
    expect(await storage.stat(key)).toMatchObject({ size: 11, contentType: 'text/plain' });
    expect(Buffer.from(await storage.get(key)).toString()).toBe('hello world');
    expect((await collect(await storage.getStream(key, { start: 6, end: 10 }))).toString()).toBe(
      'world',
    );
    expect(storage.localPath(key)).toBe(path.join(dir, key));
    expect(await storage.signedUrl()).toBeNull();
  });

  it('accepts file paths and async iterables as bodies', async () => {
    const src = path.join(dir, 'source.bin');
    await fs.writeFile(src, 'from file');
    await storage.put(
      'cache/a.bin',
      { filePath: src },
      { contentType: 'application/octet-stream' },
    );
    expect(Buffer.from(await storage.get('cache/a.bin')).toString()).toBe('from file');
    async function* chunks() {
      yield new TextEncoder().encode('part1-');
      yield new TextEncoder().encode('part2');
    }
    await storage.put('cache/b.bin', chunks(), { contentType: 'application/octet-stream' });
    expect(Buffer.from(await storage.get('cache/b.bin')).toString()).toBe('part1-part2');
    const out = path.join(dir, 'out', 'copy.bin');
    await storage.downloadTo('cache/b.bin', out);
    expect(await fs.readFile(out, 'utf8')).toBe('part1-part2');
  });

  it('reports missing objects as NOT_FOUND / null', async () => {
    expect(await storage.stat('ws/ws_test/missing.txt')).toBeNull();
    expect(await storage.exists('ws/ws_test/missing.txt')).toBe(false);
    await expect(storage.get('ws/ws_test/missing.txt')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(storage.getStream('ws/ws_test/missing.txt')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects path traversal and absolute keys', async () => {
    for (const bad of [
      '../outside.txt',
      'ws/../../etc/passwd',
      '/etc/passwd',
      'a\\b',
      'x.meta.json',
    ]) {
      await expect(
        storage.put(bad, Buffer.from('x'), { contentType: 'text/plain' }),
        bad,
      ).rejects.toThrow();
      expect(() => storage.localPath(bad), bad).toThrow();
    }
    await expect(storage.deletePrefix('')).rejects.toThrow();
    await expect(storage.deletePrefix('/')).rejects.toThrow();
  });

  it('deletes single objects and whole prefixes', async () => {
    await storage.put('ws/ws_del/videos/vid_1/a.txt', Buffer.from('a'), {
      contentType: 'text/plain',
    });
    await storage.put('ws/ws_del/videos/vid_1/b.txt', Buffer.from('b'), {
      contentType: 'text/plain',
    });
    await storage.put('ws/ws_del/videos/vid_2/c.txt', Buffer.from('c'), {
      contentType: 'text/plain',
    });
    await storage.delete('ws/ws_del/videos/vid_1/a.txt');
    expect(await storage.exists('ws/ws_del/videos/vid_1/a.txt')).toBe(false);
    await storage.delete('ws/ws_del/videos/vid_1/a.txt'); // idempotent
    await storage.deletePrefix('ws/ws_del/videos/vid_1/');
    expect(await storage.exists('ws/ws_del/videos/vid_1/b.txt')).toBe(false);
    expect(await storage.exists('ws/ws_del/videos/vid_2/c.txt')).toBe(true);
  });
});
