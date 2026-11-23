/* -------------------------------------------------------------------------------------------
 * Readable text of an HTML page, for "URL → script". The input is UNTRUSTED and can be large,
 * so this is a single forward pass built on `indexOf` (linear time, no backtracking regular
 * expressions over the document) and it never executes or loads anything.
 *
 * What is kept: the text of `<article>` (or `<main>`, or the whole body), one line per block.
 * What is dropped: scripts, styles, markup, navigation, headers, footers, forms and the like.
 * ----------------------------------------------------------------------------------------- */

export interface ExtractedPage {
  /** `og:title`, `<title>` or the first `<h1>`, whichever comes first in that order. */
  title: string | null;
  /** Paragraph-like lines separated by `\n`. */
  text: string;
}

/** Elements whose content is not markup: skipped up to their closing tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes']);
/** Elements whose whole subtree is page chrome or non-text, not content. */
const SKIPPED = new Set([
  'head',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  'svg',
  'canvas',
  'iframe',
  'noscript',
  'template',
  'dialog',
  'menu',
  'object',
  'audio',
  'video',
  'figure',
]);
const BLOCK = new Set([
  'p',
  'div',
  'br',
  'li',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'tr',
  'table',
  'section',
  'article',
  'main',
  'blockquote',
  'pre',
  'hr',
  'dd',
  'dt',
  'body',
  'html',
  'td',
  'th',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  iexcl: '¡',
  iquest: '¿',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  middot: '·',
  bull: '•',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  Uuml: 'Ü',
  agrave: 'à',
  egrave: 'è',
  igrave: 'ì',
  ograve: 'ò',
  ugrave: 'ù',
  acirc: 'â',
  ecirc: 'ê',
  icirc: 'î',
  ocirc: 'ô',
  ucirc: 'û',
  auml: 'ä',
  euml: 'ë',
  iuml: 'ï',
  ouml: 'ö',
  Auml: 'Ä',
  Ouml: 'Ö',
  szlig: 'ß',
  ccedil: 'ç',
  Ccedil: 'Ç',
  atilde: 'ã',
  otilde: 'õ',
  aring: 'å',
  oslash: 'ø',
  aelig: 'æ',
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,10});/g,
    (match, body: string) => {
      if (body.startsWith('#')) {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ' ';
        // Control characters and surrogates are never meaningful page text.
        if (code < 0x20 || (code >= 0x7f && code < 0xa0) || (code >= 0xd800 && code <= 0xdfff)) {
          return ' ';
        }
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body] ?? match;
    },
  );
}

function attribute(tag: string, name: string): string | null {
  // `tag` is one bounded tag, not the document.
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(
    tag,
  );
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function tidyLine(line: string): string {
  // Control and invisible format characters (zero-width spaces, BOM…) become spaces; `\s`
  // already covers no-break spaces and the Unicode line separators.
  return decodeEntities(line)
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tidyLines(raw: string): string[] {
  const lines: string[] = [];
  for (const piece of raw.split('\n')) {
    const line = tidyLine(piece);
    if (line === '' || line === lines[lines.length - 1]) continue;
    lines.push(line);
  }
  return lines;
}

/** Lines that read like prose: menu leftovers ("Inicio", "Leer más") are short and unpunctuated. */
function proseOnly(lines: string[]): string[] {
  return lines.filter((line) => line.split(' ').length >= 5 || /[.!?…:]$/u.test(line));
}

interface Pass {
  title: string | null;
  ogTitle: string | null;
  h1: string | null;
  article: string;
  main: string;
  body: string;
}

const MAX_TAG_CHARS = 4000;

function scan(html: string, skipChrome: boolean): Pass {
  const lower = html.toLowerCase();
  const out: Pass = { title: null, ogTitle: null, h1: null, article: '', main: '', body: '' };
  const skipped = new Map<string, number>();
  let skipDepth = 0;
  let articleDepth = 0;
  let mainDepth = 0;
  let h1Open = false;
  let h1Text = '';

  const emit = (text: string) => {
    if (text === '' || skipDepth > 0) return;
    out.body += text;
    if (articleDepth > 0) out.article += text;
    if (mainDepth > 0) out.main += text;
    if (h1Open) h1Text += text;
  };

  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt < 0) {
      emit(html.slice(pos));
      break;
    }
    emit(html.slice(pos, lt));
    if (lower.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      pos = end < 0 ? html.length : end + 3;
      continue;
    }
    const next = html.charCodeAt(lt + 1);
    const closing = next === 47; // '/'
    const nameStart = lt + (closing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < html.length && /[a-zA-Z0-9-]/.test(html.charAt(nameEnd))) nameEnd += 1;
    if (nameEnd === nameStart) {
      if (next === 33 || next === 63) {
        // <!doctype …> or <?xml …?>
        const end = html.indexOf('>', lt);
        pos = end < 0 ? html.length : end + 1;
      } else {
        // A lone "<" in text.
        emit('<');
        pos = lt + 1;
      }
      continue;
    }
    const name = lower.slice(nameStart, nameEnd);
    const gt = html.indexOf('>', nameEnd);
    const tagEnd = gt < 0 ? html.length : gt + 1;
    const selfClosing = gt > 0 && html.charCodeAt(gt - 1) === 47;
    pos = tagEnd;

    if (!closing && RAW_TEXT.has(name)) {
      const close = lower.indexOf(`</${name}`, tagEnd);
      const contentEnd = close < 0 ? html.length : close;
      if (name === 'title' && out.title === null && skipped.get('svg') === undefined) {
        out.title = tidyLine(html.slice(tagEnd, Math.min(contentEnd, tagEnd + 1000))) || null;
      }
      const closeGt = close < 0 ? -1 : html.indexOf('>', close);
      pos = close < 0 || closeGt < 0 ? html.length : closeGt + 1;
      continue;
    }
    if (!closing && name === 'meta' && out.ogTitle === null) {
      const tag = html.slice(lt, Math.min(tagEnd, lt + MAX_TAG_CHARS));
      const key = (attribute(tag, 'property') ?? attribute(tag, 'name') ?? '').toLowerCase();
      if (key === 'og:title' || key === 'twitter:title') {
        out.ogTitle = tidyLine(attribute(tag, 'content') ?? '') || null;
      }
    }
    // `head` is skipped as chrome in both modes: it never holds readable content.
    if (SKIPPED.has(name) && (skipChrome || name === 'head' || name === 'svg')) {
      if (selfClosing) continue;
      const depth = skipped.get(name) ?? 0;
      if (closing) {
        if (depth > 0) {
          if (depth === 1) skipped.delete(name);
          else skipped.set(name, depth - 1);
          skipDepth -= 1;
        }
      } else {
        skipped.set(name, depth + 1);
        skipDepth += 1;
      }
      continue;
    }
    if (name === 'article') articleDepth = Math.max(0, articleDepth + (closing ? -1 : 1));
    if (name === 'main') mainDepth = Math.max(0, mainDepth + (closing ? -1 : 1));
    if (BLOCK.has(name)) emit('\n');
    if (name === 'h1' && skipDepth === 0) {
      if (!closing && out.h1 === null) {
        h1Open = true;
        h1Text = '';
      } else if (closing && h1Open) {
        h1Open = false;
        out.h1 = tidyLine(h1Text).slice(0, 300) || null;
      }
    }
  }
  return out;
}

function pickContent(pass: Pass): string[] {
  const body = proseOnly(tidyLines(pass.body));
  const bodyChars = body.join(' ').length;
  for (const candidate of [pass.article, pass.main]) {
    const lines = proseOnly(tidyLines(candidate));
    const chars = lines.join(' ').length;
    // The marked-up main content, unless it is a stub next to a much longer page.
    if (chars >= 400 && chars >= bodyChars * 0.3) return lines;
  }
  return body;
}

/** Extract the title and the readable text of an HTML document. */
export function extractReadableText(html: string): ExtractedPage {
  let pass = scan(html, true);
  let lines = pickContent(pass);
  if (lines.join(' ').length < 200) {
    // Unbalanced markup (an unclosed <nav>, a page wrapped in <form>) can hide everything:
    // read it again dropping only what is never text.
    const loose = scan(html, false);
    const looseLines = pickContent(loose);
    if (looseLines.join(' ').length > lines.join(' ').length) {
      pass = loose;
      lines = looseLines;
    }
  }
  const title = pass.ogTitle ?? pass.title ?? pass.h1;
  return { title: title ? title.slice(0, 300) : null, text: lines.join('\n') };
}

/** Plain-text documents: same tidy-up, no markup handling. */
export function tidyPlainText(text: string): string {
  return tidyLines(text).join('\n');
}
