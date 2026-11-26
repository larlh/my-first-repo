import type { SubtitleCue, SubtitleStyle, WordCue } from '@parlante/shared';
import { cachedRaster, onClearRenderCaches } from './cache';
import { contrastColor, fadeColor } from './color';
import { baselineOffset, canvasFont } from './fonts';
import { SUBTITLE_MINIMAL_SCALE, SUBTITLE_SAFE_WIDTH } from './subtitles';
import type { Ctx2D } from './types';

/** A cue to paint: text + times, optionally with its words (karaoke highlighting). */
export type DrawableCue = SubtitleCue & { words?: readonly WordCue[] };

/* -------------------------------------------------------------------------------------------
 * Burned-in subtitles. Geometry (all relative to the frame, so 720p and 1080p match):
 *  - text never leaves the central 90 % of the width (`SUBTITLE_SAFE_WIDTH`), box included
 *  - lines break by measured width AND by `maxCharsPerLine`; two-line cues are balanced
 *  - at most `maxLines` lines are shown at once: a longer cue is split into pages that follow
 *    its words in time (nothing is ever cut off or shrunk below legibility)
 *  - `margin` is the distance from the frame edge to the subtitle block (box edge for the
 *    boxed presets)
 * ----------------------------------------------------------------------------------------- */

/** Line height of subtitles in em. */
const LINE_HEIGHT = 1.3;
/** Box padding of the boxed presets, in em. */
const BOX_PAD_X = 0.55;
const BOX_PAD_Y = 0.26;
const BOX_RADIUS = 0.32;
/** Outline of the `classic` preset: visible thickness in em. */
const CLASSIC_OUTLINE = 0.085;
/** A single word wider than the safe area shrinks the text, but never below this factor. */
const MIN_SHRINK = 0.5;

interface Token {
  text: string;
  startMs: number;
}

interface PlacedToken {
  /** Index into the cue's tokens. */
  index: number;
  text: string;
  /** Offset from the line start. */
  x: number;
}

interface Line {
  tokens: PlacedToken[];
  text: string;
  width: number;
}

interface Layout {
  key: string;
  font: string;
  sizePx: number;
  lineHeightPx: number;
  /** Lines grouped in pages of at most `maxLines`. */
  pages: Line[][];
  /** Index of the first token of each page. */
  pageStart: number[];
}

function cueTokens(cue: DrawableCue, uppercase: boolean): Token[] {
  const fix = (text: string) => (uppercase ? text.toUpperCase() : text);
  if (cue.words && cue.words.length > 0) {
    const tokens: Token[] = [];
    for (const word of cue.words) {
      const text = word.text.trim();
      if (text !== '') tokens.push({ text: fix(text), startMs: word.tMs });
    }
    if (tokens.length > 0) return tokens;
  }
  // No word timings (e.g. translated segments): spread the words over the cue by length.
  const parts = cue.text.split(/\s+/).filter((part) => part !== '');
  const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
  const duration = Math.max(0, cue.endMs - cue.startMs);
  let consumed = 0;
  return parts.map((part) => {
    const startMs = cue.startMs + (total > 0 ? (consumed / total) * duration : 0);
    consumed += part.length + 1;
    return { text: fix(part), startMs };
  });
}

function breakLines(
  texts: readonly string[],
  maxWidth: number,
  maxChars: number,
  measure: (text: string) => number,
): number[][] {
  // Greedy: indices of the tokens of each line.
  const lines: number[][] = [];
  let current: number[] = [];
  let currentText = '';
  texts.forEach((text, index) => {
    const candidate = currentText === '' ? text : `${currentText} ${text}`;
    if (current.length > 0 && (candidate.length > maxChars || measure(candidate) > maxWidth)) {
      lines.push(current);
      current = [index];
      currentText = text;
    } else {
      current.push(index);
      currentText = candidate;
    }
  });
  if (current.length > 0) lines.push(current);
  if (lines.length !== 2) return lines;
  // Two lines: pick the break that makes them most alike instead of "full line + leftover".
  const join = (from: number, to: number) => texts.slice(from, to).join(' ');
  let best: { split: number; score: number } | null = null;
  for (let split = 1; split < texts.length; split += 1) {
    const a = join(0, split);
    const b = join(split, texts.length);
    if (a.length > maxChars || b.length > maxChars) continue;
    const wa = measure(a);
    const wb = measure(b);
    if (wa > maxWidth || wb > maxWidth) continue;
    const score = Math.max(wa, wb);
    if (!best || score < best.score - 0.5) best = { split, score };
  }
  if (!best) return lines;
  const first: number[] = [];
  const second: number[] = [];
  texts.forEach((_, index) => (index < best.split ? first : second).push(index));
  return [first, second];
}

const layouts = new Map<string, Layout>();
const MAX_LAYOUTS = 200;

/** Split `text` into pieces no wider than `maxWidth` (at least one character each). */
function splitWord(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  const pieces: string[] = [];
  let chars = Array.from(text);
  while (chars.length > 0) {
    let lo = 1;
    let hi = chars.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (measure(chars.slice(0, mid).join('')) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    pieces.push(chars.slice(0, lo).join(''));
    chars = chars.slice(lo);
  }
  return pieces;
}

function layoutCue(
  ctx: Ctx2D,
  tokens: readonly Token[],
  style: SubtitleStyle,
  width: number,
  height: number,
): Layout {
  const key = `${width}x${height}|${JSON.stringify(style)}|${tokens.map((t) => t.text).join(' ')}`;
  const cached = layouts.get(key);
  if (cached) return cached;

  const boxed = style.preset === 'boxed' || style.preset === 'karaoke';
  let sizePx = style.fontSize * height * (style.preset === 'minimal' ? SUBTITLE_MINIMAL_SCALE : 1);
  const available = (size: number) =>
    Math.max(1, width * SUBTITLE_SAFE_WIDTH - (boxed ? size * BOX_PAD_X * 2 : size * 0.2));

  ctx.save();
  ctx.font = canvasFont(style.fontFamily, sizePx, style.fontWeight);
  const measure = (text: string) => ctx.measureText(text).width;
  let widest = 0;
  for (const token of tokens) widest = Math.max(widest, measure(token.text));
  if (widest > available(sizePx)) {
    // A word wider than the safe area: shrink the text (down to a legible minimum)…
    sizePx *= Math.max(MIN_SHRINK, available(sizePx) / widest);
    ctx.font = canvasFont(style.fontFamily, sizePx, style.fontWeight);
  }
  const font = canvasFont(style.fontFamily, sizePx, style.fontWeight);
  const maxWidth = available(sizePx);
  // …and split what still does not fit. Pieces keep the index of their word (`owner`).
  const texts: string[] = [];
  const owner: number[] = [];
  tokens.forEach((token, index) => {
    const pieces =
      measure(token.text) > maxWidth ? splitWord(token.text, maxWidth, measure) : [token.text];
    for (const piece of pieces) {
      texts.push(piece);
      owner.push(index);
    }
  });
  const lineIndices = breakLines(texts, maxWidth, style.maxCharsPerLine, measure);
  const lines: Line[] = lineIndices.map((indices) => {
    const placed: PlacedToken[] = [];
    let prefix = '';
    for (const index of indices) {
      const text = texts[index] ?? '';
      placed.push({ index: owner[index] ?? 0, text, x: prefix === '' ? 0 : measure(`${prefix} `) });
      prefix = prefix === '' ? text : `${prefix} ${text}`;
    }
    return { tokens: placed, text: prefix, width: measure(prefix) };
  });
  ctx.restore();

  const perPage = Math.max(1, style.maxLines);
  const pages: Line[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  const layout: Layout = {
    key,
    font,
    sizePx,
    lineHeightPx: sizePx * LINE_HEIGHT,
    pages,
    pageStart: pages.map((page) => page[0]?.tokens[0]?.index ?? 0),
  };
  if (layouts.size >= MAX_LAYOUTS) {
    const oldest = layouts.keys().next().value;
    if (oldest !== undefined) layouts.delete(oldest);
  }
  layouts.set(key, layout);
  return layout;
}

/** Forget memoised subtitle layouts (`clearRenderCaches` does it too). */
export function clearSubtitleLayoutCache(): void {
  layouts.clear();
}
onClearRenderCaches(clearSubtitleLayoutCache);

/** Index of the last token that has started at `tMs` (0 before the first one). */
function activeToken(tokens: readonly Token[], tMs: number): number {
  let active = 0;
  tokens.forEach((token, index) => {
    if (token.startMs <= tMs) active = index;
  });
  return active;
}

function paintPage(
  ctx: Ctx2D,
  layout: Layout,
  page: readonly Line[],
  style: SubtitleStyle,
  blockX: number,
  blockY: number,
  blockW: number,
  highlight: number,
): void {
  const { sizePx, lineHeightPx } = layout;
  const boxed = style.preset === 'boxed' || style.preset === 'karaoke';
  const padX = boxed ? sizePx * BOX_PAD_X : 0;
  const padY = boxed ? sizePx * BOX_PAD_Y : 0;
  ctx.save();
  if (boxed) {
    ctx.fillStyle = style.backgroundColor;
    ctx.beginPath();
    ctx.roundRect(
      blockX,
      blockY,
      blockW,
      page.length * lineHeightPx + padY * 2,
      sizePx * BOX_RADIUS,
    );
    ctx.fill();
  }
  ctx.font = layout.font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  // Whole-pixel line origins, like text layers (see ./text).
  const firstBaseline = blockY + padY + baselineOffset(style.fontFamily, sizePx, lineHeightPx);
  const baselineOf = (index: number) => Math.round(firstBaseline + index * lineHeightPx);
  const lineX = (line: Line) => Math.round(blockX + padX + (blockW - padX * 2 - line.width) / 2);

  if (style.preset === 'classic') {
    // Dark outline (drawn first, the fill covers its inner half) with a soft drop shadow.
    const outline = contrastColor(style.color);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = outline;
    ctx.lineWidth = sizePx * CLASSIC_OUTLINE * 2;
    ctx.shadowColor = fadeColor(outline, 0.55);
    ctx.shadowBlur = sizePx * 0.14;
    ctx.shadowOffsetY = sizePx * 0.05;
    page.forEach((line, i) => ctx.strokeText(line.text, lineX(line), baselineOf(i)));
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  } else if (style.preset === 'minimal') {
    ctx.shadowColor = fadeColor(contrastColor(style.color), 0.75);
    ctx.shadowBlur = sizePx * 0.22;
    ctx.shadowOffsetY = sizePx * 0.05;
  }

  page.forEach((line, i) => {
    const y = baselineOf(i);
    if (style.preset === 'karaoke') {
      for (const token of line.tokens) {
        ctx.fillStyle = token.index === highlight ? style.highlightColor : style.color;
        ctx.fillText(token.text, lineX(line) + token.x, y);
      }
    } else {
      ctx.fillStyle = style.color;
      ctx.fillText(line.text, lineX(line), y);
    }
  });
  ctx.restore();
}

/**
 * Paint ONE subtitle cue on a frame of `width × height` pixels — THE burned-in subtitle look.
 * `renderFrame` calls it for Studio videos; the translation job calls it for
 * `options.burnSubtitles` (on a transparent canvas per cue, overlaid with ffmpeg), so
 * translated videos get the same typography, box and position as rendered ones instead of an
 * ffmpeg `subtitles` filter look. `tMs` is the time on the cue's own clock (same clock as
 * `cue.startMs`), used by presets that highlight the word being spoken and to page through
 * cues longer than `maxLines` lines.
 *
 * Presets: `classic` (outlined text), `boxed` (text on a rounded box), `karaoke` (boxed, the
 * word being spoken in `highlightColor`; without `cue.words` the word times are estimated
 * from the cue length), `minimal` (smaller text with a soft shadow).
 */
export function drawSubtitleCue(
  ctx: Ctx2D,
  cue: DrawableCue,
  style: SubtitleStyle,
  width: number,
  height: number,
  tMs: number = cue.startMs,
): void {
  if (cue.text.trim() === '' && !cue.words?.length) return;
  const tokens = cueTokens(cue, style.uppercase);
  if (tokens.length === 0) return;
  const layout = layoutCue(ctx, tokens, style, width, height);
  const active = activeToken(tokens, tMs);
  let pageIndex = 0;
  layout.pageStart.forEach((start, index) => {
    if (start <= active) pageIndex = index;
  });
  const page = layout.pages[pageIndex];
  if (!page || page.length === 0) return;

  const { sizePx, lineHeightPx } = layout;
  const boxed = style.preset === 'boxed' || style.preset === 'karaoke';
  const padX = boxed ? sizePx * BOX_PAD_X : 0;
  const padY = boxed ? sizePx * BOX_PAD_Y : 0;
  const blockW = Math.max(...page.map((line) => line.width)) + padX * 2;
  const blockH = page.length * lineHeightPx + padY * 2;
  const blockX = (width - blockW) / 2;
  const marginPx = style.margin * height;
  const blockY =
    style.position === 'top'
      ? marginPx
      : style.position === 'middle'
        ? (height - blockH) / 2
        : height - marginPx - blockH;

  const spoken = (tokens[active]?.startMs ?? Infinity) <= tMs;
  const highlight = style.preset === 'karaoke' && spoken ? active : -1;
  // Room for the outline, the shadow and glyph overshoot around the block.
  const slack = sizePx * 0.6 + 2;
  const raster = cachedRaster(
    `subtitle|${layout.key}|${pageIndex}|${highlight}`,
    { x: blockX - slack, y: blockY - slack, w: blockW + slack * 2, h: blockH + slack * 2 },
    (c) => paintPage(c, layout, page, style, blockX, blockY, blockW, highlight),
  );
  if (raster) ctx.drawImage(raster.canvas, raster.x, raster.y);
  else paintPage(ctx, layout, page, style, blockX, blockY, blockW, highlight);
}
