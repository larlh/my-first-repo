import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, createComposition, newId } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { assets } from '@parlante/db';
import {
  canvasToPng,
  canvasToRgba,
  createNodeCanvas,
  loadNodeImage,
} from '@parlante/renderer/node';
import { getStockAssetData, getStockPhotorealAvatarFile } from '@parlante/stock-assets/node';
import { getBuiltinTemplate } from '@parlante/templates';
import { createTestApp } from '../testing/index';
import type { TestApp } from '../testing/index';
import { sendPublicBinary } from './binary';
import { defineRoute } from './define-route';
import { defineModule } from './modules';
import { renderPoster } from './poster';

let t: TestApp;

/** The two public stock routes, implemented exactly as their owning modules will. */
const stockRoutes = defineModule({
  name: 'stock-binary-test',
  register(app) {
    defineRoute(app, api.assets.stockFile, async ({ params, reply }) =>
      sendPublicBinary(reply, await getStockAssetData(params.stockId)),
    );
    defineRoute(app, api.avatars.stockFile, async ({ params, reply }) =>
      sendPublicBinary(reply, await getStockPhotorealAvatarFile(params.avatarId, params.file)),
    );
  },
});

beforeAll(async () => {
  t = await createTestApp({ modules: [stockRoutes] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

async function decode(jpeg: Buffer) {
  expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
  const image = await loadNodeImage(jpeg);
  const { canvas, ctx } = createNodeCanvas(image.width, image.height);
  ctx.drawImage(image.source, 0, 0);
  const data = canvasToRgba(canvas);
  return {
    width: image.width,
    height: image.height,
    at: (x: number, y: number) => {
      const o = (Math.round(y) * image.width + Math.round(x)) * 4;
      return [data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0];
    },
  };
}

describe('renderPoster', () => {
  it('renders the first scene of a built-in template with the real renderer', async () => {
    const template = getBuiltinTemplate('builtin_explainer');
    if (!template) throw new Error('template');
    const deps = { db: t.db, providers: t.app.providers };
    const poster = await decode(
      await renderPoster(deps, template.composition, { workspaceId: null }),
    );
    expect([poster.width, poster.height]).toEqual([640, 360]);
    // Not a flat image: the scene (gradient, avatar, text) was actually drawn.
    const colours = new Set<string>();
    for (let x = 20; x < 640; x += 60) {
      for (let y = 20; y < 360; y += 60) colours.add(poster.at(x, y).join(','));
    }
    expect(colours.size).toBeGreaterThan(8);
    // Vertical compositions keep their aspect ratio.
    const vertical = await decode(
      await renderPoster(deps, createComposition({ aspect: '9:16' }), {
        workspaceId: null,
        width: 180,
      }),
    );
    expect([vertical.width, vertical.height]).toEqual([180, 320]);
  });

  it('uses images of the workspace and never those of another workspace', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const { canvas, ctx } = createNodeCanvas(64, 64);
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, 64, 64);
    const assetId = newId('asset');
    const storageKey = storageKeys.asset(alice.workspace.id, assetId, 'png');
    await t.app.providers.storage.put(storageKey, canvasToPng(canvas), {
      contentType: 'image/png',
    });
    await t.db.insert(assets).values({
      id: assetId,
      workspaceId: alice.workspace.id,
      kind: 'image',
      name: 'verde.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      width: 64,
      height: 64,
      storageKey,
    });
    const composition = createComposition({
      scenes: [
        {
          background: { type: 'image', src: { source: 'asset', assetId }, fit: 'fill' },
        },
      ],
    });
    const deps = { db: t.db, providers: t.app.providers };
    const mine = await decode(
      await renderPoster(deps, composition, { workspaceId: alice.workspace.id }),
    );
    const [r, g, b] = mine.at(320, 180);
    expect(g).toBeGreaterThan(230);
    expect(r).toBeLessThan(30);
    expect(b).toBeLessThan(30);
    // Rendered for another workspace (or none) the asset does not resolve: placeholder, no leak.
    for (const workspaceId of [bob.workspace.id, null]) {
      const other = await decode(await renderPoster(deps, composition, { workspaceId }));
      expect(other.at(320, 180)[1]).toBeLessThan(200);
    }
  });
});

describe('sendPublicBinary', () => {
  it('serves stock bytes through contract routes as public, cacheable content', async () => {
    const stockAsset = await t.call(api.assets.stockFile, { params: { stockId: 'bg-aurora' } });
    expect(stockAsset.status).toBe(200);
    expect(stockAsset.raw.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect(stockAsset.headers['content-type']).toBe('image/png');
    expect(stockAsset.headers['cache-control']).toBe('public, max-age=86400');
    expect(stockAsset.headers['x-content-type-options']).toBe('nosniff');
    expect(stockAsset.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Number(stockAsset.headers['content-length'])).toBe(stockAsset.raw.rawPayload.length);

    // Photorealistic stock avatars: unknown ids are 404, anything off-contract is 400.
    const missing = await t.call(api.avatars.stockFile, {
      params: { avatarId: 'real_nope', file: 'cutout' },
    });
    expect(missing.status).toBe(404);
    expect(missing.error.code).toBe('NOT_FOUND');
    for (const url of [
      '/api/stock-avatars/real_nope/secret',
      '/api/stock-avatars/stock_lucia/thumb',
      '/api/stock-avatars/real_..%2Fx/thumb',
    ]) {
      expect((await t.inject({ method: 'GET', url })).statusCode, url).toBe(400);
    }
  });
});
