import { api, creditsForTranslation } from '@parlante/shared';
import { describe, expect, it } from 'vitest';
import { makeOutput, makeTranslation } from '@/features/script-writer/kit/testing/fixtures';
import {
  AUTO,
  billedMinutes,
  buildCreateBody,
  checkTranscript,
  countByStatus,
  detectTranscriptFormat,
  emptyForm,
  formProblems,
  isActive,
  languageResults,
  targetChoices,
  toggleTarget,
  translationCost,
  withoutSource,
} from './translate';
import type { FormContext, TranslationForm } from './translate';

const SRT = `1
00:00:00,000 --> 00:00:01,500
Hola, soy Marta.

2
00:00:01,500 --> 00:00:04,000
Te doy la bienvenida al equipo.
`;

const CONTEXT: FormContext = {
  transcriptRequired: true,
  maxTargets: 3,
  maxSourceSec: 600,
  credits: 100,
};

function filled(overrides: Partial<TranslationForm> = {}): TranslationForm {
  return {
    ...emptyForm('es'),
    source: {
      kind: 'asset',
      assetId: 'ast_0001abcdefgh1234',
      name: 'presentacion.mp4',
      durationMs: 95_000,
      thumbnailUrl: null,
    },
    targets: ['en', 'fr'],
    transcript: SRT,
    ...overrides,
  };
}

describe('target languages', () => {
  it('offers every language but the source and respects the plan limit', () => {
    expect(targetChoices('es')).not.toContain('es');
    expect(targetChoices('es')).toContain('en');

    let targets = toggleTarget([], 'fr', 2);
    targets = toggleTarget(targets, 'en', 2);
    // Catalogue order, not click order.
    expect(targets).toEqual(['en', 'fr']);
    // A third one is refused when the plan allows two.
    expect(toggleTarget(targets, 'de', 2)).toEqual(['en', 'fr']);
    expect(toggleTarget(targets, 'en', 2)).toEqual(['fr']);
    expect(withoutSource(['en', 'fr'], 'fr')).toEqual(['en']);
  });
});

describe('transcript', () => {
  it('guesses the format from the file name or the content', () => {
    expect(detectTranscriptFormat('subs.vtt', '')).toBe('vtt');
    expect(detectTranscriptFormat('subs.txt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nHola')).toBe(
      'vtt',
    );
    expect(detectTranscriptFormat('subs.srt', '')).toBe('srt');
    expect(detectTranscriptFormat('notas.txt', SRT)).toBe('srt');
    expect(detectTranscriptFormat('notas.txt', 'Hola, soy Marta.')).toBe('text');
  });

  it('reads cues the way the server will and explains what is wrong', () => {
    expect(checkTranscript('srt', SRT, 10_000)).toEqual({
      problem: null,
      cues: 2,
      coveredMs: 4000,
      ignored: 0,
    });
    // The second cue starts after a 1.5 s video ends: ignored, the first is kept.
    expect(checkTranscript('srt', SRT, 1500)).toMatchObject({ problem: null, cues: 1, ignored: 1 });
    expect(checkTranscript('srt', SRT, 0 + 1).problem).toBeNull();
    expect(checkTranscript('srt', '   ', 10_000).problem).toBe('empty');
    expect(checkTranscript('srt', 'Hola, sin tiempos.', 10_000).problem).toBe('noCues');
    expect(
      checkTranscript('srt', '1\n00:01:00,000 --> 00:01:02,000\nTarde.\n', 10_000).problem,
    ).toBe('outOfRange');
    expect(checkTranscript('text', 'x'.repeat(500_001), 10_000).problem).toBe('tooLong');
    // Plain text is spread over the video; with unknown length only the format is checked.
    expect(checkTranscript('text', 'Hola, soy Marta. Bienvenida.', 8000).problem).toBeNull();
    expect(checkTranscript('text', 'Hola, soy Marta.', null).problem).toBeNull();
  });
});

describe('form', () => {
  it('costs what the server will charge: started minutes × languages', () => {
    expect(translationCost(emptyForm('es'))).toBeNull();
    expect(translationCost(filled({ targets: [] }))).toBeNull();
    expect(translationCost(filled())).toBe(creditsForTranslation(95_000, 2));
    expect(billedMinutes(95_000)).toBe(2);
    expect(billedMinutes(1)).toBe(1);
    expect(billedMinutes(60_000)).toBe(1);
  });

  it('lists everything that blocks the job', () => {
    expect(formProblems(emptyForm('es'), CONTEXT)).toEqual([
      'noSource',
      'noTargets',
      'transcriptRequired',
    ]);
    expect(formProblems(filled(), CONTEXT)).toEqual([]);
    expect(formProblems(filled({ transcript: '' }), CONTEXT)).toEqual(['transcriptRequired']);
    // With real speech recognition the transcript is optional…
    expect(
      formProblems(filled({ transcript: '' }), { ...CONTEXT, transcriptRequired: false }),
    ).toEqual([]);
    // …but one that is written must still be readable.
    expect(
      formProblems(filled({ transcript: 'sin tiempos' }), {
        ...CONTEXT,
        transcriptRequired: false,
      }),
    ).toEqual(['transcriptInvalid']);
    expect(formProblems(filled(), { ...CONTEXT, maxTargets: 1 })).toEqual(['tooManyTargets']);
    expect(formProblems(filled(), { ...CONTEXT, maxSourceSec: 60 })).toEqual(['sourceTooLong']);
    expect(formProblems(filled(), { ...CONTEXT, credits: 3 })).toEqual(['insufficientCredits']);
    const noLength = filled();
    if (noLength.source) noLength.source.durationMs = null;
    expect(formProblems(noLength, CONTEXT)).toContain('unknownDuration');
  });

  it('builds a body the contract accepts for uploads and for workspace videos', () => {
    const upload = buildCreateBody(
      filled({ name: '  Demo  ', voices: { en: 'espeak:en-f1', fr: AUTO, de: 'espeak:de-f1' } }),
    );
    expect(upload).toMatchObject({
      name: 'Demo',
      sourceAssetId: 'ast_0001abcdefgh1234',
      sourceLanguage: 'es',
      targetLanguages: ['en', 'fr'],
      transcript: { format: 'srt', content: SRT },
      // Only chosen voices of chosen targets: "automatic" and stale entries are left out.
      voices: { en: 'espeak:en-f1' },
      options: { originalAudioVolume: 0.08, burnSubtitles: false },
    });
    expect(upload).not.toHaveProperty('sourceVideoId');

    const video = buildCreateBody(
      filled({
        source: {
          kind: 'video',
          videoId: 'vid_0001abcdefgh1234',
          name: 'Vídeo 1',
          durationMs: 42_000,
          thumbnailUrl: null,
        },
        transcript: '',
        originalAudioVolume: 0.333,
        burnSubtitles: true,
      }),
    );
    expect(video).not.toHaveProperty('sourceAssetId');
    expect(video).not.toHaveProperty('transcript');
    expect(video).not.toHaveProperty('name');
    expect(video.options).toEqual({ originalAudioVolume: 0.33, burnSubtitles: true });
    for (const body of [upload, video]) {
      expect(api.translations.create.body.safeParse(body).success).toBe(true);
    }
    expect(() => buildCreateBody(emptyForm('es'))).toThrow();
  });
});

describe('reading a job', () => {
  it('gives one entry per target language, in the order asked', () => {
    const job = makeTranslation(1, {
      status: 'processing',
      targetLanguages: ['en', 'fr', 'de'],
      outputs: [makeOutput('fr', 'processing'), makeOutput('en', 'completed')],
    });
    const results = languageResults(job);
    expect(results.map((result) => [result.language, result.status])).toEqual([
      ['en', 'completed'],
      ['fr', 'processing'],
      // No output row yet.
      ['de', 'pending'],
    ]);
    expect(countByStatus(results)).toEqual({ pending: 1, processing: 1, completed: 1, failed: 0 });
    expect(isActive(job)).toBe(true);
  });

  it('never leaves a language "in progress" once the job failed', () => {
    const job = makeTranslation(2, {
      status: 'failed',
      targetLanguages: ['en', 'fr'],
      outputs: [makeOutput('en', 'processing')],
    });
    expect(languageResults(job).map((result) => result.status)).toEqual(['failed', 'failed']);
    expect(isActive(job)).toBe(false);
    expect(isActive({ status: 'queued' })).toBe(true);
    expect(isActive({ status: 'partial' })).toBe(false);
  });
});
