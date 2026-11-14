import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilitiesSchema, EngineHealthSchema } from '@parlante/shared';
import type { EngineHealth, EngineStatus } from '@parlante/shared';
import {
  createEngineJobDir,
  createProvidersFromEnv,
  describeCapabilities,
  engineRequestHeaders,
  engineStatusFromHealth,
  mergeEngineStatus,
  providerEnvSchema,
} from './index';

let workDir: string;
let callerDir: string;

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-engine-work-'));
  callerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-engine-caller-'));
});
afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm(callerDir, { recursive: true, force: true });
});

const health = (overrides: Partial<EngineHealth> = {}): EngineHealth =>
  EngineHealthSchema.parse({
    status: 'ok',
    version: '0.1.0',
    device: 'cpu',
    capabilities: { generate: true, prepare: true, animate: true },
    models: [
      { id: 'anim', role: 'animation', downloaded: true, license: 'MIT', commercialUse: true },
      {
        id: 'gen',
        role: 'portrait-generation',
        downloaded: true,
        license: 'CreativeML OpenRAIL-M',
        commercialUse: true,
      },
    ],
    secondsPerVideoSecond: 28.5,
    secondsPerPortrait: 9.7,
    ...overrides,
  });

describe('engine job directory (who moves the files: the provider)', () => {
  it('imports caller files into the work dir, exports results back and cleans up', async () => {
    const portrait = path.join(callerDir, 'some portrait.png');
    await fs.writeFile(portrait, 'PORTRAIT');
    const job = await createEngineJobDir({ AVATAR_ENGINE_WORK_DIR: workDir });
    expect(path.dirname(job.dir)).toBe(workDir);

    const imported = await job.importFile(portrait, 'portrait.png');
    expect(imported).toBe(path.join(job.dir, 'portrait.png'));
    expect(await fs.readFile(imported, 'utf8')).toBe('PORTRAIT');

    // The engine writes its result inside the job dir…
    const engineOutput = path.join(job.dir, 'clip.mp4');
    await fs.writeFile(engineOutput, 'CLIP');
    // …and the provider hands it to the caller's outputDir.
    const out = path.join(callerDir, 'out');
    const exported = await job.exportFile(engineOutput, out);
    expect(exported).toBe(path.join(out, 'clip.mp4'));
    expect(await fs.readFile(exported, 'utf8')).toBe('CLIP');
    expect(await job.exportFile(engineOutput, out, 'renamed.mp4')).toBe(
      path.join(out, 'renamed.mp4'),
    );

    await job.remove();
    await expect(fs.stat(job.dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it('refuses names with path parts and engine paths outside the job dir', async () => {
    const job = await createEngineJobDir({ AVATAR_ENGINE_WORK_DIR: workDir });
    const source = path.join(callerDir, 'a.wav');
    await fs.writeFile(source, 'x');
    await expect(job.importFile(source, '../escape.wav')).rejects.toThrow(/Invalid engine file/);
    await expect(job.importFile(source, 'sub/file.wav')).rejects.toThrow();
    await expect(job.exportFile(source, callerDir)).rejects.toThrow(/outside its job directory/);
    await expect(job.exportFile('/etc/passwd', callerDir)).rejects.toThrow();
    await expect(
      job.exportFile(path.join(job.dir, '..', path.basename(job.dir) + '-evil', 'x'), callerDir),
    ).rejects.toThrow();
    await job.remove();
  });
});

describe('engine status', () => {
  it('sends the bearer token only when configured', () => {
    expect(engineRequestHeaders({ AVATAR_ENGINE_TOKEN: undefined })).toEqual({
      'content-type': 'application/json',
    });
    expect(engineRequestHeaders({ AVATAR_ENGINE_TOKEN: 's3cret' }).authorization).toBe(
      'Bearer s3cret',
    );
    expect(
      providerEnvSchema.parse({ AVATAR_ENGINE_TOKEN: '' }).AVATAR_ENGINE_TOKEN,
    ).toBeUndefined();
  });

  it('maps /health to a per-provider status with operations, models and licences', () => {
    const full = engineStatusFromHealth(health(), 'lipsync');
    expect(full).toMatchObject({
      available: true,
      reason: null,
      device: 'cpu',
      secondsPerVideoSecond: 28.5,
      secondsPerPortrait: 9.7,
      nonCommercial: false,
      operations: { generate: true, prepare: true, animate: true },
    });
    expect(full.models).toHaveLength(2);

    // Generation weights missing: photo avatars and renders still work, text → avatar does not.
    const noGen = health({ capabilities: { generate: false, prepare: true, animate: true } });
    expect(engineStatusFromHealth(noGen, 'portrait')).toMatchObject({
      available: true,
      operations: { generate: false },
    });
    expect(engineStatusFromHealth(noGen, 'portrait').reason).toMatch(/generate/);
    const noAnim = health({ capabilities: { generate: true, prepare: true, animate: false } });
    expect(engineStatusFromHealth(noAnim, 'lipsync').available).toBe(false);
    expect(engineStatusFromHealth(noAnim, 'lipsync').reason).toMatch(/weights/);
    expect(engineStatusFromHealth(noAnim, 'portrait').available).toBe(true);

    // A downloaded non-commercial model raises the flag; one that is not downloaded does not.
    const nc = {
      id: 'nc',
      role: 'animation' as const,
      license: 'CC BY-NC 4.0',
      commercialUse: false,
    };
    expect(
      engineStatusFromHealth(health({ models: [{ ...nc, downloaded: true }] }), 'lipsync')
        .nonCommercial,
    ).toBe(true);
    expect(
      engineStatusFromHealth(health({ models: [{ ...nc, downloaded: false }] }), 'lipsync')
        .nonCommercial,
    ).toBe(false);
  });

  it('merges both neural providers into capabilities.avatarEngine', async () => {
    const noGen = health({ capabilities: { generate: false, prepare: true, animate: true } });
    const merged = mergeEngineStatus(
      engineStatusFromHealth(noGen, 'lipsync'),
      engineStatusFromHealth(noGen, 'portrait'),
    );
    expect(merged).toMatchObject({
      available: true,
      operations: { generate: false, prepare: true, animate: true },
      nonCommercial: false,
      secondsPerVideoSecond: 28.5,
      secondsPerPortrait: 9.7,
    });
    expect(merged.reason).toMatch(/generate/);
    expect(merged.models.map((m) => m.id).sort()).toEqual(['anim', 'gen']);

    // Providers that only know "available" (external lip-sync) map onto their operations.
    const down: EngineStatus = {
      available: false,
      reason: 'Engine stopped',
      device: null,
      secondsPerVideoSecond: null,
    };
    const external: EngineStatus = { ...down, available: true, reason: null };
    expect(mergeEngineStatus(external, down)).toMatchObject({
      available: true,
      reason: 'Engine stopped',
      operations: { generate: false, prepare: false, animate: true },
      models: [],
      secondsPerPortrait: null,
    });

    const providers = createProvidersFromEnv({ STORAGE_LOCAL_DIR: workDir });
    providers.lipsync.status = async () => engineStatusFromHealth(health(), 'lipsync');
    providers.portrait.status = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8090');
    };
    const caps = await describeCapabilities(providers);
    expect(CapabilitiesSchema.parse(caps)).toEqual(caps);
    expect(caps.avatarEngine).toMatchObject({
      available: true,
      operations: { generate: false, prepare: false, animate: true },
      reason: 'connect ECONNREFUSED 127.0.0.1:8090',
    });
  });
});
