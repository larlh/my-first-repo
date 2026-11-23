import { describe, expect, it } from 'vitest';
import { formatBytes, formatClock } from '@/lib/format';
import {
  assetFacts,
  dimensionsOf,
  downloadHref,
  downloadName,
  extensionOfUrl,
  usesFromConflict,
} from './describe';
import { storageUsage } from './useUploadRules';
import { waveformOf } from '../components/AssetThumb';

const format = { bytes: (value: number) => formatBytes(value, 'es'), clock: formatClock };
const URL = 'http://localhost:4000/api/files/ws/ws_1/assets/ast_1/file.PNG?exp=1999999999&sig=abc';

describe('asset descriptions', () => {
  it('summarises size plus dimensions or duration', () => {
    expect(
      assetFacts(
        { kind: 'image', sizeBytes: 2_516_582, width: 1920, height: 1080, durationMs: null },
        format,
      ),
    ).toBe('2,4 MB · 1920 × 1080');
    expect(
      assetFacts(
        { kind: 'audio', sizeBytes: 1024, width: null, height: null, durationMs: 65_000 },
        format,
      ),
    ).toBe('1 kB · 1:05');
    expect(dimensionsOf({ width: null, height: 10 })).toBeNull();
  });

  it('builds a download URL that the API serves as an attachment with a sane name', () => {
    expect(extensionOfUrl(URL)).toBe('png');
    expect(downloadName({ name: 'Logo: final/v2', url: URL })).toBe('Logo final v2.png');
    expect(downloadName({ name: 'foto.png', url: URL })).toBe('foto.png');
    expect(downloadHref({ name: 'Mi logo', url: URL })).toBe(`${URL}&download=Mi%20logo.png`);
  });

  it('reads who still uses an asset from a delete conflict', () => {
    expect(
      usesFromConflict({
        usedBy: [{ type: 'avatar', id: 'avt_1' }, { type: 'video', id: 'vid_1' }, 'garbage'],
      }),
    ).toEqual([{ type: 'avatar', id: 'avt_1' }]);
    expect(usesFromConflict(undefined)).toEqual([]);
  });
});

describe('storage usage', () => {
  it('grades how full the workspace storage is', () => {
    expect(storageUsage(0, 1000)).toMatchObject({ leftBytes: 1000, percent: 0, level: 'ok' });
    expect(storageUsage(850, 1000)).toMatchObject({ leftBytes: 150, percent: 85, level: 'high' });
    expect(storageUsage(1200, 1000)).toMatchObject({ leftBytes: 0, percent: 100, level: 'full' });
  });
});

describe('waveformOf', () => {
  it('is stable per id, different between ids and stays inside the frame', () => {
    const a = waveformOf('ast_0001abcdefgh1234');
    expect(a).toEqual(waveformOf('ast_0001abcdefgh1234'));
    expect(a).not.toEqual(waveformOf('ast_0002abcdefgh1234'));
    expect(a).toHaveLength(28);
    expect(Math.min(...a)).toBeGreaterThanOrEqual(18);
    expect(Math.max(...a)).toBeLessThanOrEqual(100);
  });
});
