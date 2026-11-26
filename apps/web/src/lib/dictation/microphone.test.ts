import { afterEach, describe, expect, it, vi } from 'vitest';
import { microphoneSupport, openMicrophone } from './microphone';
import { DictationFailure } from './types';

/* jsdom has neither a microphone nor Web Audio. These tests install the minimum a browser
 * offers and check how each way of failing to open the microphone is explained; the capture
 * itself (worklet, resampling, real audio) is exercised end to end in e2e/dictation.mjs. */

const handlers = { onSamples: () => undefined, onLost: () => undefined };

function installBrowser(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  vi.stubGlobal('AudioContext', class {});
  vi.stubGlobal('AudioWorkletNode', class {});
}

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DictationFailure) return error.detail.code;
    throw error;
  }
  throw new Error('It should have failed');
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(globalThis, 'AudioContext');
  Reflect.deleteProperty(globalThis, 'AudioWorkletNode');
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

describe('opening the microphone', () => {
  it('says the browser cannot capture audio when the APIs are missing', async () => {
    expect(microphoneSupport()).toBe('unsupported');
    expect(await failureOf(() => openMicrophone(handlers))).toBe('unsupported');
  });

  it('says the page is not secure when the browser hides the microphone for that reason', async () => {
    installBrowser(() => Promise.reject(new Error('never called')));
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    expect(microphoneSupport()).toBe('insecure_context');
    expect(await failureOf(() => openMicrophone(handlers))).toBe('insecure_context');
  });

  it.each([
    ['NotAllowedError', 'permission_denied'],
    ['SecurityError', 'permission_denied'],
    ['NotFoundError', 'no_microphone'],
    ['OverconstrainedError', 'no_microphone'],
    ['NotReadableError', 'microphone_busy'],
    ['AbortError', 'microphone_busy'],
    ['NotSupportedError', 'unsupported'],
  ])('explains a getUserMedia %s', async (name, code) => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException('refused', name)));
    installBrowser(getUserMedia);
    expect(microphoneSupport()).toBe('ok');
    expect(await failureOf(() => openMicrophone(handlers))).toBe(code);
    // The raw signal is requested: the browser's call processing costs the model accuracy.
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  });

  it('releases the device when the audio graph cannot be built', async () => {
    const stop = vi.fn();
    installBrowser(() =>
      Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream),
    );
    // The stub AudioContext has no `audioWorklet`: building the graph fails.
    expect(await failureOf(() => openMicrophone(handlers))).toBe('unsupported');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
