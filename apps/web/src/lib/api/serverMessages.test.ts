import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER_MESSAGES_ES, localizeServerMessage } from './serverMessages';

/** Every non-test TypeScript source of the packages that raise `AppError`s. */
function serverSources(): string {
  const root = path.resolve(__dirname, '../../../../..');
  const roots = [
    'apps/api/src',
    'apps/worker/src',
    'packages/jobs/src',
    'packages/providers/src',
    'packages/shared/src',
    'packages/db/src',
  ];
  const chunks: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(file);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        chunks.push(readFileSync(file, 'utf8'));
      }
    }
  };
  for (const dir of roots) walk(path.join(root, dir));
  // Messages are sometimes wrapped over two source lines.
  return chunks.join('\n').replace(/\s+/g, ' ');
}

describe('localizeServerMessage', () => {
  it('leaves the sentence alone in English and translates a known one in Spanish', () => {
    const raw = 'There is nothing to dub: the translated transcript has no speakable text';
    expect(localizeServerMessage(raw, 'en', 'UNPROCESSABLE')).toEqual({
      text: raw,
      technical: false,
    });
    const es = localizeServerMessage(raw, 'es', 'UNPROCESSABLE');
    expect(es.technical).toBe(false);
    expect(es.text).toMatch(/^No hay nada que doblar/);
    // The same sentence with a final full stop is still recognised.
    expect(localizeServerMessage(`${raw}.`, 'es').text).toBe(es.text);
  });

  it('rebuilds sentences that carry values', () => {
    expect(localizeServerMessage('The Free plan cannot render 1080p', 'es').text).toBe(
      'El plan Free no permite renderizar a 1080p.',
    );
    expect(localizeServerMessage('Row 3 has no value for: nombre, empresa', 'es').text).toBe(
      'La fila 3 no tiene valor para: nombre, empresa.',
    );
    expect(
      localizeServerMessage(
        'The local avatar engine is not reachable at http://127.0.0.1:8090 (connection failed). Start it with `pnpm avatar-engine`',
        'es',
      ),
    ).toMatchObject({ technical: false });
  });

  it('marks an unknown sentence as technical instead of hiding it or passing it as UI text', () => {
    expect(localizeServerMessage('Something nobody translated', 'es', 'UNPROCESSABLE')).toEqual({
      text: 'Something nobody translated',
      technical: true,
    });
    // …unless the translated code already says it all.
    expect(localizeServerMessage('Video not found', 'es', 'NOT_FOUND')).toEqual({
      text: '',
      technical: false,
    });
    expect(localizeServerMessage('', 'es')).toEqual({ text: '', technical: false });
    expect(localizeServerMessage(null, 'es')).toEqual({ text: '', technical: false });
  });

  it('only lists sentences the server still sends (the table must follow the server)', () => {
    const sources = serverSources();
    const gone = Object.keys(SERVER_MESSAGES_ES).filter(
      (sentence) => !sources.includes(sentence.replace(/\s+/g, ' ')),
    );
    expect(gone).toEqual([]);
  });
});
