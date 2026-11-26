/* -------------------------------------------------------------------------------------------
 * Text preparation shared by every TTS adapter.
 *
 * A narration script is plain text that MAY contain basic SSML. `prepareSpeech` turns it into:
 *  - `display`: what people read (markup removed, entities decoded, whitespace collapsed) and
 *    its whitespace-separated `tokens` — the texts of the word cues;
 *  - `spoken`: what a plain-text engine should read (aliases applied, emoji and markdown
 *    markers removed) — sent to the external adapters;
 *  - `segments`: sanitised SSML for eSpeak NG, split at paragraph / sentence boundaries, with a
 *    map from every character of the markup back to `display`, so the word events eSpeak
 *    reports (positions in the markup) land on the right token.
 *
 * Sanitising is a whitelist: only the elements and attribute values below reach the engine.
 * Anything else that looks like a known tag is removed (its text is kept); `<` and `&` that are
 * not markup are spoken literally. Nothing in the input can make the engine open a file or
 * switch voice (`<audio>`, `<voice>`, `<lang>`, `<mark>`… never pass).
 *
 * All offsets are in CODE POINTS (that is what eSpeak reports), not UTF-16 units.
 * ----------------------------------------------------------------------------------------- */

export interface SpeechToken {
  text: string;
  /** Code-point offsets in `display`: [start, end). */
  start: number;
  end: number;
}

export interface SpeechSegment {
  /** Sanitised SSML fragment for eSpeak NG. */
  markup: string;
  /** For each code point of `markup`: index of the `display` code point it speaks, or -1. */
  map: Int32Array;
  /** Silence to insert after this segment at normal speed (0 for the last one). */
  pauseAfterMs: number;
}

export interface PreparedSpeech {
  display: string;
  spoken: string;
  tokens: SpeechToken[];
  segments: SpeechSegment[];
}

export interface PrepareSpeechOptions {
  /** Soft limit of display characters per segment (segments end at sentence boundaries). */
  maxSegmentChars?: number;
}

/** Pauses eSpeak itself makes inside one utterance at 175 wpm (measured), reused at joins. */
export const SENTENCE_PAUSE_MS = 300;
export const PARAGRAPH_PAUSE_MS = 530;
const DEFAULT_SEGMENT_CHARS = 700;
const MAX_BREAK_MS = 5000;

/** Elements whose text content is dropped together with the tag. */
const DROP_CONTENT = new Set(['script', 'style', 'desc', 'metadata', 'lexicon', 'meta']);
/** Elements recognised as markup: removed unless handled explicitly (their text is kept). */
const KNOWN_TAGS = new Set([
  ...['speak', 'break', 'emphasis', 'prosody', 'say-as', 'sub', 'p', 's', 'br'],
  ...['voice', 'lang', 'mark', 'audio', 'phoneme', 'w', 'token', 'bookmark'],
  ...['b', 'i', 'u', 'em', 'strong', 'span', 'div', 'a', 'font', 'small', 'big', 'sup'],
  ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre'],
  ...DROP_CONTENT,
]);
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const BREAK_STRENGTHS = new Set(['none', 'x-weak', 'weak', 'medium', 'strong', 'x-strong']);
const EMPHASIS_LEVELS = new Set(['strong', 'moderate', 'reduced', 'none']);
const PROSODY_RATES = new Set(['x-slow', 'slow', 'medium', 'fast', 'x-fast', 'default']);
const PROSODY_PITCHES = new Set(['x-low', 'low', 'medium', 'high', 'x-high', 'default']);
const PROSODY_VOLUMES = new Set(['silent', 'x-soft', 'soft', 'medium', 'loud', 'x-loud']);
const SAY_AS: Readonly<Record<string, string>> = {
  characters: 'characters',
  'spell-out': 'characters',
  digits: 'tts:digits',
  'tts:digits': 'tts:digits',
  telephone: 'telephone',
};

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const TAG =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s[^<>]*)?)(\/?)>/gi;
const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** Control and zero-width characters that must never reach an engine. */
// eslint-disable-next-line no-control-regex -- removing control characters is the purpose
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2060\uFEFF]/g;
/** Emoji and their modifiers: shown, never spoken (engines read their names out loud). */
const PICTOGRAPH =
  /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|\u{FE0E}|\u{FE0F}|\u{200D}|\u{20E3}|[\u{E0020}-\u{E007F}]/u;
/** Pictographic by Unicode, but engines read them properly ("copyright", "registered"…). */
const SPOKEN_SYMBOLS = new Set(['©', '®', '™']);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const SENTENCE_END = /[.!?…]/;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return ' ';
      if (code >= 0xd800 && code <= 0xdfff) return ' ';
      return String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function escapeMarkup(ch: string): string {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  return ch;
}

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    out[name] = (match[2] ?? match[3] ?? '').trim();
  }
  return out;
}

/** `500ms`, `1.5s`, `2` (seconds) → clamped milliseconds, or null when malformed. */
function breakTimeMs(value: string): number | null {
  const match = /^(\d{1,6}(?:\.\d{1,3})?)\s*(ms|s)?$/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const ms = (match[2] ?? 's').toLowerCase() === 'ms' ? amount : amount * 1000;
  return Math.round(Math.min(MAX_BREAK_MS, Math.max(0, ms)));
}

function sanitizeProsody(attrs: Record<string, string>): string | null {
  const parts: string[] = [];
  const percent = /^[+-]?\d{1,3}%$/;
  const rate = attrs.rate?.toLowerCase();
  if (rate && (PROSODY_RATES.has(rate) || /^\d{1,3}%$/.test(rate))) parts.push(`rate="${rate}"`);
  const pitch = attrs.pitch?.toLowerCase();
  if (pitch && (PROSODY_PITCHES.has(pitch) || percent.test(pitch) || /^[+-]\d{1,2}st$/.test(pitch)))
    parts.push(`pitch="${pitch}"`);
  const volume = attrs.volume?.toLowerCase();
  if (volume && (PROSODY_VOLUMES.has(volume) || percent.test(volume)))
    parts.push(`volume="${volume}"`);
  return parts.length > 0 ? `<prosody ${parts.join(' ')}>` : null;
}

/** What a plain-text engine should NOT read aloud is replaced by a space (same length). */
function spokenChar(chars: readonly string[], index: number): string {
  const ch = chars[index] ?? '';
  if (PICTOGRAPH.test(ch) && !SPOKEN_SYMBOLS.has(ch)) return ' ';
  if (ch === '*' || ch === '`' || ch === '~' || ch === '|' || ch === '\\') return ' ';
  const prev = chars[index - 1] ?? ' ';
  const next = chars[index + 1] ?? ' ';
  // Markdown emphasis / headings: only when the marker is not inside a word or number.
  if (ch === '_' && !(LETTER_OR_DIGIT.test(prev) && LETTER_OR_DIGIT.test(next))) return ' ';
  if (ch === '#' && !LETTER_OR_DIGIT.test(next)) return ' ';
  return ch;
}

interface OpenTag {
  open: string;
  close: string;
}

class Builder {
  readonly display: string[] = [];
  readonly spoken: string[] = [];
  readonly segments: SpeechSegment[] = [];
  private markup: string[] = [];
  private map: number[] = [];
  private segmentDisplayStart = 0;
  private readonly stack: OpenTag[] = [];
  private sentenceEnded = false;

  constructor(private readonly maxChars: number) {}

  private pushMarkup(text: string, displayIndex: number): void {
    for (const cp of text) {
      this.markup.push(cp);
      this.map.push(displayIndex);
    }
  }

  private segmentHasSpeech(): boolean {
    return this.map.some((index) => index >= 0);
  }

  /** Close the running segment (re-opening the active inline tags in the next one). */
  endSegment(pauseAfterMs: number): void {
    if (!this.segmentHasSpeech()) {
      // Nothing spoken yet: keep collecting, but remember the longest pause requested.
      const last = this.segments[this.segments.length - 1];
      if (last) last.pauseAfterMs = Math.max(last.pauseAfterMs, pauseAfterMs);
      return;
    }
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      this.pushMarkup(this.stack[i]?.close ?? '', -1);
    }
    this.segments.push({
      markup: this.markup.join(''),
      map: Int32Array.from(this.map),
      pauseAfterMs,
    });
    this.markup = [];
    this.map = [];
    this.segmentDisplayStart = this.display.length;
    this.sentenceEnded = false;
    for (const tag of this.stack) this.pushMarkup(tag.open, -1);
  }

  /** Paragraph boundary: a word break in the display text and a longer pause in the audio. */
  paragraph(): void {
    this.space();
    this.endSegment(PARAGRAPH_PAUSE_MS);
  }

  openTag(tag: OpenTag): void {
    this.stack.push(tag);
    this.pushMarkup(tag.open, -1);
  }

  closeTag(closeMarkup: string): void {
    const index = this.stack.map((tag) => tag.close).lastIndexOf(closeMarkup);
    if (index < 0) return; // unbalanced close: ignore
    // Close everything opened after it too, so the markup stays well formed.
    for (let i = this.stack.length - 1; i >= index; i -= 1) {
      this.pushMarkup(this.stack[i]?.close ?? '', -1);
    }
    this.stack.length = index;
  }

  emptyTag(markup: string): void {
    this.pushMarkup(markup, -1);
  }

  private space(): void {
    if (this.display.length === 0 || this.display[this.display.length - 1] === ' ') return;
    this.display.push(' ');
    this.spoken.push(' ');
    this.pushMarkup(' ', -1);
    const length = this.display.length - this.segmentDisplayStart;
    if (this.sentenceEnded && length >= this.maxChars) this.endSegment(SENTENCE_PAUSE_MS);
    else if (length >= this.maxChars * 2) this.endSegment(0);
  }

  /** Append readable text. `alias`, when given, is spoken instead of `text` (SSML `<sub>`). */
  text(raw: string, alias?: string): void {
    const paragraphs = raw.split(/\n[ \t\r]*\n\s*/);
    paragraphs.forEach((paragraph, p) => {
      if (p > 0) this.paragraph();
      const chars = [...paragraph];
      if (alias !== undefined) {
        this.aliased(chars, alias);
        return;
      }
      chars.forEach((ch, index) => {
        if (/\s/.test(ch)) {
          this.space();
          return;
        }
        const said = spokenChar(chars, index);
        const displayIndex = this.display.length;
        this.display.push(ch);
        this.spoken.push(said);
        this.pushMarkup(escapeMarkup(said), said === ' ' ? -1 : displayIndex);
        if (SENTENCE_END.test(ch)) this.sentenceEnded = true;
        else if (LETTER_OR_DIGIT.test(ch)) this.sentenceEnded = false;
      });
    });
  }

  private aliased(chars: readonly string[], alias: string): void {
    const shown = chars.join('').replace(/\s+/g, ' ').trim();
    const said = alias.replace(/\s+/g, ' ').trim();
    if (shown === '' && said === '') return;
    const displayIndex = this.display.length;
    for (const ch of shown === '' ? said : shown) this.display.push(ch);
    for (const ch of said === '' ? shown : said) {
      this.spoken.push(ch);
      this.pushMarkup(escapeMarkup(ch), ch === ' ' ? -1 : displayIndex);
    }
  }

  finish(): void {
    this.endSegment(0);
    const last = this.segments[this.segments.length - 1];
    if (last) last.pauseAfterMs = 0;
  }
}

/** Parse a narration script (plain text with optional basic SSML) for synthesis. */
export function prepareSpeech(input: string, options: PrepareSpeechOptions = {}): PreparedSpeech {
  const source = input.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').normalize('NFC');
  const builder = new Builder(Math.max(80, options.maxSegmentChars ?? DEFAULT_SEGMENT_CHARS));
  let dropDepth = 0;
  let dropTag = '';
  let subAlias: string | null = null;
  let subText = '';
  const emitText = (text: string) => {
    if (dropDepth > 0 || text === '') return;
    if (subAlias !== null) subText += text;
    else builder.text(decodeEntities(text));
  };

  let cursor = 0;
  for (const match of source.matchAll(TAG)) {
    const whole = match[0];
    const at = match.index;
    const name = (match[3] ?? '').toLowerCase();
    const isElement = match[3] !== undefined;
    if (isElement && !KNOWN_TAGS.has(name)) continue; // not markup: stays in the text run
    emitText(source.slice(cursor, at));
    cursor = at + whole.length;
    if (match[1] !== undefined) {
      emitText(match[1]); // CDATA content is literal text
      continue;
    }
    if (!isElement) continue; // comment / processing instruction / doctype
    const closing = match[2] === '/';
    const selfClosing = match[5] === '/' || /\/\s*$/.test(match[4] ?? '');
    const attrs = attributes(match[4] ?? '');

    if (DROP_CONTENT.has(name)) {
      if (closing) {
        if (dropDepth > 0 && name === dropTag) dropDepth -= 1;
      } else if (!selfClosing && (dropDepth === 0 || name === dropTag)) {
        dropTag = name;
        dropDepth += 1;
      }
      continue;
    }
    if (dropDepth > 0) continue;

    if (name === 'sub') {
      if (!closing && !selfClosing && attrs.alias !== undefined) {
        subAlias = decodeEntities(attrs.alias);
        subText = '';
      } else if (closing && subAlias !== null) {
        builder.text(decodeEntities(subText), subAlias);
        subAlias = null;
      }
      continue;
    }
    if (subAlias !== null) continue; // markup inside <sub> is flattened

    if (name === 'break') {
      const time = attrs.time !== undefined ? breakTimeMs(attrs.time) : null;
      const strength = attrs.strength?.toLowerCase();
      if (time !== null) builder.emptyTag(`<break time="${time}ms"/>`);
      else if (strength && BREAK_STRENGTHS.has(strength))
        builder.emptyTag(`<break strength="${strength}"/>`);
      else builder.emptyTag('<break/>');
    } else if (name === 'br') {
      builder.text(' ');
    } else if (name === 's') {
      builder.text(' ');
    } else if (BLOCK_TAGS.has(name)) {
      builder.paragraph();
    } else if (name === 'emphasis') {
      if (closing) builder.closeTag('</emphasis>');
      else if (!selfClosing) {
        const level = attrs.level?.toLowerCase();
        builder.openTag({
          open: level && EMPHASIS_LEVELS.has(level) ? `<emphasis level="${level}">` : '<emphasis>',
          close: '</emphasis>',
        });
      }
    } else if (name === 'prosody') {
      if (closing) builder.closeTag('</prosody>');
      else if (!selfClosing) {
        const open = sanitizeProsody(attrs);
        if (open) builder.openTag({ open, close: '</prosody>' });
      }
    } else if (name === 'say-as') {
      if (closing) builder.closeTag('</say-as>');
      else if (!selfClosing) {
        const mode = SAY_AS[(attrs['interpret-as'] ?? '').toLowerCase()];
        if (mode) builder.openTag({ open: `<say-as interpret-as="${mode}">`, close: '</say-as>' });
      }
    }
    // Every other known tag (speak, voice, audio, mark, b, i…) is dropped; its text stays.
  }
  emitText(source.slice(cursor));
  if (subAlias !== null) builder.text(decodeEntities(subText));
  builder.finish();

  // Trim a trailing space of the display text and derive the tokens.
  const display = builder.display;
  while (display.length > 0 && display[display.length - 1] === ' ') display.pop();
  const tokens: SpeechToken[] = [];
  let start = -1;
  for (let i = 0; i <= display.length; i += 1) {
    const ch = display[i];
    if (ch !== undefined && ch !== ' ') {
      if (start < 0) start = i;
    } else if (start >= 0) {
      tokens.push({ text: display.slice(start, i).join(''), start, end: i });
      start = -1;
    }
  }
  return {
    display: display.join(''),
    spoken: builder.spoken.join('').replace(/\s+/g, ' ').trim(),
    tokens,
    segments: builder.segments,
  };
}

/**
 * Split plain text for services with a per-request size limit: pieces of at most `maxChars`
 * characters, cut at paragraph or sentence ends when possible, otherwise at clause marks or
 * spaces. Joining the pieces with a space gives back the (whitespace-normalised) text.
 */
export function splitPlainText(text: string, maxChars: number): string[] {
  const limit = Math.max(20, Math.floor(maxChars));
  const normalised = text.replace(/\s+/g, ' ').trim();
  if (normalised === '') return [];
  const pieces: string[] = [];
  let rest = normalised;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = -1;
    for (const pattern of [/[.!?…]["')\]»]*\s/g, /[,;:—–]\s/g, /\s/g]) {
      let lastEnd = -1;
      for (const match of window.matchAll(pattern)) lastEnd = match.index + match[0].length;
      // Avoid tiny leading pieces: accept a boundary only in the second half of the window.
      if (lastEnd >= limit * 0.4 || (pattern.source === '\\s' && lastEnd > 0)) {
        cut = lastEnd;
        break;
      }
    }
    if (cut <= 0) cut = limit; // one unbroken run longer than the limit
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') pieces.push(rest);
  return pieces.filter((piece) => piece !== '');
}
