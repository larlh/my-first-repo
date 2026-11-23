import type { PublicShare } from '@parlante/shared';

/* Link-preview metadata of the public share page (Open Graph + Twitter card + canonical).
 *
 * Parlante's web app is a client-rendered SPA, so these tags are written into <head> once the
 * share has loaded: browsers, "share" sheets and crawlers that execute JavaScript read them.
 * Crawlers that do NOT run JavaScript only see the static index.html: covering those needs the
 * same tags rendered by the server for `/s/:token` (`buildShareMeta` is pure so a server route
 * can reuse it). Signed media URLs also expire after a few hours, like every file URL. */

export interface MetaTag {
  /** `property` for Open Graph, `name` for everything else. */
  attr: 'property' | 'name';
  key: string;
  content: string;
}

export interface ShareMeta {
  title: string;
  canonical: string;
  tags: MetaTag[];
}

export interface ShareMetaInput {
  share: Pick<
    PublicShare,
    | 'title'
    | 'aspect'
    | 'durationMs'
    | 'videoUrl'
    | 'thumbnailUrl'
    | 'workspaceName'
    | 'aiGenerated'
  >;
  /** Absolute URL of the public page (no query, no hash). */
  pageUrl: string;
  /** Already translated one-line description. */
  description: string;
  locale: 'es' | 'en';
}

const OG_LOCALE = { es: 'es_ES', en: 'en_US' } as const;
/** Pixel size of the exported picture per shape (720p renders). */
const FRAME_SIZE = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 720, height: 720 },
} as const;

function isAbsoluteHttpUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** Pure: everything the page head should say about a shared video. */
export function buildShareMeta({ share, pageUrl, description, locale }: ShareMetaInput): ShareMeta {
  const title = share.title.trim() === '' ? 'Parlante' : share.title.trim();
  const size = FRAME_SIZE[share.aspect];
  const tags: MetaTag[] = [
    { attr: 'name', key: 'description', content: description },
    // Shared by link, not published: keep it out of search results.
    { attr: 'name', key: 'robots', content: 'noindex' },
    { attr: 'property', key: 'og:site_name', content: 'Parlante' },
    { attr: 'property', key: 'og:type', content: 'video.other' },
    { attr: 'property', key: 'og:title', content: title },
    { attr: 'property', key: 'og:description', content: description },
    { attr: 'property', key: 'og:url', content: pageUrl },
    { attr: 'property', key: 'og:locale', content: OG_LOCALE[locale] },
    { attr: 'name', key: 'twitter:title', content: title },
    { attr: 'name', key: 'twitter:description', content: description },
  ];
  if (isAbsoluteHttpUrl(share.thumbnailUrl)) {
    tags.push(
      { attr: 'property', key: 'og:image', content: share.thumbnailUrl },
      { attr: 'property', key: 'og:image:width', content: String(size.width) },
      { attr: 'property', key: 'og:image:height', content: String(size.height) },
      { attr: 'property', key: 'og:image:alt', content: title },
      { attr: 'name', key: 'twitter:card', content: 'summary_large_image' },
      { attr: 'name', key: 'twitter:image', content: share.thumbnailUrl },
    );
  } else {
    tags.push({ attr: 'name', key: 'twitter:card', content: 'summary' });
  }
  if (isAbsoluteHttpUrl(share.videoUrl)) {
    tags.push(
      { attr: 'property', key: 'og:video', content: share.videoUrl },
      { attr: 'property', key: 'og:video:type', content: 'video/mp4' },
      { attr: 'property', key: 'og:video:width', content: String(size.width) },
      { attr: 'property', key: 'og:video:height', content: String(size.height) },
    );
  }
  if (share.durationMs !== null && share.durationMs > 0) {
    tags.push({
      attr: 'property',
      key: 'video:duration',
      content: String(Math.round(share.durationMs / 1000)),
    });
  }
  return { title: `${title} · Parlante`, canonical: pageUrl, tags };
}

/**
 * Write `meta` into the document head. Returns a function that puts the head back exactly as
 * it was (tags this call created are removed, tags it overwrote get their old content).
 */
export function applyShareMeta(doc: Document, meta: ShareMeta): () => void {
  const undo: (() => void)[] = [];

  const previousTitle = doc.title;
  doc.title = meta.title;
  undo.push(() => {
    doc.title = previousTitle;
  });

  for (const tag of meta.tags) {
    const selector = `meta[${tag.attr}="${tag.key}"]`;
    const existing = doc.head.querySelector<HTMLMetaElement>(selector);
    if (existing) {
      const previous = existing.getAttribute('content');
      existing.setAttribute('content', tag.content);
      undo.push(() => {
        if (previous === null) existing.removeAttribute('content');
        else existing.setAttribute('content', previous);
      });
    } else {
      const element = doc.createElement('meta');
      element.setAttribute(tag.attr, tag.key);
      element.setAttribute('content', tag.content);
      doc.head.appendChild(element);
      undo.push(() => element.remove());
    }
  }

  const existingCanonical = doc.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (existingCanonical) {
    const previous = existingCanonical.getAttribute('href');
    existingCanonical.setAttribute('href', meta.canonical);
    undo.push(() => {
      if (previous === null) existingCanonical.removeAttribute('href');
      else existingCanonical.setAttribute('href', previous);
    });
  } else {
    const link = doc.createElement('link');
    link.setAttribute('rel', 'canonical');
    link.setAttribute('href', meta.canonical);
    doc.head.appendChild(link);
    undo.push(() => link.remove());
  }

  return () => {
    for (const step of undo.reverse()) step();
  };
}

/** Absolute URL of the page a visitor is on, without query string or hash. */
export function canonicalPageUrl(location: Pick<Location, 'origin' | 'pathname'>): string {
  return `${location.origin}${location.pathname}`;
}
