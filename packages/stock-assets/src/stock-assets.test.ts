import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { StockAssetMetaSchema, StockPhotorealAvatarMetaSchema, api } from '@parlante/shared';
import { BACKGROUND_PAINTERS, renderBackground } from './generators/backgrounds';
import { AAC_FRAME, decodeToPcm } from './generators/music/encode';
import { loudnessLufs } from './generators/music/synth';
import { MUSIC_TRACKS, TARGET_LUFS, renderTrack } from './generators/music/tracks';
import {
  STOCK_ASSETS,
  STOCK_BACKGROUND_IDS,
  STOCK_BACKGROUND_SIZE,
  STOCK_MUSIC_IDS,
  STOCK_MUSIC_LUFS,
  STOCK_MUSIC_SAMPLE_RATE,
  getStockAssetDetails,
  getStockAssetMeta,
  isStockAssetId,
  listStockAssets,
  listStockPhotorealAvatars,
} from './index';
import {
  STOCK_ASSETS_DIR,
  getStockAssetData,
  getStockPhotorealAvatarFile,
  readStockManifest,
  renderStockBackground,
  stockAssetFilePath,
  stockMusicLoop,
  stockPhotorealAvatarFiles,
} from './node/index';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const isJpeg = (bytes: Uint8Array): boolean =>
  bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

describe('stock catalogue', () => {
  it('has valid, unique, bilingual metadata with ids the API route accepts', () => {
    const assets = listStockAssets();
    expect(new Set(assets.map((a) => a.id)).size).toBe(assets.length);
    const routeId = api.assets.stockFile.params;
    for (const asset of assets) {
      expect(StockAssetMetaSchema.parse(asset)).toEqual(asset);
      expect(routeId.safeParse({ stockId: asset.id }).success, asset.id).toBe(true);
      expect(isStockAssetId(asset.id)).toBe(true);
      expect(asset.name.length, asset.id).toBeGreaterThan(0);
      expect(asset.en?.name?.length ?? 0, asset.id).toBeGreaterThan(0);
      expect(asset.tags.length, asset.id).toBeGreaterThanOrEqual(3);
      expect(asset.en?.tags?.length, asset.id).toBe(asset.tags.length);
    }
    expect(getStockAssetMeta('nope')).toBeNull();
    expect(getStockAssetDetails('nope')).toBeNull();
    expect(isStockAssetId('nope')).toBe(false);
    // Callers get copies: mutating one never changes the catalogue.
    const copy = getStockAssetMeta('bg-aurora');
    copy?.tags.push('mutated');
    expect(getStockAssetMeta('bg-aurora')?.tags).not.toContain('mutated');
  });

  it('offers at least 12 backgrounds of three kinds and 6 music tracks', () => {
    const backgrounds = STOCK_ASSETS.filter((a) => a.category === 'background');
    const music = STOCK_ASSETS.filter((a) => a.category === 'music');
    expect(backgrounds.map((a) => a.id)).toEqual([...STOCK_BACKGROUND_IDS]);
    expect(music.map((a) => a.id)).toEqual([...STOCK_MUSIC_IDS]);
    expect(backgrounds.length).toBeGreaterThanOrEqual(12);
    expect(music.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(BACKGROUND_PAINTERS).sort()).toEqual([...STOCK_BACKGROUND_IDS].sort());
    expect(MUSIC_TRACKS.map((t) => t.id)).toEqual([...STOCK_MUSIC_IDS]);
    const groups = new Set<string>();
    const tones = new Set<string>();
    for (const id of STOCK_BACKGROUND_IDS) {
      const meta = getStockAssetMeta(id);
      const details = getStockAssetDetails(id);
      expect(meta).toMatchObject({
        kind: 'image',
        mimeType: 'image/jpeg',
        width: STOCK_BACKGROUND_SIZE,
        height: STOCK_BACKGROUND_SIZE,
        durationMs: null,
      });
      expect(details).toMatchObject({ file: `backgrounds/${id}.jpg`, loop: false, bpm: null });
      groups.add(details?.group ?? '');
      tones.add(details?.tone ?? '');
    }
    expect([...groups].sort()).toEqual(['gradient', 'pattern', 'set']);
    expect([...tones].sort()).toEqual(['dark', 'light', 'vivid']);
    for (const id of STOCK_MUSIC_IDS) {
      const meta = getStockAssetMeta(id);
      const details = getStockAssetDetails(id);
      expect(meta).toMatchObject({ kind: 'audio', mimeType: 'audio/mp4', width: null });
      expect(meta?.durationMs, id).toBeGreaterThanOrEqual(30_000);
      expect(meta?.durationMs, id).toBeLessThanOrEqual(60_000);
      expect(details).toMatchObject({ file: `music/${id}.m4a`, loop: true, tone: null });
      const loop = stockMusicLoop(id);
      expect(loop.samples % AAC_FRAME, id).toBe(0);
      expect(Math.round((loop.samples / STOCK_MUSIC_SAMPLE_RATE) * 1000)).toBe(meta?.durationMs);
      expect(loop.aloopFilter).toBe(`aloop=loop=-1:size=${loop.samples}`);
      expect(loop.path).toBe(stockAssetFilePath(id));
    }
    expect(() => stockMusicLoop('bg-aurora')).toThrowError(/not a music track/);
    expect(STOCK_MUSIC_LUFS).toBe(TARGET_LUFS);
  });
});

describe('committed stock files', () => {
  it('match the catalogue and the manifest exactly (no missing, stale or stray file)', async () => {
    const manifest = await readStockManifest();
    expect(manifest.version).toBe(1);
    expect(manifest.assets.map((entry) => entry.id)).toEqual(STOCK_ASSETS.map((a) => a.id));
    let total = 0;
    for (const entry of manifest.assets) {
      const meta = getStockAssetMeta(entry.id);
      const details = getStockAssetDetails(entry.id);
      expect(entry).toMatchObject({
        file: details?.file,
        mimeType: meta?.mimeType,
        width: meta?.width,
        height: meta?.height,
        durationMs: meta?.durationMs,
      });
      const file = stockAssetFilePath(entry.id);
      expect(file.startsWith(STOCK_ASSETS_DIR + path.sep), file).toBe(true);
      const bytes = fs.readFileSync(file);
      expect(bytes.length, entry.id).toBe(entry.bytes);
      expect(sha256(bytes), entry.id).toBe(entry.sha256);
      // "Reasonable size": a background stays under 400 KB, a track under 1 MB.
      expect(bytes.length, entry.id).toBeLessThan(meta?.kind === 'image' ? 400_000 : 1_000_000);
      total += bytes.length;
      if (details?.loopSamples) expect(entry.samples, entry.id).toBe(details.loopSamples);
    }
    expect(total).toBeLessThan(12_000_000);
    for (const [dir, ids, ext] of [
      ['backgrounds', STOCK_BACKGROUND_IDS, 'jpg'],
      ['music', STOCK_MUSIC_IDS, 'm4a'],
    ] as const) {
      const onDisk = fs.readdirSync(path.join(STOCK_ASSETS_DIR, dir)).sort();
      expect(onDisk).toEqual(ids.map((id) => `${id}.${ext}`).sort());
    }
  });

  it('serves the bytes memoised, with NOT_FOUND for unknown ids', async () => {
    for (const asset of listStockAssets()) {
      const data = await getStockAssetData(asset.id);
      expect(data.mimeType).toBe(asset.mimeType);
      expect(await getStockAssetData(asset.id)).toBe(data);
      if (asset.kind === 'image') expect(isJpeg(data.bytes), asset.id).toBe(true);
      else expect(Buffer.from(data.bytes.subarray(4, 8)).toString(), asset.id).toBe('ftyp');
    }
    await expect(getStockAssetData('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getStockAssetData('../manifest')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(() => stockAssetFilePath('nope')).toThrowError(/not found/i);
  });
});

describe('stock backgrounds', () => {
  it('are the pictures the painters produce today (regenerate after changing a painter)', async () => {
    for (const id of STOCK_BACKGROUND_IDS) {
      const committed = await loadImage(stockAssetFilePath(id));
      expect([committed.width, committed.height], id).toEqual([
        STOCK_BACKGROUND_SIZE,
        STOCK_BACKGROUND_SIZE,
      ]);
      // Compare at reduced size: robust to JPEG encoder differences, sensitive to a new design.
      const size = 96;
      const fresh = renderBackground(id, size, size).getContext('2d');
      const master = renderBackground(id, size, size);
      const masterCtx = master.getContext('2d');
      masterCtx.drawImage(committed, 0, 0, size, size);
      const a = fresh.getImageData(0, 0, size, size).data;
      const b = masterCtx.getImageData(0, 0, size, size).data;
      let diff = 0;
      let min = 255;
      let max = 0;
      for (let i = 0; i < a.length; i += 4) {
        for (let c = 0; c < 3; c += 1) {
          const value = b[i + c] as number;
          diff += Math.abs((a[i + c] as number) - value);
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
      expect(diff / (size * size * 3), id).toBeLessThan(6);
      expect(max - min, `${id} is not a flat colour`).toBeGreaterThan(20);
    }
  }, 60_000);

  it('can be painted at any aspect ratio, deterministically, as a centred cover crop', async () => {
    for (const [width, height] of [
      [1280, 720],
      [720, 1280],
      [720, 720],
    ] as const) {
      const first = renderStockBackground('bg-studio-dark', width, height);
      const second = renderStockBackground('bg-studio-dark', width, height);
      expect(first.mimeType).toBe('image/jpeg');
      expect(sha256(first.bytes)).toBe(sha256(second.bytes));
      const image = await loadImage(Buffer.from(first.bytes));
      expect([image.width, image.height]).toEqual([width, height]);
    }
    // The 16:9 render equals the middle band of the square design.
    const square = renderBackground('bg-waves', 320, 320).getContext('2d');
    const wide = renderBackground('bg-waves', 320, 180).getContext('2d');
    const fromSquare = square.getImageData(0, 70, 320, 180).data;
    const direct = wide.getImageData(0, 0, 320, 180).data;
    let diff = 0;
    for (let i = 0; i < direct.length; i += 1) {
      diff += Math.abs((direct[i] as number) - (fromSquare[i] as number));
    }
    expect(diff / direct.length).toBeLessThan(4);
    expect(() => renderStockBackground('nope', 100, 100)).toThrowError(/not found/i);
    expect(() => renderStockBackground('music-happy-day', 100, 100)).toThrowError(/background/);
  });
});

describe('stock music', () => {
  const probe = (file: string): Record<string, string> => {
    const result = spawnSync(
      'ffprobe',
      [
        ...['-v', 'error', '-select_streams', 'a:0', '-show_entries'],
        ...['stream=codec_name,sample_rate,channels,duration', '-of', 'default=nw=1', file],
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    );
  };

  it('is stereo AAC at 48 kHz of exactly the catalogue length', () => {
    for (const id of STOCK_MUSIC_IDS) {
      const loop = stockMusicLoop(id);
      const info = probe(loop.path);
      expect(info, id).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: '2' });
      expect(Math.abs(Number(info.duration) * 1000 - loop.durationMs), id).toBeLessThan(2);
    }
  });

  it('decodes to the rendered loop and wraps around without a click', () => {
    for (const spec of MUSIC_TRACKS) {
      const loop = stockMusicLoop(spec.id);
      const { bus } = renderTrack(spec);
      expect(bus.length, spec.id).toBe(loop.samples);
      expect(Math.abs(loudnessLufs(bus) - TARGET_LUFS), spec.id).toBeLessThan(0.3);
      expect(bus.peak(), spec.id).toBeLessThanOrEqual(0.9);

      const pcm = decodeToPcm(loop.path);
      const n = pcm.length / 2;
      expect(n, `${spec.id} decoded length`).toBe(loop.samples);

      // 1. The file IS the track the code renders today, sample-aligned (a shifted or stale
      //    file would have no correlation): signal-to-error ratio of the lossy encoding.
      let signal = 0;
      let error = 0;
      let deltaSquares = 0;
      for (let i = 0; i < n; i += 1) {
        const l = pcm[2 * i] as number;
        const r = pcm[2 * i + 1] as number;
        signal += (bus.left[i] as number) ** 2 + (bus.right[i] as number) ** 2;
        error += (l - (bus.left[i] as number)) ** 2 + (r - (bus.right[i] as number)) ** 2;
        if (i > 0) {
          deltaSquares +=
            (l - (pcm[2 * i - 2] as number)) ** 2 + (r - (pcm[2 * i - 1] as number)) ** 2;
        }
      }
      expect(10 * Math.log10(signal / error), `${spec.id} SNR`).toBeGreaterThan(18);

      // 2. Loop seam: the step from the last sample back to the first one is no bigger than
      //    an ordinary step between two neighbouring samples of the same track.
      const typicalStep = Math.sqrt(deltaSquares / (2 * (n - 1)));
      const seam = Math.max(
        Math.abs((pcm[0] as number) - (pcm[2 * (n - 1)] as number)),
        Math.abs((pcm[1] as number) - (pcm[2 * (n - 1) + 1] as number)),
      );
      expect(seam, `${spec.id} seam`).toBeLessThan(3 * typicalStep + 0.002);

      // 3. No fade or silence was added at the edges: the first and the last 20 ms carry
      //    signal, and the codec error there is as low as anywhere else.
      for (const from of [0, n - 960]) {
        let edgeSignal = 0;
        let edgeError = 0;
        for (let i = from; i < from + 960; i += 1) {
          edgeSignal += (bus.left[i] as number) ** 2;
          edgeError += ((pcm[2 * i] as number) - (bus.left[i] as number)) ** 2;
        }
        expect(Math.sqrt(edgeSignal / 960), `${spec.id} edge level`).toBeGreaterThan(0.01);
        expect(10 * Math.log10(edgeSignal / edgeError), `${spec.id} edge SNR`).toBeGreaterThan(12);
      }
    }
  }, 180_000);

  it('repeats seamlessly through the ffmpeg filter the helper recommends', () => {
    const loop = stockMusicLoop('music-ambient-dawn');
    const twice = decodeToPcm(
      loop.path,
      [],
      ['-af', loop.aloopFilter, '-t', String((2 * loop.samples) / STOCK_MUSIC_SAMPLE_RATE)],
    );
    const n = loop.samples;
    expect(twice.length / 2).toBe(2 * n);
    let step = 0;
    for (let i = n - 2000; i < n + 2000; i += 1) {
      const d = Math.abs((twice[2 * i] as number) - (twice[2 * i - 2] as number));
      if (i === n) expect(d, 'step across the seam').toBeLessThan(0.02);
      step = Math.max(step, d);
    }
    // Nothing near the seam jumps more than the music itself does (a click would be ≥ 0.1).
    expect(step).toBeLessThan(0.06);
    // Second pass is the first pass again, sample for sample.
    for (let i = 0; i < n; i += 997) {
      expect(twice[2 * (n + i)]).toBe(twice[2 * i]);
    }
  }, 60_000);
});

describe('photorealistic stock avatars', () => {
  it('keeps every avatar valid, with its images committed', () => {
    const avatars = listStockPhotorealAvatars();
    expect(new Set(avatars.map((a) => a.id)).size).toBe(avatars.length);
    for (const avatar of avatars) {
      expect(StockPhotorealAvatarMetaSchema.parse(avatar)).toEqual(avatar);
      expect(avatar.id).toMatch(/^real_[a-z0-9-]+$/);
      const files = stockPhotorealAvatarFiles(avatar.id);
      expect(fs.existsSync(files.portraitPath), files.portraitPath).toBe(true);
      if (files.maskPath) expect(fs.existsSync(files.maskPath), files.maskPath).toBe(true);
    }
    expect(() => stockPhotorealAvatarFiles('real_nope')).toThrow();
  });

  it('serves portrait, matte, cut-out and thumbnail with the right media type', async () => {
    for (const avatar of listStockPhotorealAvatars()) {
      const portrait = await getStockPhotorealAvatarFile(avatar.id, 'portrait');
      const cutout = await getStockPhotorealAvatarFile(avatar.id, 'cutout');
      const thumb = await getStockPhotorealAvatarFile(avatar.id, 'thumb');
      // The declared type is the real one (portraits are committed as JPEG).
      expect(portrait.mimeType).toBe(isJpeg(portrait.bytes) ? 'image/jpeg' : 'image/png');
      expect(Buffer.from(cutout.bytes.subarray(1, 4)).toString()).toBe('PNG');
      expect(isJpeg(thumb.bytes)).toBe(true);
      expect(await getStockPhotorealAvatarFile(avatar.id, 'cutout')).toBe(cutout); // memoised
      if (avatar.maskFile) {
        expect((await getStockPhotorealAvatarFile(avatar.id, 'mask')).mimeType).toBe('image/png');
      } else {
        await expect(getStockPhotorealAvatarFile(avatar.id, 'mask')).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      }
    }
    for (const file of ['portrait', 'mask', 'cutout', 'thumb'] as const) {
      await expect(getStockPhotorealAvatarFile('real_nope', file)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
  });
});
