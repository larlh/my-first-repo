import type { SubtitleCue, SubtitleStyle, WordCue } from '@parlante/shared';
import { canvasFont } from './fonts';
import type { Ctx2D } from './types';

/** A cue to paint: text + times, optionally with its words (karaoke highlighting). */
export type DrawableCue = SubtitleCue & { words?: readonly WordCue[] };

/**
 * Paint ONE subtitle cue on a frame of `width × height` pixels — THE burned-in subtitle look.
 * `renderFrame` calls it for Studio videos; the translation job calls it for
 * `options.burnSubtitles` (on a transparent canvas per cue, overlaid with ffmpeg), so
 * translated videos get the same typography, box and position as rendered ones instead of an
 * ffmpeg `subtitles` filter look. `tMs` is the time on the cue's own clock (same clock as
 * `cue.startMs`), used by presets that highlight the word being spoken.
 *
 * BASELINE drawing by the architect (single boxed line). Owner: renderer-core, who implements
 * the four presets, line wrapping (`maxCharsPerLine` / `maxLines`) and karaoke — keeping this
 * signature.
 */
export function drawSubtitleCue(
  ctx: Ctx2D,
  cue: DrawableCue,
  style: SubtitleStyle,
  width: number,
  height: number,
  _tMs: number = cue.startMs,
): void {
  const text = style.uppercase ? cue.text.toUpperCase() : cue.text;
  if (text.trim() === '') return;
  const sizePx = style.fontSize * height;
  ctx.save();
  ctx.font = canvasFont(style.fontFamily, sizePx, style.fontWeight);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const textWidth = Math.min(ctx.measureText(text).width, width * 0.9);
  const padding = sizePx * 0.45;
  const y =
    style.position === 'top'
      ? style.margin * height + sizePx / 2
      : style.position === 'middle'
        ? height / 2
        : height - style.margin * height - sizePx / 2;
  ctx.fillStyle = style.backgroundColor;
  ctx.beginPath();
  ctx.roundRect(
    width / 2 - textWidth / 2 - padding,
    y - sizePx / 2 - padding / 2,
    textWidth + padding * 2,
    sizePx + padding,
    sizePx * 0.25,
  );
  ctx.fill();
  ctx.fillStyle = style.color;
  ctx.fillText(text, width / 2, y, width * 0.9);
  ctx.restore();
}
