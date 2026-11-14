import { describe, expect, it } from 'vitest';
import {
  LOCAL_VOICES,
  TemplateDetailSchema,
  collectAssetIds,
  collectAvatarIds,
  collectVoiceIds,
  listUsedVariables,
} from '@parlante/shared';
import {
  getBuiltinTemplate,
  listBuiltinTemplates,
  toTemplateDetailDto,
  validateBuiltinTemplates,
} from './index';

describe('built-in templates', () => {
  it('are all valid and uniquely identified', () => {
    expect(() => validateBuiltinTemplates()).not.toThrow();
    expect(listBuiltinTemplates().length).toBeGreaterThanOrEqual(1);
  });

  it('only reference stock avatars, local voices and no workspace assets', () => {
    const localVoiceIds = new Set(LOCAL_VOICES.map((v) => `espeak:${v.providerVoiceId}`));
    for (const template of listBuiltinTemplates()) {
      expect(collectAssetIds(template.composition), template.id).toEqual([]);
      for (const avatarId of collectAvatarIds(template.composition)) {
        expect(avatarId, template.id).toMatch(/^stock_/);
      }
      for (const voiceId of collectVoiceIds(template.composition)) {
        expect(localVoiceIds.has(voiceId), `${template.id} ${voiceId}`).toBe(true);
      }
      const declared = template.composition.variables.map((v) => v.name).sort();
      expect(declared, template.id).toEqual(listUsedVariables(template.composition).sort());
    }
  });

  it('returns copies and serialises to the API DTO in both languages', () => {
    const a = getBuiltinTemplate('builtin_explainer');
    const b = getBuiltinTemplate('builtin_explainer');
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
    if (!a) return;
    a.composition.scenes.length = 0;
    expect(getBuiltinTemplate('builtin_explainer')?.composition.scenes.length).toBe(3);
    expect(getBuiltinTemplate('builtin_nope')).toBeNull();
    for (const locale of ['es', 'en'] as const) {
      const dto = toTemplateDetailDto(listBuiltinTemplates()[0]!, locale);
      expect(TemplateDetailSchema.parse(dto)).toEqual(dto);
      expect(dto.kind).toBe('builtin');
    }
  });
});
