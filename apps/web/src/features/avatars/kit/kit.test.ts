import { CompositionSchema, CONSENT_STATEMENT_VERSION, collectAvatarIds } from '@parlante/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  consentBody,
  consentKey,
  consentProblems,
  consentStatement,
  isConsentComplete,
} from './consent';
import {
  animationSeconds,
  engineCan,
  engineHealth,
  missingModels,
  nonCommercialModels,
  portraitSeconds,
  remainingSeconds,
} from './engine';
import { creationFailure, isEngineFailure, isRetryable } from './failure';
import { clampPlayhead, estimatedRuntime, previewDependencies } from './preview';
import { draftPath, routeExists } from './routes';
import { backingSize, demoRuntime, loopedSpeechMs, stageBox, stagePose, DEMO_LINES } from './stage';
import { engineOff, engineReady, makeTemplateDetail, makeTemplate } from './testing/fixtures';
import { subscribeTicker, tickerSize } from './ticker';
import { starterComposition } from './useStartVideo';

describe('animated stage', () => {
  it('loops the demo line with a pause between repetitions', () => {
    expect(loopedSpeechMs(0, 3000, 1000)).toBe(0);
    expect(loopedSpeechMs(2999, 3000, 1000)).toBe(2999);
    // During the pause the position is negative: the mouth is closed.
    expect(loopedSpeechMs(3500, 3000, 1000)).toBeLessThan(0);
    expect(loopedSpeechMs(4000, 3000, 1000)).toBe(0);
    expect(loopedSpeechMs(4250, 3000, 1000)).toBe(250);
    expect(loopedSpeechMs(100, 0, 1000)).toBe(-1);
  });

  it('estimates a runtime for the silent demo line (cached)', () => {
    const runtime = demoRuntime(DEMO_LINES.es, 'es');
    expect(runtime.audioDurationMs).toBeGreaterThan(2000);
    expect(runtime.visemes.length).toBeGreaterThan(10);
    expect(demoRuntime(DEMO_LINES.es, 'es')).toBe(runtime);
  });

  it('keeps the mouth shut when idle and moves it in demo and speech modes', () => {
    const runtime = demoRuntime(DEMO_LINES.es, 'es');
    const idle = stagePose({ mode: 'idle', elapsedMs: 900, seed: 'a' });
    expect(idle.speaking).toBe(false);
    expect(idle.mouth.open).toBeLessThan(0.05);

    const opens = (mode: 'demo' | 'speech') =>
      Array.from({ length: 40 }, (_, i) => {
        const t = 300 + i * 60;
        return stagePose({ mode, elapsedMs: t, seed: 'a', runtime, speechMs: t }).mouth.open;
      });
    expect(Math.max(...opens('demo'))).toBeGreaterThan(0.25);
    expect(Math.max(...opens('speech'))).toBeGreaterThan(0.25);

    // Speech mode follows the caller's clock: paused audio means a resting mouth.
    const paused = stagePose({
      mode: 'speech',
      elapsedMs: 900,
      seed: 'a',
      runtime,
      speechMs: null,
    });
    expect(paused.speaking).toBe(false);
  });

  it('is deterministic: same instant, same pose', () => {
    const runtime = demoRuntime(DEMO_LINES.en, 'en');
    const a = stagePose({ mode: 'demo', elapsedMs: 1234, seed: 'stock_lucia', runtime });
    const b = stagePose({ mode: 'demo', elapsedMs: 1234, seed: 'stock_lucia', runtime });
    expect(a).toEqual(b);
  });

  it('fits the rig box and the backing store', () => {
    expect(stageBox(400, 500, 'bust')).toEqual({ x: 0, y: 0, w: 400, h: 500 });
    const wide = stageBox(1000, 400, 'bust');
    expect(wide.w).toBeCloseTo(460);
    expect(wide.x).toBeCloseTo(270);
    expect(backingSize(200, 250, 2)).toEqual({ width: 400, height: 500, scale: 2 });
    const capped = backingSize(800, 1000, 2, 900);
    expect(Math.max(capped.width, capped.height)).toBe(900);
    expect(backingSize(100, 100, 0.5).scale).toBe(1);
  });

  it('shares one animation loop between stages', () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => frames.push(callback));
    const caf = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeTicker(a, 30);
    const offB = subscribeTicker(b, 30);
    expect(tickerSize()).toBe(2);
    expect(frames).toHaveLength(1);
    frames.shift()?.(1000);
    expect(a).toHaveBeenCalledWith(1000);
    expect(b).toHaveBeenCalledWith(1000);
    // 10 ms later is too soon for a 30 fps subscriber.
    frames.shift()?.(1010);
    expect(a).toHaveBeenCalledTimes(1);
    frames.shift()?.(1034);
    expect(a).toHaveBeenCalledTimes(2);
    offA();
    offB();
    expect(tickerSize()).toBe(0);
    raf.mockRestore();
    caf.mockRestore();
  });
});

describe('consent declaration', () => {
  const complete = { subjectName: ' Lucía Ferrer ', relationship: 'self' as const, accepted: true };

  it('requires the name and the checkbox', () => {
    expect(consentProblems({ subjectName: '', relationship: 'self', accepted: false })).toEqual({
      subjectName: 'nameRequired',
      accepted: 'notAccepted',
    });
    expect(consentProblems({ ...complete, subjectName: 'L' }).subjectName).toBe('nameTooShort');
    expect(consentProblems({ ...complete, subjectName: 'x'.repeat(121) }).subjectName).toBe(
      'nameTooLong',
    );
    expect(isConsentComplete(complete)).toBe(true);
    expect(isConsentComplete({ ...complete, accepted: false })).toBe(false);
  });

  it('builds the body of POST /api/consents with the versioned statement', () => {
    expect(consentBody('voice_clone', complete, 'en')).toEqual({
      kind: 'voice_clone',
      subjectName: 'Lucía Ferrer',
      relationship: 'self',
      statementVersion: CONSENT_STATEMENT_VERSION,
      locale: 'en',
      accepted: true,
    });
    expect(consentStatement('photo_avatar', 'es')).toMatch(/consiento que Parlante/);
    expect(consentStatement('voice_clone', 'en')).toMatch(/synthetic voice/);
  });

  it('identifies a declaration so an unused record is only reused for the same one', () => {
    const key = consentKey('photo_avatar', complete, 'es');
    expect(consentKey('photo_avatar', { ...complete, subjectName: 'Lucía Ferrer' }, 'es')).toBe(
      key,
    );
    expect(consentKey('photo_avatar', { ...complete, relationship: 'authorized' }, 'es')).not.toBe(
      key,
    );
    expect(consentKey('voice_clone', complete, 'es')).not.toBe(key);
  });
});

describe('engine state', () => {
  it('classifies the health of the engine', () => {
    expect(engineHealth(null)).toBe('unknown');
    expect(engineHealth(engineOff())).toBe('off');
    expect(engineHealth(engineReady())).toBe('ready');
    const partial = engineReady({ operations: { generate: false, prepare: true, animate: true } });
    expect(engineHealth(partial)).toBe('partial');
    expect(engineCan(partial, 'generate')).toBe(false);
    expect(engineCan(partial, 'prepare')).toBe(true);
    expect(engineCan(engineOff(), 'animate')).toBe(false);
  });

  it('only reports measured figures', () => {
    expect(animationSeconds(engineReady(), 10)).toBe(142);
    expect(animationSeconds(engineReady({ secondsPerVideoSecond: null }), 10)).toBeNull();
    expect(animationSeconds(engineOff(), 10)).toBeNull();
    expect(portraitSeconds(engineReady())).toBe(95);
    expect(portraitSeconds(engineReady({ secondsPerPortrait: null }))).toBeNull();
  });

  it('prefers the server ETA and marks its own fallback as estimated', () => {
    expect(remainingSeconds({ etaSec: 40, progress: 10, totalSec: 95 })).toEqual({
      seconds: 40,
      estimated: false,
    });
    expect(remainingSeconds({ etaSec: null, progress: 50, totalSec: 90 })).toEqual({
      seconds: 45,
      estimated: true,
    });
    expect(remainingSeconds({ etaSec: null, progress: 50, totalSec: null })).toBeNull();
  });

  it('lists non-commercial and missing models', () => {
    const engine = engineReady({
      models: [
        { id: 'a', role: 'animation', downloaded: true, license: 'CC-BY-NC', commercialUse: false },
        { id: 'b', role: 'matting', downloaded: false, license: 'MIT', commercialUse: true },
        { id: 'c', role: 'other', downloaded: false, license: 'NC', commercialUse: false },
      ],
    });
    // A non-commercial model that is not downloaded restricts nothing.
    expect(nonCommercialModels(engine).map((m) => m.id)).toEqual(['a']);
    expect(missingModels(engine).map((m) => m.id)).toEqual(['b', 'c']);
  });
});

describe('creation failures', () => {
  it('maps API error codes to something the page can act on', () => {
    const of = (code: string) => creationFailure({ code });
    expect(of('CONSENT_REQUIRED')).toBe('consent');
    expect(of('INSUFFICIENT_CREDITS')).toBe('credits');
    expect(of('PLAN_LIMIT_EXCEEDED')).toBe('limit');
    expect(of('CONTENT_BLOCKED')).toBe('blocked');
    expect(of('SERVICE_UNAVAILABLE')).toBe('engine');
    expect(of('PROVIDER_NOT_CONFIGURED')).toBe('notConfigured');
    expect(of('CONFLICT')).toBe('sourceInUse');
    expect(of('UNSUPPORTED_MEDIA_TYPE')).toBe('wrongFileType');
    expect(of('INTERNAL')).toBe('generic');
    expect(isEngineFailure('engine')).toBe(true);
    expect(isEngineFailure('credits')).toBe(false);
    expect(isRetryable('network')).toBe(true);
    expect(isRetryable('consent')).toBe(false);
  });
});

describe('silent composition previews', () => {
  it('estimates narration only for scenes with TTS text', () => {
    const detail = makeTemplateDetail(makeTemplate('demo'));
    const runtime = estimatedRuntime(detail.composition);
    const [first, second] = detail.composition.scenes;
    expect(runtime.scenes[first?.id ?? '']?.audioDurationMs).toBeGreaterThan(600);
    expect(runtime.scenes[second?.id ?? '']).toBeUndefined();
  });

  it('lists what a preview has to fetch and clamps the playhead', () => {
    const composition = starterComposition({
      title: 'x',
      text: 'Hola',
      locale: 'es',
      avatarId: 'avt_0001abcdefgh1234',
    });
    expect(previewDependencies(composition)).toEqual({
      assetIds: [],
      avatarIds: ['avt_0001abcdefgh1234'],
    });
    expect(clampPlayhead(-5, 1000)).toBe(0);
    expect(clampPlayhead(5000, 1000)).toBe(999);
    expect(clampPlayhead(10, 0)).toBe(0);
  });
});

describe('use in a video', () => {
  it('builds a valid one-scene draft with the chosen avatar', () => {
    const composition = starterComposition({
      title: 'Vídeo con Mateo',
      text: 'Hola, soy Mateo.',
      locale: 'es',
      avatarId: 'stock_mateo',
    });
    expect(CompositionSchema.safeParse(composition).success).toBe(true);
    expect(collectAvatarIds(composition)).toEqual(['stock_mateo']);
    const script = composition.scenes[0]?.script;
    expect(script).toMatchObject({ kind: 'tts', text: 'Hola, soy Mateo.', language: 'es' });
  });

  it('narrates with the recommended voice when no voice was chosen, never over a chosen one', () => {
    const base = { title: 'x', text: 'Hola', locale: 'es' };
    const script = (input: Parameters<typeof starterComposition>[0]) =>
      starterComposition(input).scenes[0]?.script;
    // What the server recommends (an installed neural voice) …
    expect(script({ ...base, defaultVoiceId: 'kokoro:ef_dora' })).toMatchObject({
      voiceId: 'kokoro:ef_dora',
      language: 'es',
    });
    // … the always-available local voice when nothing is known …
    expect(script(base)).toMatchObject({ voiceId: 'espeak:es-f1' });
    // … and the voice the person picked wins over both.
    expect(
      script({
        ...base,
        defaultVoiceId: 'kokoro:ef_dora',
        voice: { id: 'espeak:fr-f1', language: 'fr' },
      }),
    ).toMatchObject({ voiceId: 'espeak:fr-f1', language: 'fr' });
  });

  it('uses the voice and its language when a voice starts the video', () => {
    const composition = starterComposition({
      title: 'Voz',
      text: 'Bonjour',
      locale: 'es',
      voice: { id: 'espeak:fr-f1', language: 'fr' },
    });
    expect(composition.scenes[0]?.script).toMatchObject({
      kind: 'tts',
      voiceId: 'espeak:fr-f1',
      language: 'fr',
    });
    // No avatar chosen: the default stock avatar presents.
    expect(collectAvatarIds(composition)).toHaveLength(1);
  });
});

describe('routes to other features', () => {
  it('only offers what is mounted', () => {
    const patterns = ['/studio/:videoId', '/videos/:videoId'];
    expect(routeExists(patterns, '/studio/vid_1')).toBe(true);
    expect(routeExists(patterns, '/settings/billing')).toBe(false);
    const none = {
      studio: false,
      video: false,
      consents: false,
      billing: false,
      newAvatar: false,
      cloneVoice: false,
      avatars: false,
      voices: false,
      brandKit: false,
    };
    expect(draftPath({ ...none, studio: true, video: true }, 'vid_1')).toBe('/studio/vid_1');
    expect(draftPath({ ...none, video: true }, 'vid_1')).toBe('/videos/vid_1');
    expect(draftPath(none, 'vid_1')).toBeNull();
  });
});
