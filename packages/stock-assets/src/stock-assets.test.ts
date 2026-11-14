import { describe, expect, it } from 'vitest';
import { StockAssetMetaSchema, StockPhotorealAvatarMetaSchema } from '@parlante/shared';
import { getStockAssetMeta, listStockAssets, listStockPhotorealAvatars } from './index';
import fs from 'node:fs';
import { getStockAssetData, stockPhotorealAvatarFiles } from './node/index';

describe('stock assets', () => {
  it('have valid, unique metadata', () => {
    const assets = listStockAssets();
    expect(assets.length).toBeGreaterThanOrEqual(1);
    expect(new Set(assets.map((a) => a.id)).size).toBe(assets.length);
    for (const asset of assets) {
      expect(StockAssetMetaSchema.parse(asset)).toEqual(asset);
      expect(asset.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
    expect(getStockAssetMeta('nope')).toBeNull();
  });

  it('generates deterministic bytes of the declared type for every asset', async () => {
    for (const asset of listStockAssets()) {
      const a = await getStockAssetData(asset.id);
      expect(a.mimeType).toBe(asset.mimeType);
      expect(a.bytes.length).toBeGreaterThan(1000);
      if (asset.mimeType === 'image/png') {
        expect(Buffer.from(a.bytes.subarray(1, 4)).toString()).toBe('PNG');
      }
      expect(await getStockAssetData(asset.id)).toBe(a);
    }
    await expect(getStockAssetData('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps every photorealistic stock avatar valid, with its images committed', () => {
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
});
