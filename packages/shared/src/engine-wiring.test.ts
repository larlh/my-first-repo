import { describe, expect, it } from 'vitest';
import {
  AppError,
  AvatarQualitySchema,
  AvatarSchema,
  CapabilitiesSchema,
  ENGINE_REASON_CODES,
  EngineJobResultSchema,
  StoredErrorSchema,
  toStoredError,
} from './index';

/* Additive contract fields that carry the state of the local avatar engine to the UI as
 * translatable codes (phase 3, engine wiring). Older producers and consumers keep working. */

const LANDMARKS = {
  leftEye: { x: 0.4, y: 0.4 },
  rightEye: { x: 0.6, y: 0.4 },
  mouthLeft: { x: 0.43, y: 0.62 },
  mouthRight: { x: 0.57, y: 0.62 },
  chin: { x: 0.5, y: 0.8 },
};

describe('engine wiring contract additions', () => {
  it('capabilities carry the engine reason as a code, null for producers that give none', () => {
    const engine = CapabilitiesSchema.shape.avatarEngine;
    const legacy = engine.parse({
      available: false,
      reason: 'stopped',
      device: null,
      secondsPerVideoSecond: null,
    });
    expect(legacy.reasonCode).toBeNull();
    for (const reasonCode of ENGINE_REASON_CODES) {
      expect(
        engine.parse({
          available: false,
          reason: 'x',
          reasonCode,
          device: null,
          secondsPerVideoSecond: null,
        }).reasonCode,
      ).toBe(reasonCode);
    }
    expect(
      engine.safeParse({
        available: false,
        reason: 'x',
        reasonCode: 'The engine is not running',
        device: null,
        secondsPerVideoSecond: null,
      }).success,
    ).toBe(false);
  });

  it('avatars carry the verdict of the automatic quality control (null by default)', () => {
    const avatar = {
      id: 'avt_abcdefgh12345678',
      kind: 'generated',
      rendering: 'photoreal',
      name: 'Presentadora',
      gender: 'female',
      ageGroup: null,
      style: null,
      description: '',
      tags: [],
      traits: {},
      status: 'ready',
      thumbnailUrl: null,
      imageUrl: null,
      maskUrl: null,
      rig: null,
      prompt: 'a woman',
      provider: { id: 'local-neural', name: 'Engine', quality: 'premium', local: true },
      workspaceId: 'ws_abcdefgh12345678',
      consentId: null,
      error: null,
      createdAt: null,
    };
    expect(AvatarSchema.parse(avatar).quality).toBeNull();
    expect(
      AvatarSchema.parse({ ...avatar, quality: { passed: false, issues: ['head_tilted'] } })
        .quality,
    ).toEqual({ passed: false, issues: ['head_tilted'], attempts: null });
    expect(AvatarQualitySchema.safeParse({ passed: true, issues: [], attempts: 0 }).success).toBe(
      false,
    );
  });

  it('a prepared portrait may say which model drew its matte', () => {
    const base = {
      kind: 'prepare',
      portraitPath: '/work/job/portrait.png',
      maskPath: '/work/job/mask.png',
      width: 768,
      height: 768,
      landmarks: LANDMARKS,
      landmarksSource: 'detected',
    };
    // Engines that do not report it stay valid.
    expect(EngineJobResultSchema.parse(base)).not.toHaveProperty('matteModel');
    expect(EngineJobResultSchema.parse({ ...base, matteModel: 'matting' })).toMatchObject({
      matteModel: 'matting',
    });
    expect(
      EngineJobResultSchema.parse({ ...base, maskPath: null, matteModel: null }),
    ).toMatchObject({ maskPath: null, matteModel: null });
  });

  it('stored errors keep the translatable cause of an AppError, and only that', () => {
    const stopped = new AppError('SERVICE_UNAVAILABLE', 'The engine is not reachable', {
      reason: 'engine_unreachable',
    });
    expect(toStoredError(stopped)).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'The engine is not reachable',
      reason: 'engine_unreachable',
    });
    expect(StoredErrorSchema.parse(toStoredError(stopped)).reason).toBe('engine_unreachable');
    // Free text, other types and missing details never become a "reason".
    for (const details of [
      undefined,
      null,
      { reason: 'More than one face was found.' },
      { reason: 42 },
      { field: 'prompt' },
    ]) {
      expect(toStoredError(new AppError('UNPROCESSABLE', 'no', details))).toEqual({
        code: 'UNPROCESSABLE',
        message: 'no',
      });
    }
    // Rows written before the field existed still parse.
    expect(StoredErrorSchema.parse({ code: 'INTERNAL', message: 'boom' })).toEqual({
      code: 'INTERNAL',
      message: 'boom',
    });
  });
});
