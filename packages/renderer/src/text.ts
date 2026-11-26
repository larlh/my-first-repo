import type { TextStyle } from '@parlante/shared';
import { createCanvas, onClearRenderCaches } from './cache';
import { baselineOffset, canvasFont } from './fonts';
import type { Ctx2D } from './types';

/* -------------------------------------------------------------------------------------------
 * Text layout and painting shared by text layers, subtitles and the watermark.
 *
 * Everything is measured with the canvas itself (same fonts in browser and Node) and laid out
 * by this code — never by platform text features that differ between engines:
 *  - line breaking: greedy by measured width, long words are split
 *  - baselines: from the bundled font metrics table (`baselineOffset`), not `textBaseline`
 *  - letter spacing: glyphs are positioned one by one (`ctx.letterSpacing` is not universal)
 * ----------------------------------------------------------------------------------------- */

export type Measure = (text: string) => number;

/** Number of user-perceived characters (code points) in a string. */
function codePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * Measuring function for the font currently set on `ctx`, with letter spacing added between
 * characters (not after the last one, so centred lines stay centred).
 */
export function measurer(ctx: Ctx2D, letterSpacingPx = 0): Measure {
  if (letterSpacingPx === 0) return (text) => ctx.measureText(text).width;
  return (text) => {
    const count = codePoints(text).length;
    return ctx.measureText(text).width + letterSpacingPx * Math.max(0, count - 1);
  };
}

/** Longest prefix of `word` (at least one character) that fits in `maxWidth`. */
function splitToFit(word: string, maxWidth: number, measure: Measure): [string, string] {
  const chars = codePoints(word);
  let lo = 1;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(chars.slice(0, mid).join('')) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return [chars.slice(0, lo).join(''), chars.slice(lo).join('')];
}

/**
 * Break `text` into lines no wider than `maxWidth`. Explicit line breaks are kept (an empty
 * paragraph is an empty line); runs of spaces collapse; a word wider than the line is split.
 */
export function wrapText(text: string, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/[ \t\u00a0]+/).filter((word) => word !== '');
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line !== '') lines.push(line);
      let rest = word;
      while (rest !== '' && measure(rest) > maxWidth) {
        const [head, tail] = splitToFit(rest, maxWidth, measure);
        if (tail === '') break; // a single character wider than the line: let it overflow
        lines.push(head);
        rest = tail;
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/** One glyph of a letter-spaced line: the character and its x offset from the line start. */
export interface PlacedGlyph {
  char: string;
  x: number;
}

/** Positions of every character of `line` when letter spacing is applied (kerning kept). */
export function placeGlyphs(ctx: Ctx2D, line: string, letterSpacingPx: number): PlacedGlyph[] {
  const chars = codePoints(line);
  const glyphs: PlacedGlyph[] = [];
  let prefix = '';
  chars.forEach((char, index) => {
    glyphs.push({ char, x: ctx.measureText(prefix).width + index * letterSpacingPx });
    prefix += char;
  });
  return glyphs;
}

/* ---------- text layer blocks ---------- */

export interface TextLine {
  text: string;
  width: number;
  /** Left edge and alphabetic baseline, relative to the layer box origin. */
  x: number;
  baseline: number;
  /** Set when letter spacing is not zero. */
  glyphs: PlacedGlyph[] | null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A text layer laid out inside its box. Coordinates are relative to the box origin. */
export interface TextBlock {
  /** Cache key of this layout (text, style and box size). */
  key: string;
  font: string;
  lines: TextLine[];
  /** Background pill, when the style has one. */
  background: (Rect & { radius: number }) | null;
  /** Everything the block may paint (glyphs, pill, outline, shadow). */
  bounds: Rect;
}

const blocks = new Map<string, TextBlock>();
const MAX_BLOCKS = 400;

/**
 * Lay out a text layer: wrap inside the box width, align horizontally and vertically. Text
 * taller than the box overflows it (nothing is shrunk or cut), like in the Studio editor.
 * Memoised: the same text, style and box size are measured once.
 */
export function layoutTextBlock(
  ctx: Ctx2D,
  rawText: string,
  style: TextStyle,
  boxW: number,
  boxH: number,
  canvasHeight: number,
): TextBlock {
  const key = `${canvasHeight}|${boxW}|${boxH}|${JSON.stringify(style)}|${rawText}`;
  const cached = blocks.get(key);
  if (cached) return cached;

  const sizePx = style.fontSize * canvasHeight;
  const lineHeightPx = sizePx * style.lineHeight;
  const letterSpacingPx = style.letterSpacing * sizePx;
  const font = canvasFont(style.fontFamily, sizePx, style.fontWeight, style.italic);
  const text = style.uppercase ? rawText.toUpperCase() : rawText;

  ctx.save();
  ctx.font = font;
  const measure = measurer(ctx, letterSpacingPx);
  const wrapped = text.trim() === '' ? [] : wrapText(text, Math.max(1, boxW), measure);
  const blockH = wrapped.length * lineHeightPx;
  const top =
    style.verticalAlign === 'top'
      ? 0
      : style.verticalAlign === 'bottom'
        ? boxH - blockH
        : (boxH - blockH) / 2;
  const firstBaseline = top + baselineOffset(style.fontFamily, sizePx, lineHeightPx);
  const lines: TextLine[] = wrapped.map((line, index) => {
    const width = measure(line);
    const x =
      style.align === 'left' ? 0 : style.align === 'right' ? boxW - width : (boxW - width) / 2;
    return {
      text: line,
      width,
      x,
      baseline: firstBaseline + index * lineHeightPx,
      glyphs: letterSpacingPx !== 0 ? placeGlyphs(ctx, line, letterSpacingPx) : null,
    };
  });
  ctx.restore();

  let minX = Infinity;
  let maxX = -Infinity;
  for (const line of lines) {
    if (line.text === '') continue;
    minX = Math.min(minX, line.x);
    maxX = Math.max(maxX, line.x + line.width);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 0;
  }

  let background: TextBlock['background'] = null;
  if (style.background && lines.length > 0) {
    const pad = style.background.padding * canvasHeight;
    const h = blockH + pad * 2;
    const w = maxX - minX + pad * 2;
    background = {
      x: minX - pad,
      y: top - pad,
      w,
      h,
      radius: Math.min(style.background.radius * canvasHeight, w / 2, h / 2),
    };
  }

  // Generous margin for what glyphs paint outside their advance box (italics, accents,
  // descenders with tight line heights) plus the outline and the shadow.
  const strokePx = style.stroke ? style.stroke.width * canvasHeight : 0;
  const shadow = style.shadow;
  const shadowPx = shadow
    ? Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) * canvasHeight +
      shadow.blur * canvasHeight * 2
    : 0;
  const margin = sizePx * 0.35 + strokePx + shadowPx + 2;
  const inkX = background ? Math.min(minX, background.x) : minX;
  const inkY = background ? Math.min(top, background.y) : top;
  const inkR = background ? Math.max(maxX, background.x + background.w) : maxX;
  const inkB = background ? Math.max(top + blockH, background.y + background.h) : top + blockH;
  const block: TextBlock = {
    key,
    font,
    lines,
    background,
    bounds: {
      x: inkX - margin,
      y: inkY - margin,
      w: inkR - inkX + margin * 2,
      h: inkB - inkY + margin * 2,
    },
  };
  if (blocks.size >= MAX_BLOCKS) {
    const oldest = blocks.keys().next().value;
    if (oldest !== undefined) blocks.delete(oldest);
  }
  blocks.set(key, block);
  return block;
}

/** Forget memoised layouts (`clearRenderCaches` does it too). */
export function clearTextLayoutCache(): void {
  blocks.clear();
}
onClearRenderCaches(clearTextLayoutCache);

function drawLines(
  ctx: Ctx2D,
  block: TextBlock,
  originX: number,
  originY: number,
  mode: 'fill' | 'stroke',
): void {
  for (const line of block.lines) {
    if (line.text === '') continue;
    // Lines start on whole pixels: text rasterisers disagree on how they treat fractional
    // origins (some snap the baseline, some do not), whole ones are drawn alike everywhere.
    const y = Math.round(originY + line.baseline);
    const x = Math.round(originX + line.x);
    if (line.glyphs) {
      for (const glyph of line.glyphs) {
        if (mode === 'fill') ctx.fillText(glyph.char, x + glyph.x, y);
        else ctx.strokeText(glyph.char, x + glyph.x, y);
      }
    } else if (mode === 'fill') {
      ctx.fillText(line.text, x, y);
    } else {
      ctx.strokeText(line.text, x, y);
    }
  }
}

function drawGlyphs(
  ctx: Ctx2D,
  block: TextBlock,
  style: TextStyle,
  originX: number,
  originY: number,
  canvasHeight: number,
): void {
  ctx.font = block.font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (style.stroke && style.stroke.width > 0) {
    // The outline is centred on the glyph edge and the fill covers its inner half, so the
    // visible outline is `stroke.width` thick.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = style.stroke.color;
    ctx.lineWidth = style.stroke.width * canvasHeight * 2;
    drawLines(ctx, block, originX, originY, 'stroke');
  }
  ctx.fillStyle = style.color;
  drawLines(ctx, block, originX, originY, 'fill');
}

function applyShadow(ctx: Ctx2D, style: TextStyle, canvasHeight: number): void {
  if (!style.shadow) return;
  ctx.shadowColor = style.shadow.color;
  ctx.shadowBlur = style.shadow.blur * canvasHeight;
  ctx.shadowOffsetX = style.shadow.offsetX * canvasHeight;
  ctx.shadowOffsetY = style.shadow.offsetY * canvasHeight;
}

/**
 * Paint a laid-out block with the box origin at (`originX`, `originY`): pill, shadow, outline
 * and fill. The shadow is cast once by the whole lettering (outline + fill together).
 */
export function paintTextBlock(
  ctx: Ctx2D,
  block: TextBlock,
  style: TextStyle,
  originX: number,
  originY: number,
  canvasHeight: number,
): void {
  if (block.lines.length === 0) return;
  ctx.save();
  if (block.background && style.background) {
    const bg = block.background;
    ctx.fillStyle = style.background.color;
    ctx.beginPath();
    ctx.roundRect(originX + bg.x, originY + bg.y, bg.w, bg.h, bg.radius);
    ctx.fill();
  }
  const outlined = style.stroke !== null && style.stroke.width > 0;
  if (style.shadow && outlined) {
    // Outline and fill must cast ONE shadow: draw them on a temporary canvas and let that
    // image cast it. Without off-screen canvases each pass casts its own (slightly denser).
    const temp = createCanvas(block.bounds.w, block.bounds.h);
    if (temp) {
      const snapX = Math.floor(originX + block.bounds.x);
      const snapY = Math.floor(originY + block.bounds.y);
      drawGlyphs(temp.ctx, block, style, originX - snapX, originY - snapY, canvasHeight);
      applyShadow(ctx, style, canvasHeight);
      ctx.drawImage(temp.canvas, snapX, snapY);
      ctx.restore();
      return;
    }
  }
  applyShadow(ctx, style, canvasHeight);
  drawGlyphs(ctx, block, style, originX, originY, canvasHeight);
  ctx.restore();
}
