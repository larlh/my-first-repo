import { PLANS, createComposition } from '@parlante/shared';
import type { ProviderRef, Video } from '@parlante/shared';
import { describe, expect, it } from 'vitest';
import { activeCueIndex } from '../components/TranscriptPanel';
import { withDownloadName } from './files';
import {
  EMPTY_FILTERS,
  PAGE_SIZE,
  filtersToParams,
  filtersToQuery,
  hasActiveFilters,
  parseFilters,
} from './filters';
import { routeExists } from './routes';
import { expiryToDate, isExpired, isShareLive } from './share';
import {
  canShare,
  cardDurationMs,
  downloadFileName,
  hasBasicProvider,
  isOutdated,
  isVideoActive,
  listProvenance,
  narrationLanguage,
  quoteRender,
} from './video';

const basic: ProviderRef = { id: 'espeak', name: 'eSpeak NG', quality: 'basic', local: true };
const premium: ProviderRef = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  quality: 'premium',
  local: false,
};

describe('list filters', () => {
  it('reads filters from the query string and ignores anything unknown', () => {
    expect(parseFilters(new URLSearchParams(''))).toEqual(EMPTY_FILTERS);
    expect(
      parseFilters(
        new URLSearchParams('q=%20 noticia &status=completed&batchJobId=bat_a1b2c3d4e5f6g7h8'),
      ),
    ).toEqual({ q: 'noticia', status: 'completed', batchJobId: 'bat_a1b2c3d4e5f6g7h8' });
    // Unknown status, malformed batch id and an over-long query are dropped / clamped.
    const odd = parseFilters(
      new URLSearchParams(`status=deleted&batchJobId=../etc&q=${'x'.repeat(300)}`),
    );
    expect(odd.status).toBe('all');
    expect(odd.batchJobId).toBeNull();
    expect(odd.q).toHaveLength(100);
  });

  it('serialises only non-default filters and round-trips', () => {
    expect(filtersToParams(EMPTY_FILTERS).toString()).toBe('');
    const filters = { q: 'otoño', status: 'rendering' as const, batchJobId: null };
    const params = filtersToParams(filters);
    expect(params.toString()).toBe('q=oto%C3%B1o&status=rendering');
    expect(parseFilters(params)).toEqual(filters);
  });

  it('builds the API query without empty values', () => {
    expect(filtersToQuery(EMPTY_FILTERS)).toEqual({ limit: PAGE_SIZE });
    expect(
      filtersToQuery({ q: '  hola ', status: 'failed', batchJobId: 'bat_a1b2c3d4e5f6g7h8' }, 6),
    ).toEqual({
      limit: 6,
      q: 'hola',
      status: 'failed',
      batchJobId: 'bat_a1b2c3d4e5f6g7h8',
    });
  });

  it('knows when a filter is active', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, q: '   ' })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, q: 'a' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, status: 'draft' })).toBe(true);
  });
});

describe('video state', () => {
  it('treats queued and rendering as active', () => {
    expect(isVideoActive({ status: 'queued' })).toBe(true);
    expect(isVideoActive({ status: 'rendering' })).toBe(true);
    expect(isVideoActive({ status: 'completed' })).toBe(false);
    expect(isVideoActive({ status: 'draft' })).toBe(false);
    expect(isVideoActive({ status: 'failed' })).toBe(false);
  });

  it('flags an output older than the composition as outdated', () => {
    expect(isOutdated({ revision: 5, renderedRevision: 4, videoUrl: 'u' })).toBe(true);
    expect(isOutdated({ revision: 4, renderedRevision: 4, videoUrl: 'u' })).toBe(false);
    // Never rendered: there is nothing to be outdated.
    expect(isOutdated({ revision: 5, renderedRevision: null, videoUrl: null })).toBe(false);
    expect(isOutdated({ revision: 5, renderedRevision: 4, videoUrl: null })).toBe(false);
  });

  it('only shares completed videos with an output', () => {
    expect(canShare({ status: 'completed', videoUrl: 'u' })).toBe(true);
    expect(canShare({ status: 'completed', videoUrl: null })).toBe(false);
    expect(canShare({ status: 'rendering', videoUrl: 'u' })).toBe(false);
  });

  it('hides a zero or missing duration', () => {
    expect(cardDurationMs({ durationMs: 42_000 })).toBe(42_000);
    expect(cardDurationMs({ durationMs: 0 })).toBeNull();
    expect(cardDurationMs({ durationMs: null })).toBeNull();
  });

  it('finds the narration language of a composition', () => {
    const composition = createComposition();
    expect(narrationLanguage(composition)).toBeNull();
    const scene = composition.scenes[0];
    if (!scene) throw new Error('fixture');
    scene.script = {
      kind: 'tts',
      text: 'Bonjour',
      voiceId: 'espeak:fr',
      speed: 1,
      pitch: 0,
      language: 'fr-FR',
    };
    expect(narrationLanguage(composition)).toBe('fr');
  });
});

describe('render quote', () => {
  const video: Pick<Video, 'estimatedDurationMs' | 'usesPhotorealAvatars'> = {
    estimatedDurationMs: 42_000,
    usesPhotorealAvatars: false,
  };

  it('charges per started 30 s, double at 1080p', () => {
    const [hd, fullHd] = quoteRender(video, 'creator', 10);
    expect(hd).toEqual({ resolution: '720p', credits: 2, allowed: true, affordable: true });
    expect(fullHd).toEqual({ resolution: '1080p', credits: 4, allowed: true, affordable: true });
  });

  it('doubles again for photorealistic avatars and respects plan and balance', () => {
    const [hd, fullHd] = quoteRender({ ...video, usesPhotorealAvatars: true }, 'free', 5);
    expect(PLANS.free.limits.maxResolution).toBe('720p');
    expect(hd).toMatchObject({ credits: 4, allowed: true, affordable: true });
    expect(fullHd).toMatchObject({ credits: 8, allowed: false, affordable: false });
  });
});

describe('provenance', () => {
  it('lists providers in a stable, meaningful order', () => {
    const entries = listProvenance({ storage: basic, lipsync: basic, tts: premium });
    expect(entries.map((entry) => entry.capability)).toEqual(['tts', 'lipsync', 'storage']);
    expect(listProvenance(null)).toEqual([]);
  });

  it('reports basic mode only for AI parts (storage on disk does not count)', () => {
    expect(hasBasicProvider(listProvenance({ tts: premium, storage: basic }))).toBe(false);
    expect(hasBasicProvider(listProvenance({ tts: basic, lipsync: premium }))).toBe(true);
  });
});

describe('file names', () => {
  it('builds a safe download name from the title', () => {
    expect(downloadFileName('Bienvenida al equipo', 'srt')).toBe('Bienvenida-al-equipo.srt');
    expect(downloadFileName('Lanzamiento de otoño — ¡ya!', 'vtt')).toBe(
      'Lanzamiento-de-otono-ya.vtt',
    );
    expect(downloadFileName('../../etc/passwd', 'mp4')).toBe('etc-passwd.mp4');
    expect(downloadFileName('  ///  ', 'mp4')).toBe('video.mp4');
  });

  it('adds a download name only to signed API file URLs that lack one', () => {
    const signed = 'http://localhost:4000/api/files/a/b.srt?exp=1&sig=abc';
    expect(withDownloadName(signed, 'mi vídeo.srt')).toBe(`${signed}&download=mi%20v%C3%ADdeo.srt`);
    expect(withDownloadName(`${signed}&download=x.srt`, 'y.srt')).toBe(`${signed}&download=x.srt`);
    expect(
      withDownloadName('https://bucket.s3.amazonaws.com/b.srt?X-Amz-Signature=1', 'y.srt'),
    ).toBe('https://bucket.s3.amazonaws.com/b.srt?X-Amz-Signature=1');
  });
});

describe('share link state', () => {
  const now = Date.parse('2026-11-20T10:00:00.000Z');

  it('turns an expiry choice into a date', () => {
    expect(expiryToDate('never', now)).toBeNull();
    expect(expiryToDate('day', now)).toBe('2026-11-21T10:00:00.000Z');
    expect(expiryToDate('week', now)).toBe('2026-11-27T10:00:00.000Z');
    expect(expiryToDate('month', now)).toBe('2026-12-20T10:00:00.000Z');
  });

  it('is live only when enabled and not expired', () => {
    expect(isShareLive(null, now)).toBe(false);
    expect(isShareLive({ enabled: true, expiresAt: null }, now)).toBe(true);
    expect(isShareLive({ enabled: false, expiresAt: null }, now)).toBe(false);
    expect(isShareLive({ enabled: true, expiresAt: '2026-11-20T09:59:59.000Z' }, now)).toBe(false);
    expect(isExpired({ expiresAt: '2026-11-20T10:00:01.000Z' }, now)).toBe(false);
  });
});

describe('optional routes', () => {
  it('matches a concrete URL against registered patterns, whatever the param is called', () => {
    const patterns = ['/videos', '/studio/:id', '/settings/billing'];
    expect(routeExists(patterns, '/studio/vid_probe')).toBe(true);
    expect(routeExists(patterns, '/settings/billing')).toBe(true);
    expect(routeExists(patterns, '/templates')).toBe(false);
    expect(routeExists(patterns, '/studio/vid_probe/extra')).toBe(false);
  });
});

describe('transcript', () => {
  const cues = [
    { startMs: 0, endMs: 1800, text: 'uno' },
    { startMs: 1800, endMs: 3600, text: 'dos' },
    { startMs: 5000, endMs: 6000, text: 'tres' },
  ];
  it('finds the cue being spoken', () => {
    expect(activeCueIndex(cues, 0)).toBe(0);
    expect(activeCueIndex(cues, 1800)).toBe(1);
    expect(activeCueIndex(cues, 4000)).toBe(-1);
    expect(activeCueIndex(cues, 5999)).toBe(2);
    expect(activeCueIndex(cues, 6000)).toBe(-1);
    expect(activeCueIndex([], 100)).toBe(-1);
  });
});
