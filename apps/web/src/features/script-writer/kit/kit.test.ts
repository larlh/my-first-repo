import { describe, expect, it } from 'vitest';
import { ownAvatar, stockAvatars, stockVoice } from '@/features/avatars/kit/testing/fixtures';
import { canAfford } from './CreditCost';
import { backingSize, stageBox } from './avatar';
import { defaultVoiceOf, usableAvatars, usableVoices } from './catalog';
import { languageInText, languageLabel, languageShortName } from './languages';
import { TOOL_ROUTES, draftPath, routeExists } from './routes';

describe('routes of other features', () => {
  const patterns = ['/videos', '/videos/:videoId', '/studio/:videoId', '/settings/billing'];

  it('knows whether some feature serves a URL', () => {
    expect(routeExists(patterns, '/studio/vid_1')).toBe(true);
    expect(routeExists(patterns, '/videos')).toBe(true);
    expect(routeExists(patterns, '/templates')).toBe(false);
    expect(routeExists(patterns, '/studio/vid_1/extra')).toBe(false);
  });

  it('opens a draft in the Studio, else on its video page, else nowhere', () => {
    const none = { studio: false, video: false, videos: false, billing: false, templates: false };
    expect(draftPath({ ...none, studio: true, video: true }, 'vid_1')).toBe('/studio/vid_1');
    expect(draftPath({ ...none, video: true }, 'vid_1')).toBe('/videos/vid_1');
    expect(draftPath(none, 'vid_1')).toBeNull();
    expect(TOOL_ROUTES.videosOfBatch('bat_1')).toBe('/videos?batchJobId=bat_1');
  });
});

describe('language names', () => {
  it('shows the own name plus the name in the UI language when they differ', () => {
    expect(languageLabel('de', 'es')).toBe('Deutsch · Alemán');
    expect(languageLabel('de', 'en')).toBe('Deutsch · German');
    expect(languageLabel('es', 'es')).toBe('Español');
    expect(languageLabel('en', 'en')).toBe('English');
    expect(languageShortName('fr', 'es')).toBe('Francés');
    expect(languageShortName('fr', 'en')).toBe('French');
    // Spanish does not capitalise languages inside a sentence; English does.
    expect(languageInText('fr', 'es')).toBe('francés');
    expect(languageInText('fr', 'en')).toBe('French');
  });
});

describe('catalogue helpers', () => {
  it('offers only ready avatars, instant ones first', () => {
    const [lucia, mateo] = stockAvatars();
    if (!lucia || !mateo) throw new Error('the stock catalogue is empty');
    const photo = ownAvatar(1);
    const preparing = ownAvatar(2, { status: 'processing' });
    expect(usableAvatars([photo, preparing, lucia, mateo]).map((avatar) => avatar.id)).toEqual([
      lucia.id,
      mateo.id,
      photo.id,
    ]);
  });

  it('starts from the stock voice of the language, else one that speaks it', () => {
    const carmen = stockVoice('es-f1', 'Carmen');
    const diego = stockVoice('es-m1', 'Diego');
    const emma = stockVoice('en-f1', 'Emma');
    const broken = stockVoice('en-m1', 'Tom', { status: 'failed' });
    expect(defaultVoiceOf([diego, emma, carmen], 'es')?.id).toBe('espeak:es-f1');
    expect(defaultVoiceOf([diego, emma], 'es')?.id).toBe('espeak:es-m1');
    expect(defaultVoiceOf([emma], 'fr')?.id).toBe('espeak:en-f1');
    expect(defaultVoiceOf([broken], 'en')).toBeNull();
    expect(usableVoices([emma, broken])).toEqual([emma]);
  });

  it('compares a cost with the balance', () => {
    expect(canAfford(null, 0)).toBe(true);
    expect(canAfford(3, 3)).toBe(true);
    expect(canAfford(4, 3)).toBe(false);
  });
});

describe('avatar canvas geometry', () => {
  it('keeps a portrait box centred in a wide stage', () => {
    expect(stageBox(800, 600, 'bust')).toEqual({ x: 55, y: 0, w: 690, h: 600 });
    expect(stageBox(300, 600, 'bust')).toEqual({ x: 0, y: 0, w: 300, h: 600 });
    expect(stageBox(800, 600, 'half').w).toBe(480);
  });

  it('sizes the backing store in device pixels with a cap', () => {
    expect(backingSize(400, 300, 1)).toEqual({ width: 400, height: 300 });
    expect(backingSize(400, 300, 2)).toEqual({ width: 800, height: 600 });
    // Never above 2× and never beyond the longest side allowed.
    expect(backingSize(400, 300, 3)).toEqual({ width: 800, height: 600 });
    expect(backingSize(1000, 500, 2, 1280)).toEqual({ width: 1280, height: 640 });
    expect(backingSize(0, 0, 0)).toEqual({ width: 1, height: 1 });
  });
});
