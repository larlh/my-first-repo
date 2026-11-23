import { ALLOWED_UPLOAD_MIME } from '@parlante/shared';
import { describe, expect, it } from 'vitest';
import {
  ASSET_KINDS,
  acceptFor,
  checkFile,
  checkFiles,
  displayNameOf,
  extensionOf,
  kindOfFile,
} from './files';

const MB = 1024 * 1024;
const file = (name: string, type: string, size = MB) => ({ name, type, size });
const rules = { maxUploadBytes: 100 * MB, storageLeftBytes: 500 * MB };

describe('kindOfFile', () => {
  it('reads the kind from the MIME type', () => {
    expect(kindOfFile(file('a.png', 'image/png'))).toBe('image');
    expect(kindOfFile(file('a.mov', 'video/quicktime'))).toBe('video');
    expect(kindOfFile(file('a.mp3', 'audio/mpeg'))).toBe('audio');
    expect(kindOfFile(file('a.PNG', 'IMAGE/PNG'))).toBe('image');
  });

  it('falls back to the extension only when the browser gave no type', () => {
    expect(kindOfFile(file('voz.flac', ''))).toBe('audio');
    expect(kindOfFile(file('clip.MOV', 'application/octet-stream'))).toBe('video');
    // A declared type that is not accepted is not rescued by a friendly extension.
    expect(kindOfFile(file('informe.png', 'application/pdf'))).toBeNull();
    expect(kindOfFile(file('notas.txt', 'text/plain'))).toBeNull();
    expect(kindOfFile(file('sin-extension', ''))).toBeNull();
  });

  it('knows every MIME type of the contract', () => {
    for (const kind of ASSET_KINDS) {
      for (const mime of ALLOWED_UPLOAD_MIME[kind]) {
        expect(kindOfFile(file('x', mime)), mime).toBe(kind);
      }
    }
  });
});

describe('checkFile', () => {
  it('accepts a supported file within the limits', () => {
    expect(checkFile(file('logo.png', 'image/png'), rules)).toEqual({
      kind: 'image',
      reason: null,
    });
  });

  it('rejects by type, emptiness, size and free storage, in that order', () => {
    expect(checkFile(file('a.pdf', 'application/pdf', 200 * MB), rules).reason).toBe('type');
    expect(checkFile(file('a.png', 'image/png', 0), rules).reason).toBe('empty');
    expect(checkFile(file('a.mp4', 'video/mp4', 100 * MB + 1), rules).reason).toBe('size');
    expect(checkFile(file('a.mp4', 'video/mp4', 100 * MB), rules).reason).toBeNull();
    expect(
      checkFile(file('a.mp4', 'video/mp4', 60 * MB), { ...rules, storageLeftBytes: 50 * MB })
        .reason,
    ).toBe('storage');
    // Unknown free storage: the server decides.
    expect(
      checkFile(file('a.mp4', 'video/mp4', 60 * MB), { ...rules, storageLeftBytes: null }).reason,
    ).toBeNull();
  });

  it('can be limited to the kinds a slot accepts', () => {
    expect(checkFile(file('a.mp3', 'audio/mpeg'), { ...rules, kinds: ['image'] })).toEqual({
      kind: 'audio',
      reason: 'kind',
    });
  });
});

describe('checkFiles', () => {
  it('fills the free storage in order and explains what did not fit', () => {
    const selection = [
      file('uno.mp4', 'video/mp4', 40 * MB),
      file('dos.mp4', 'video/mp4', 40 * MB),
      file('tres.mp4', 'video/mp4', 40 * MB),
      file('cuatro.png', 'image/png', 10 * MB),
      file('cinco.exe', 'application/x-msdownload', MB),
    ];
    const checked = checkFiles(selection, { maxUploadBytes: 100 * MB, storageLeftBytes: 95 * MB });
    expect(checked.map((item) => item.reason)).toEqual([null, null, 'storage', null, 'type']);
  });
});

describe('names and accept list', () => {
  it('derives the display name from the file name', () => {
    expect(displayNameOf('Logo final.v2.png')).toBe('Logo final.v2');
    expect(displayNameOf('.env')).toBe('.env');
    expect(displayNameOf('sin-extension')).toBe('sin-extension');
    expect(displayNameOf(`${'a'.repeat(200)}.png`)).toHaveLength(120);
    expect(extensionOf('Clip.MP4')).toBe('mp4');
    expect(extensionOf('sin-extension')).toBe('');
  });

  it('builds the accept attribute for the requested kinds', () => {
    const images = acceptFor(['image']);
    expect(images).toContain('image/png');
    expect(images).toContain('.jpg');
    expect(images.some((entry) => entry.startsWith('video/'))).toBe(false);
    expect(acceptFor()).toEqual(expect.arrayContaining(['video/mp4', 'audio/mpeg', '.flac']));
  });
});
