// A real file next to the bundle (never inlined as a `data:` URL), so the worklet keeps loading
// under a Content-Security-Policy that only allows same-origin scripts.
import captureWorkletUrl from './capture-worklet.js?url&no-inline';
import { DictationFailure } from './types';

/* Microphone capture for the local engine: getUserMedia → Web Audio → AudioWorklet, which
 * posts mono blocks at the hardware rate. The stream never leaves this page. */

export interface MicrophoneCapture {
  /** Rate of the blocks handed to `onSamples`. */
  sampleRate: number;
  /** Stop capturing and release the device (the browser's recording indicator goes off). */
  stop: () => void;
}

export interface MicrophoneHandlers {
  onSamples: (samples: Float32Array) => void;
  /** The device stopped on its own (unplugged, permission revoked). */
  onLost: () => void;
}

export type OpenMicrophone = (handlers: MicrophoneHandlers) => Promise<MicrophoneCapture>;

const WORKLET_NAME = 'parlante-capture';

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | undefined {
  const scope = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

/** True when this browser can capture audio the way the local engine needs. */
export function microphoneSupport(): 'ok' | 'insecure_context' | 'unsupported' {
  if (typeof window === 'undefined') return 'unsupported';
  if (window.isSecureContext === false) return 'insecure_context';
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return 'unsupported';
  const Ctor = audioContextCtor();
  if (!Ctor || typeof AudioWorkletNode === 'undefined') return 'unsupported';
  return 'ok';
}

function failureOfMediaError(error: unknown): DictationFailure {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return new DictationFailure({ code: 'permission_denied' });
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new DictationFailure({ code: 'no_microphone' });
    case 'NotSupportedError':
    case 'TypeError':
      return new DictationFailure({ code: 'unsupported' });
    default:
      return new DictationFailure({ code: 'microphone_busy' });
  }
}

export const openMicrophone: OpenMicrophone = async (handlers) => {
  const support = microphoneSupport();
  if (support !== 'ok') throw new DictationFailure({ code: support });
  const Ctor = audioContextCtor();
  if (!Ctor) throw new DictationFailure({ code: 'unsupported' });

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // The signal as the microphone gives it. The browser's call processing (echo canceller,
      // noise suppressor, automatic gain) is tuned for people listening, and measurably
      // costs the speech model words; a quiet microphone is handled by `normalizeSegment`.
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  } catch (error) {
    throw failureOfMediaError(error);
  }

  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  let context: AudioContext;
  let node: AudioWorkletNode;
  try {
    context = new Ctor({ latencyHint: 'interactive' });
    await context.audioWorklet.addModule(captureWorkletUrl);
    if (context.state === 'suspended') await context.resume();
    node = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      // One explicit channel: Web Audio down-mixes stereo devices for us.
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
  } catch {
    release();
    throw new DictationFailure({ code: 'unsupported' });
  }

  let stopped = false;
  const source = context.createMediaStreamSource(stream);
  // A silent path to the destination keeps the graph pulling the worklet in every browser.
  const sink = context.createGain();
  sink.gain.value = 0;
  node.port.onmessage = (event: MessageEvent<unknown>) => {
    if (!stopped && event.data instanceof Float32Array) handlers.onSamples(event.data);
  };
  source.connect(node);
  node.connect(sink);
  sink.connect(context.destination);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    node.port.postMessage('stop');
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    sink.disconnect();
    release();
    void context.close().catch(() => undefined);
  };

  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (stopped) return;
      stop();
      handlers.onLost();
    });
  }

  return { sampleRate: context.sampleRate, stop };
};
