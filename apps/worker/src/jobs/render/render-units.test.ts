import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_GENERATED_METADATA, AUDIO_MIX, createComposition } from '@parlante/shared';
import type { MediaInfo } from '@parlante/shared/node';
import { computeTimeline } from '@parlante/renderer';
import { ffprobe, runFfmpeg } from '../../lib/ffmpeg';
import { encodeArgs } from './encode';
import {
  ENVELOPE_RATE,
  collectVideoSounds,
  musicEnvelope,
  narrationWindows,
  soundtrackArgs,
  soundtrackSamples,
} from './mix';
import { thumbnailTimeMs } from './outputs';
import { stageRanges } from './run';
import {
  encodeMonoPcm16Wav,
  parseMonoPcm16Wav,
  pcm16FromBytes,
  sceneAudioWav,
  toFloatSamples,
} from './wav';

const audioInfo = (durationMs: number, hasAudio = true): MediaInfo => ({
  formatName: 'wav',
  durationMs,
  sizeBytes: null,
  hasVideo: false,
  hasAudio,
  width: null,
  height: null,
  fps: null,
  videoCodec: null,
  audioCodec: hasAudio ? 'pcm_s16le' : null,
  sampleRate: 48000,
  channels: 1,
});

function sine(seconds: number, hz: number, amplitude: number, sampleRate = 22050): Int16Array {
  const out = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * amplitude * 32767);
  }
  return out;
}

describe('wav helpers', () => {
  it('round-trips mono PCM16 and rejects anything else', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const wav = encodeMonoPcm16Wav(samples, 22050);
    expect(wav.length).toBe(44 + samples.length * 2);
    const parsed = parseMonoPcm16Wav(wav);
    expect(parsed?.sampleRate).toBe(22050);
    expect(Array.from(parsed?.samples ?? [])).toEqual(Array.from(samples));
    expect(Array.from(pcm16FromBytes(wav.subarray(44)))).toEqual(Array.from(samples));

    const stereo = Buffer.from(wav);
    stereo.writeUInt16LE(2, 22);
    expect(parseMonoPcm16Wav(stereo)).toBeNull();
    expect(parseMonoPcm16Wav(wav.subarray(0, 20))).toBeNull();
    expect(
      parseMonoPcm16Wav(Buffer.from('not a wav file at all, just some text bytes....')),
    ).toBeNull();
    expect(toFloatSamples(Int16Array.from([-32768, 0, 16384]))).toEqual(
      Float32Array.from([-1, 0, 0.5]),
    );
  });

  it('skips extra chunks and tolerates a streamed data size', () => {
    const body = encodeMonoPcm16Wav(Int16Array.from([5, 6, 7]), 16000);
    const list = Buffer.alloc(8 + 5 + 1);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(5, 4); // odd size → padded
    const withList = Buffer.concat([body.subarray(0, 36), list, body.subarray(36)]);
    expect(Array.from(parseMonoPcm16Wav(withList)?.samples ?? [])).toEqual([5, 6, 7]);
    const streamed = Buffer.from(body);
    streamed.writeUInt32LE(0xffffffff, 40);
    expect(Array.from(parseMonoPcm16Wav(streamed)?.samples ?? [])).toEqual([5, 6, 7]);
  });

  it('pads the narration with silence to the whole scene', () => {
    const narration = { samples: new Int16Array(1000).fill(1000), sampleRate: 1000 };
    const wav = sceneAudioWav(narration, { sceneMs: 2000, offsetMs: 300, speechMs: 1000 });
    const parsed = parseMonoPcm16Wav(wav);
    expect(parsed?.samples.length).toBe(2000);
    expect(parsed?.samples[299]).toBe(0);
    expect(parsed?.samples[300]).toBe(1000);
    expect(parsed?.samples[1299]).toBe(1000);
    expect(parsed?.samples[1300]).toBe(0);
    // A narration cut by a fixed scene stops where the scene says, never past its end.
    const cut = parseMonoPcm16Wav(
      sceneAudioWav(narration, { sceneMs: 800, offsetMs: 300, speechMs: 500 }),
    );
    expect(cut?.samples.length).toBe(800);
    expect(cut?.samples[799]).toBe(1000);
    // No narration: pure silence of the scene length; identical bytes every time (cache key).
    const silent = sceneAudioWav(null, { sceneMs: 3000, offsetMs: 0, speechMs: 0 });
    expect(parseMonoPcm16Wav(silent)?.samples.every((s) => s === 0)).toBe(true);
    expect(parseMonoPcm16Wav(silent)?.samples.length).toBe(66150);
    expect(silent.equals(sceneAudioWav(null, { sceneMs: 3000, offsetMs: 0, speechMs: 0 }))).toBe(
      true,
    );
  });
});

describe('soundtrack plan', () => {
  const composition = createComposition({
    scenes: [
      {
        id: 'scn_a',
        script: { kind: 'tts', text: 'uno', voiceId: 'espeak:es-f1', language: 'es' },
      },
      {
        id: 'scn_b',
        duration: { mode: 'fixed', seconds: 1 },
        script: { kind: 'tts', text: 'dos', voiceId: 'espeak:es-f1', language: 'es' },
        background: {
          type: 'video',
          src: { source: 'asset', assetId: 'ast_0000000000000001' },
          volume: 0.5,
          trimStartMs: 250,
          loop: true,
        },
        layers: [
          {
            type: 'video',
            src: { source: 'asset', assetId: 'ast_0000000000000002' },
            box: { x: 0, y: 0, w: 0.5, h: 0.5 },
            volume: 1,
            loop: false,
            trimStartMs: 100,
            timing: { startMs: 200, endMs: 700 },
          },
          {
            type: 'video',
            src: { source: 'asset', assetId: 'ast_0000000000000003' },
            box: { x: 0, y: 0, w: 0.5, h: 0.5 },
            volume: 0,
          },
        ],
      },
      { id: 'scn_c' },
    ],
  });
  composition.music = {
    src: { source: 'stock', stockId: 'music-corporate-rise' },
    volume: 0.4,
    ducking: true,
    fadeInMs: 500,
    fadeOutMs: 1000,
    loop: true,
  };
  const runtime = {
    scenes: {
      scn_a: { audioDurationMs: 2000, visemes: [], words: [] },
      scn_b: { audioDurationMs: 2000, visemes: [], words: [] },
    },
  };
  const timeline = computeTimeline(composition, runtime);

  it('derives ducking windows and an exact sample count from the timeline', () => {
    // scene a: 300 + 2000 + 500; scene b: fixed 1000 (narration cut at 700); scene c: 3000 silent
    expect(timeline.totalMs).toBe(6800);
    expect(soundtrackSamples(timeline)).toBe(timeline.totalFrames * 1600);
    expect(narrationWindows(timeline)).toEqual([
      { startMs: 300, endMs: 2300 },
      { startMs: 3100, endMs: 3800 },
    ]);
  });

  it('computes the music gain: volume, fades and ducking with the shared ramps', () => {
    const music = composition.music;
    if (!music) throw new Error('fixture');
    const env = musicEnvelope(music, narrationWindows(timeline), timeline.totalMs);
    const at = (ms: number) => env[Math.round((ms * ENVELOPE_RATE) / 1000)] ?? NaN;
    expect(env.length).toBe(6800 + ENVELOPE_RATE);
    expect(at(0)).toBe(0);
    // fade-in (250/500) × attack ramp into the ducked gain (100 ms before narration → 2/3 down)
    expect(at(1000)).toBeCloseTo(0.4 * AUDIO_MIX.duckGain, 5); // under narration
    expect(at(2300 + AUDIO_MIX.duckReleaseMs / 2)).toBeCloseTo(
      0.4 * (AUDIO_MIX.duckGain + (1 - AUDIO_MIX.duckGain) / 2),
      2,
    );
    expect(at(4500)).toBeCloseTo(0.4, 5); // silent scene: full volume
    expect(at(6300)).toBeCloseTo(0.4 * 0.5, 2); // halfway through the fade-out
    expect(at(6800)).toBe(0);
    const flat = musicEnvelope({ ...music, ducking: false, fadeInMs: 0, fadeOutMs: 0 }, [], 1000);
    expect(new Set(flat.slice(0, 1000)).size).toBe(1);
  });

  it('lists the sound of video backgrounds and layers on the video clock', () => {
    expect(collectVideoSounds(composition, timeline)).toEqual([
      {
        key: 'asset:ast_0000000000000001',
        startMs: 2800,
        playMs: 1000,
        mediaStartMs: 250,
        loop: true,
        volume: 0.5,
      },
      {
        key: 'asset:ast_0000000000000002',
        startMs: 3000,
        playMs: 500,
        mediaStartMs: 100,
        loop: false,
        volume: 1,
      },
    ]);
  });

  it('builds the ffmpeg graph as an argument array', () => {
    const { args, usesEnvelope } = soundtrackArgs({
      composition,
      timeline,
      narrations: new Map([
        ['scn_a', { path: '/tmp/a.wav', durationMs: 2000 }],
        ['scn_b', { path: '/tmp/b.wav', durationMs: 2000 }],
      ]),
      audio: new Map([
        [
          'stock:music-corporate-rise',
          {
            path: '/stock/m.m4a',
            info: audioInfo(20000),
            aloopFilter: 'aloop=loop=-1:size=960000',
          },
        ],
      ]),
      video: new Map([
        ['asset:ast_0000000000000001', { path: '/tmp/bg.mp4', info: audioInfo(4000) }],
        // No audio stream: contributes nothing.
        ['asset:ast_0000000000000002', { path: '/tmp/layer.mp4', info: audioInfo(4000, false) }],
      ]),
      envelopePath: '/tmp/env.f32',
      outputPath: '/tmp/out.wav',
    });
    expect(usesEnvelope).toBe(true);
    const inputs = args.flatMap((arg, i) => (arg === '-i' ? [args[i + 1]] : []));
    expect(inputs).toEqual([
      '/tmp/a.wav',
      '/tmp/b.wav',
      '/stock/m.m4a',
      '/tmp/env.f32',
      '/tmp/bg.mp4',
    ]);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    const total = soundtrackSamples(timeline);
    // Narration a: untouched; narration b: cut at 700 ms with the shared fade, delayed to 3.1 s.
    expect(graph).toContain(
      `[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,pan=stereo|c0=c0|c1=c0,atrim=end=2.000000,adelay=delays=${0.3 * 48000}S:all=1[n0]`,
    );
    expect(graph).toContain(
      'atrim=end=0.700000,afade=t=out:st=0.580000:d=0.120000,adelay=delays=148800S:all=1[n1]',
    );
    expect(graph).toContain(
      `[2:a:0]aloop=loop=-1:size=960000,aresample=48000,aformat=sample_fmts=fltp,pan=stereo|c0=c0|c1=c0,atrim=end_sample=${total}[m2]`,
    );
    expect(graph).toContain('[m2][e3]amultiply[music]');
    expect(graph).toContain('[4:a:0]atrim=start=0.250000:duration=1.000000,asetpts=PTS-STARTPTS');
    expect(graph).toContain('volume=0.5000,adelay=delays=134400S:all=1[v4]');
    expect(graph).toContain(
      '[n0][n1][music][v4]amix=inputs=4:duration=longest:dropout_transition=0:normalize=0',
    );
    expect(graph.endsWith(`apad=whole_len=${total},atrim=end_sample=${total}[out]`)).toBe(true);
    expect(args.slice(-11)).toEqual([
      '-map',
      '[out]',
      '-c:a',
      'pcm_s16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-f',
      'wav',
      '/tmp/out.wav',
    ]);
    // The looping background input is bounded so ffmpeg never reads it forever.
    expect(args.slice(args.indexOf('/tmp/bg.mp4') - 5, args.indexOf('/tmp/bg.mp4'))).toEqual([
      '-stream_loop',
      '-1',
      '-t',
      '2.250000',
      '-i',
    ]);
  });

  it('falls back to silence when nothing sounds', () => {
    const silent = createComposition();
    const silentTimeline = computeTimeline(silent, { scenes: {} });
    const { args, usesEnvelope } = soundtrackArgs({
      composition: silent,
      timeline: silentTimeline,
      narrations: new Map(),
      audio: new Map(),
      video: new Map(),
      envelopePath: '/tmp/env.f32',
      outputPath: '/tmp/out.wav',
    });
    expect(usesEnvelope).toBe(false);
    expect(args).not.toContain('-i');
    expect(args[args.indexOf('-filter_complex') + 1]).toBe(
      `anullsrc=r=48000:cl=stereo,atrim=end_sample=${soundtrackSamples(silentTimeline)}[out]`,
    );
  });
});

describe('soundtrack mix with real ffmpeg', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-mix-test-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('places narration on the timeline and ducks a looping music track under it', async () => {
    // Narration: 1 s of a 440 Hz tone. Music: 0.5 s of a 3 kHz tone that must loop.
    await fs.writeFile(path.join(dir, 'voice.wav'), encodeMonoPcm16Wav(sine(1, 440, 0.5), 22050));
    await fs.writeFile(
      path.join(dir, 'music.wav'),
      encodeMonoPcm16Wav(sine(0.5, 3000, 0.5), 22050),
    );
    const composition = createComposition({
      scenes: [
        {
          id: 'scn_a',
          paddingStartMs: 1000,
          paddingEndMs: 1000,
          script: { kind: 'tts', text: 'uno', voiceId: 'espeak:es-f1', language: 'es' },
        },
      ],
    });
    composition.music = {
      src: { source: 'asset', assetId: 'ast_0000000000000009' },
      volume: 0.5,
      ducking: true,
      fadeInMs: 0,
      fadeOutMs: 0,
      loop: true,
    };
    const timeline = computeTimeline(composition, {
      scenes: { scn_a: { audioDurationMs: 1000, visemes: [], words: [] } },
    });
    expect(timeline.totalMs).toBe(3000);
    const envelopePath = path.join(dir, 'env.f32');
    const outputPath = path.join(dir, 'mix.wav');
    const music = composition.music;
    const envelope = musicEnvelope(music, narrationWindows(timeline), timeline.totalMs);
    await fs.writeFile(envelopePath, Buffer.from(envelope.buffer));
    const { args } = soundtrackArgs({
      composition,
      timeline,
      narrations: new Map([['scn_a', { path: path.join(dir, 'voice.wav'), durationMs: 1000 }]]),
      audio: new Map([
        ['asset:ast_0000000000000009', { path: path.join(dir, 'music.wav'), info: audioInfo(500) }],
      ]),
      video: new Map(),
      envelopePath,
      outputPath,
    });
    await runFfmpeg(args);

    const info = await ffprobe(outputPath);
    expect(info).toMatchObject({ audioCodec: 'pcm_s16le', sampleRate: 48000, channels: 2 });
    const wav = await fs.readFile(outputPath);
    const dataAt = wav.indexOf(Buffer.from('data', 'ascii')) + 8;
    const pcm = pcm16FromBytes(wav.subarray(dataAt));
    expect(pcm.length / 2).toBe(3 * 48000); // exactly as long as the video
    const left = new Float64Array(pcm.length / 2);
    for (let i = 0; i < left.length; i += 1) left[i] = (pcm[i * 2] ?? 0) / 32768;
    // Amplitude of one frequency in a window (Goertzel-style correlation).
    const tone = (hz: number, fromMs: number, toMs: number) => {
      let re = 0;
      let im = 0;
      const from = Math.round(fromMs * 48);
      const to = Math.round(toMs * 48);
      for (let i = from; i < to; i += 1) {
        re += (left[i] ?? 0) * Math.cos((2 * Math.PI * hz * i) / 48000);
        im += (left[i] ?? 0) * Math.sin((2 * Math.PI * hz * i) / 48000);
      }
      return (2 * Math.hypot(re, im)) / (to - from);
    };
    // Music alone at its volume (0.5 × 0.5), still playing after its 0.5 s file ended once.
    expect(tone(3000, 100, 700)).toBeCloseTo(0.25, 1);
    expect(tone(3000, 2600, 2900)).toBeCloseTo(0.25, 1);
    // Under the narration: ducked to duckGain.
    expect(tone(3000, 1200, 1800)).toBeCloseTo(0.25 * AUDIO_MIX.duckGain, 1);
    expect(tone(3000, 1200, 1800)).toBeLessThan(0.11);
    // Narration at full gain exactly inside its window, absent outside.
    expect(tone(440, 1050, 1950)).toBeCloseTo(0.5, 1);
    expect(tone(440, 200, 950)).toBeLessThan(0.01);
    expect(tone(440, 2050, 2900)).toBeLessThan(0.01);
    // Onset within a millisecond of the timeline (the limiter adds no delay).
    const onset = left.findIndex(
      (_, i) => i > 900 * 48 && Math.abs(tone(440, i / 48, i / 48 + 5)) > 0.2,
    );
    expect(Math.abs(onset / 48 - 1000)).toBeLessThan(6);
  }, 60_000);
});

describe('export arguments and bookkeeping', () => {
  it('encodes H.264 yuv420p + AAC with faststart, and tags AI-generated videos', () => {
    const base = {
      width: 1280,
      height: 720,
      fps: 30,
      soundtrackPath: '/tmp/s.wav',
      outputPath: '/tmp/o.mp4',
    };
    const plain = encodeArgs(base);
    expect(plain.slice(0, 10)).toEqual([
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-video_size',
      '1280x720',
      '-framerate',
      '30',
      '-i',
      'pipe:0',
    ]);
    expect(plain.join(' ')).toContain('-c:v libx264');
    expect(plain.join(' ')).toContain('-pix_fmt yuv420p');
    expect(plain.join(' ')).toContain('-c:a aac');
    expect(plain[plain.indexOf('-movflags') + 1]).toBe('+faststart');
    expect(plain).not.toContain('-metadata');
    expect(plain.at(-1)).toBe('/tmp/o.mp4');

    const tagged = encodeArgs({ ...base, metadata: AI_GENERATED_METADATA });
    expect(tagged[tagged.indexOf('-movflags') + 1]).toBe('+faststart+use_metadata_tags');
    expect(tagged).toContain('com.parlante.ai_generated=true');
    expect(tagged.filter((arg) => arg === '-metadata').length).toBe(
      Object.keys(AI_GENERATED_METADATA).length,
    );
  });

  it('keeps stage percentages monotonic and gives the slow stage most of the bar', () => {
    for (const photoreal of [false, true]) {
      const ranges = stageRanges(photoreal);
      const order = ['prepare', 'audio', 'avatars', 'frames', 'encode', 'finalize'] as const;
      let previous = 0;
      for (const stage of order) {
        const [from, to] = ranges[stage];
        expect(from).toBe(previous);
        expect(to).toBeGreaterThanOrEqual(from);
        previous = to;
      }
      expect(previous).toBe(99);
    }
    const [avatarsFrom, avatarsTo] = stageRanges(true).avatars;
    expect(avatarsTo - avatarsFrom).toBeGreaterThan(60);
    const [instantFrom, instantTo] = stageRanges(false).avatars;
    expect(instantTo - instantFrom).toBe(0);
  });

  it('takes the thumbnail inside the first scene, after entrance animations', () => {
    const one = computeTimeline(createComposition(), { scenes: {} });
    expect(thumbnailTimeMs(one)).toBe(1500);
    const short = computeTimeline(
      createComposition({ scenes: [{ duration: { mode: 'fixed', seconds: 0.5 } }] }),
      { scenes: {} },
    );
    expect(thumbnailTimeMs(short)).toBe(250);
  });
});
