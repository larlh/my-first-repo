import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { api, buildPath, createComposition } from '@parlante/shared';
import { computeTimeline, listStockAvatars } from '@parlante/renderer';
import { listBuiltinTemplates } from '@parlante/templates';

/**
 * Toolchain smoke test: React + jsdom + Testing Library work, and the internal packages are
 * consumable from the web app as TypeScript source. Replace/extend with real feature tests.
 */
describe('web toolchain', () => {
  it('renders React components in jsdom', () => {
    render(<button type="button">Crear vídeo</button>);
    expect(screen.getByRole('button', { name: 'Crear vídeo' })).toBeDefined();
  });

  it('imports the shared contract, renderer and templates', () => {
    expect(buildPath(api.videos.get.path, { videoId: 'vid_1' })).toBe('/api/videos/vid_1');
    expect(computeTimeline(createComposition(), { scenes: {} }).totalMs).toBe(3000);
    expect(listStockAvatars().length).toBeGreaterThanOrEqual(8);
    expect(listBuiltinTemplates().length).toBeGreaterThanOrEqual(1);
  });
});
