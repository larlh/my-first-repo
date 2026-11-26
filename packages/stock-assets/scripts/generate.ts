/**
 * Regenerates every stock background and music track from code and rewrites
 * `assets/manifest.json`.
 *
 *   pnpm --filter @parlante/stock-assets generate            # everything
 *   pnpm --filter @parlante/stock-assets generate -- bg-     # ids containing "bg-"
 *   pnpm --filter @parlante/stock-assets generate -- --check # regenerate in memory and compare
 *
 * Deterministic: same code ⇒ same pictures and same PCM. Backgrounds are compared by file hash;
 * music by the hash of the rendered PCM (the AAC bytes depend on the ffmpeg build). Requires
 * ffmpeg on PATH for the music.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STOCK_BACKGROUND_IDS,
  STOCK_BACKGROUND_SIZE,
  STOCK_MUSIC_IDS,
  getStockAssetDetails,
  getStockAssetMeta,
} from '../src/catalog';
import { renderBackground } from '../src/generators/backgrounds';
import { encodeTrack } from '../src/generators/music/encode';
import { loudnessLufs } from '../src/generators/music/synth';
import { MUSIC_TRACKS, renderTrack } from '../src/generators/music/tracks';
import type { StockManifest, StockManifestEntry } from '../src/node/index';

const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');
const MANIFEST_PATH = path.join(ASSETS_DIR, 'manifest.json');
const BACKGROUND_JPEG_QUALITY = 90;

const args = process.argv.slice(2).filter((a) => a !== '--');
const check = args.includes('--check');
const filters = args.filter((a) => !a.startsWith('--'));
const wanted = (id: string): boolean => filters.length === 0 || filters.some((f) => id.includes(f));

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function entryBase(
  id: string,
): Pick<StockManifestEntry, 'id' | 'file' | 'mimeType' | 'width' | 'height' | 'durationMs'> {
  const meta = getStockAssetMeta(id);
  const details = getStockAssetDetails(id);
  if (!meta || !details) throw new Error(`${id} is not in the catalogue`);
  return {
    id,
    file: details.file,
    mimeType: meta.mimeType,
    width: meta.width,
    height: meta.height,
    durationMs: meta.durationMs,
  };
}

const previous: StockManifest = fs.existsSync(MANIFEST_PATH)
  ? (JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as StockManifest)
  : { version: 1, assets: [] };
const entries = new Map(previous.assets.map((entry) => [entry.id, entry]));
const problems: string[] = [];

function store(entry: StockManifestEntry, bytes: Uint8Array): void {
  const before = entries.get(entry.id);
  if (check) {
    const same =
      before !== undefined &&
      (entry.pcmSha256 !== undefined
        ? before.pcmSha256 === entry.pcmSha256 && before.samples === entry.samples
        : before.sha256 === entry.sha256);
    if (!same) problems.push(entry.id);
    console.log(`${same ? 'ok      ' : 'MISMATCH'} ${entry.id}`);
    return;
  }
  const target = path.join(ASSETS_DIR, entry.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  entries.set(entry.id, entry);
  console.log(`wrote ${entry.file} (${(entry.bytes / 1024).toFixed(0)} KB)`);
}

for (const id of STOCK_BACKGROUND_IDS) {
  if (!wanted(id)) continue;
  const canvas = renderBackground(id, STOCK_BACKGROUND_SIZE, STOCK_BACKGROUND_SIZE);
  const bytes = canvas.toBuffer('image/jpeg', BACKGROUND_JPEG_QUALITY);
  store({ ...entryBase(id), bytes: bytes.length, sha256: sha256(bytes) }, bytes);
}

for (const id of STOCK_MUSIC_IDS) {
  if (!wanted(id)) continue;
  const spec = MUSIC_TRACKS.find((track) => track.id === id);
  if (!spec) throw new Error(`No track is defined for ${id}`);
  const { bus, grid } = renderTrack(spec);
  const base = entryBase(id);
  if (base.durationMs !== grid.durationMs || getStockAssetDetails(id)?.loopSamples !== bus.length) {
    throw new Error(`${id}: the catalogue and the track disagree on the loop length`);
  }
  const encoded = encodeTrack(bus);
  store(
    {
      ...base,
      bytes: encoded.bytes.length,
      sha256: sha256(encoded.bytes),
      samples: encoded.samples,
      pcmSha256: encoded.pcmSha256,
    },
    encoded.bytes,
  );
  if (!check) {
    console.log(
      `      ${spec.bpm} BPM, ${spec.bars} bars, ${loudnessLufs(bus).toFixed(1)} LUFS, peak ${bus.peak().toFixed(2)}`,
    );
  }
}

if (check) {
  if (problems.length > 0) {
    console.error(`\n${problems.length} asset(s) differ from the manifest: ${problems.join(', ')}`);
    process.exit(1);
  }
  console.log('\nEvery regenerated asset matches assets/manifest.json');
} else {
  const order: string[] = [...STOCK_BACKGROUND_IDS, ...STOCK_MUSIC_IDS];
  const manifest: StockManifest = {
    version: 1,
    assets: order.flatMap((id) => {
      const entry = entries.get(id);
      return entry ? [entry] : [];
    }),
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote manifest.json (${manifest.assets.length} assets)`);
}
