import { createRequire } from 'node:module';
import path from 'node:path';
import { GlobalFonts } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { FONT_FAMILY_NAMES } from '@parlante/shared';
import { canvasFont } from '../index';
import { createNodeCanvas, registerNodeFonts } from './index';

// Its own file on purpose: it registers a fake "Inter" in Skia's global font registry, which
// must not leak into the other suites (vitest isolates each test file).

const require = createRequire(import.meta.url);

describe('fonts installed on the machine', () => {
  it('cannot replace a bundled family that shares their name', () => {
    registerNodeFonts();
    const { ctx } = createNodeCanvas(10, 10);
    const width = (family: string) => {
      ctx.font = canvasFont(family, 40, 500);
      return ctx.measureText('Escribe el guion, elige presentador').width;
    };
    const before = FONT_FAMILY_NAMES.map((family) => width(family));

    // What a host with Ubuntu's `fonts-inter` (or any same-named font) looks like to Skia: a
    // different file answering to "Inter", registered after ours. Skia prefers the last one,
    // so with the family names used as-is the export silently switched to the host's font.
    const impostor = path.join(
      path.dirname(require.resolve('@fontsource/poppins/package.json')),
      'files',
      'poppins-latin-500-normal.woff2',
    );
    for (const family of FONT_FAMILY_NAMES) {
      expect(GlobalFonts.registerFromPath(impostor, family)).toBeTruthy();
    }

    expect(FONT_FAMILY_NAMES.map((family) => width(family))).toEqual(before);
  });
});
