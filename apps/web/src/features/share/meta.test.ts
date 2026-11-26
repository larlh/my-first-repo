import { afterEach, describe, expect, it } from 'vitest';
import { applyShareMeta, buildShareMeta, canonicalPageUrl } from './meta';
import { listProvenance } from './provenance';

const share = {
  title: 'Bienvenida al equipo',
  aspect: '16:9' as const,
  durationMs: 42_400,
  videoUrl: 'http://localhost:4000/api/files/v.mp4?exp=1&sig=a',
  thumbnailUrl: 'http://localhost:4000/api/files/t.jpg?exp=1&sig=a',
  workspaceName: 'Estudio Norte',
  aiGenerated: false,
};
const input = {
  share,
  pageUrl: 'https://parlante.example/s/kq7mx2plw9zt4rbn',
  description: 'Vídeo compartido por Estudio Norte. Hecho con Parlante.',
  locale: 'es' as const,
};

function tag(meta: ReturnType<typeof buildShareMeta>, key: string): string | undefined {
  return meta.tags.find((item) => item.key === key)?.content;
}

describe('share link preview metadata', () => {
  it('describes the video for Open Graph and Twitter', () => {
    const meta = buildShareMeta(input);
    expect(meta.title).toBe('Bienvenida al equipo · Parlante');
    expect(meta.canonical).toBe(input.pageUrl);
    expect(tag(meta, 'og:title')).toBe('Bienvenida al equipo');
    expect(tag(meta, 'og:type')).toBe('video.other');
    expect(tag(meta, 'og:url')).toBe(input.pageUrl);
    expect(tag(meta, 'og:image')).toBe(share.thumbnailUrl);
    expect(tag(meta, 'og:video')).toBe(share.videoUrl);
    expect(tag(meta, 'og:video:width')).toBe('1280');
    expect(tag(meta, 'video:duration')).toBe('42');
    expect(tag(meta, 'og:locale')).toBe('es_ES');
    expect(tag(meta, 'twitter:card')).toBe('summary_large_image');
    expect(tag(meta, 'description')).toBe(input.description);
    expect(tag(meta, 'robots')).toBe('noindex');
    // Open Graph uses `property`, the rest `name`.
    expect(meta.tags.find((item) => item.key === 'og:title')?.attr).toBe('property');
    expect(meta.tags.find((item) => item.key === 'twitter:title')?.attr).toBe('name');
  });

  it('adapts to the shape and leaves out what it does not have', () => {
    const meta = buildShareMeta({
      ...input,
      locale: 'en',
      share: { ...share, aspect: '9:16', thumbnailUrl: null, durationMs: null, title: '  ' },
    });
    expect(meta.title).toBe('Parlante · Parlante');
    expect(tag(meta, 'og:image')).toBeUndefined();
    expect(tag(meta, 'twitter:card')).toBe('summary');
    expect(tag(meta, 'og:video:height')).toBe('1280');
    expect(tag(meta, 'video:duration')).toBeUndefined();
    expect(tag(meta, 'og:locale')).toBe('en_US');
  });

  it('never emits relative media URLs (crawlers cannot resolve them)', () => {
    const meta = buildShareMeta({
      ...input,
      share: { ...share, thumbnailUrl: '/api/files/t.jpg', videoUrl: '/api/files/v.mp4' },
    });
    expect(tag(meta, 'og:image')).toBeUndefined();
    expect(tag(meta, 'og:video')).toBeUndefined();
  });

  it('builds the canonical URL without query or hash', () => {
    expect(canonicalPageUrl({ origin: 'https://parlante.example', pathname: '/s/abc' })).toBe(
      'https://parlante.example/s/abc',
    );
  });
});

describe('writing the metadata into <head>', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    document.title = '';
  });

  it('creates the tags and restores the head exactly on cleanup', () => {
    document.head.innerHTML =
      '<title>Parlante</title><meta name="description" content="Parlante — vídeos con avatares."><meta charset="utf-8">';
    const before = document.head.innerHTML;

    const undo = applyShareMeta(document, buildShareMeta(input));
    expect(document.title).toBe('Bienvenida al equipo · Parlante');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      input.description,
    );
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe(
      share.thumbnailUrl,
    );
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      input.pageUrl,
    );

    undo();
    expect(document.title).toBe('Parlante');
    expect(document.head.innerHTML).toBe(before);
  });

  it('replaces the tags of a previous video instead of piling them up', () => {
    const first = applyShareMeta(document, buildShareMeta(input));
    first();
    applyShareMeta(
      document,
      buildShareMeta({ ...input, share: { ...share, title: 'Otro vídeo' } }),
    );
    expect(document.head.querySelectorAll('meta[property="og:title"]')).toHaveLength(1);
    expect(document.head.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(
      'Otro vídeo',
    );
  });
});

describe('public provenance', () => {
  it('shows only what shapes the picture and the sound, in a fixed order', () => {
    const basic = { id: 'espeak', name: 'eSpeak NG', quality: 'basic' as const, local: true };
    const entries = listProvenance({
      storage: basic,
      moderation: basic,
      lipsync: basic,
      tts: basic,
    });
    expect(entries.map((entry) => entry.capability)).toEqual(['tts', 'lipsync']);
    expect(listProvenance(null)).toEqual([]);
  });
});
