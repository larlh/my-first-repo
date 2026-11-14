import { createCanvas } from '@napi-rs/canvas';

export interface GeneratedAsset {
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * Generators keyed by stock id. Each one must be deterministic (same bytes on every call):
 * no Math.random() / Date.now(). Owner: content.
 */
export const GENERATORS: Record<string, () => GeneratedAsset | Promise<GeneratedAsset>> = {
  'bg-aurora': () => {
    const width = 1920;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const base = ctx.createLinearGradient(0, 0, width, height);
    base.addColorStop(0, '#141833');
    base.addColorStop(1, '#3b2f8f');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);
    const blobs: [number, number, number, string][] = [
      [0.2, 0.3, 0.45, '#6d5efc'],
      [0.75, 0.25, 0.4, '#ff6b9d'],
      [0.6, 0.85, 0.5, '#2ec4b6'],
    ];
    for (const [x, y, r, color] of blobs) {
      const glow = ctx.createRadialGradient(
        x * width,
        y * height,
        0,
        x * width,
        y * height,
        r * width,
      );
      glow.addColorStop(0, `${color}99`);
      glow.addColorStop(1, `${color}00`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
    }
    return { bytes: canvas.toBuffer('image/png'), mimeType: 'image/png' };
  },
};
