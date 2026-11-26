import fs from 'node:fs/promises';
import { AppError, mediaRefKey, sceneRuntimeFromAudio } from '@parlante/shared';
import type { Composition, ProviderRef, RenderRuntime, Scene } from '@parlante/shared';
import { synthesizeCached } from '@parlante/jobs';
import { runFfmpeg } from '../../lib/ffmpeg';
import type { PreparedMedia } from './media';
import type { RenderRun } from './run';
import { parseMonoPcm16Wav, pcm16FromBytes, toFloatSamples } from './wav';
import type { MonoPcm } from './wav';

/* -------------------------------------------------------------------------------------------
 * Stage `audio` (first half): the narration of every scene and its runtime.
 *   script tts   → synthesizeCached (cache shared with the Studio preview: same WAV, same
 *                  viseme / word timeline the user already saw)
 *   script audio → the uploaded file; words from the transcript, visemes from its envelope
 *                  (`sceneRuntimeFromAudio`, the same function the Studio calls)
 *   script none  → silent scene (absent from the runtime)
 * ----------------------------------------------------------------------------------------- */

/** Sample rate uploaded narration is decoded at for analysis and for the avatar engine. */
const ANALYSIS_SAMPLE_RATE = 22_050;

export interface SceneNarration {
  sceneId: string;
  /** Local audio file ffmpeg mixes into the soundtrack (TTS WAV or the uploaded file). */
  path: string;
  /** Length of the whole narration in ms (`SceneRuntime.audioDurationMs`). */
  durationMs: number;
  /** Mono PCM of the narration (what the avatar engine animates), loaded on first use. */
  pcm(): Promise<MonoPcm>;
}

export interface Narrations {
  runtime: RenderRuntime;
  byScene: Map<string, SceneNarration>;
  /** Voice provider of the video (honesty rule), null when no scene is synthesised. */
  ttsProvider: ProviderRef | null;
}

/** Decode any audio file to mono PCM16 at `sampleRate` with ffmpeg. */
async function decodeMonoPcm(run: RenderRun, file: string, sampleRate: number): Promise<MonoPcm> {
  const out = run.files.temp('pcm', 'raw');
  await runFfmpeg(
    [
      '-i',
      file,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      's16le',
      '-c:a',
      'pcm_s16le',
      out,
    ],
    { signal: run.signal, timeoutMs: 300_000 },
  );
  const bytes = await fs.readFile(out);
  await fs.rm(out, { force: true });
  return { samples: pcm16FromBytes(bytes), sampleRate };
}

function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load();
    return pending;
  };
}

/**
 * When a video mixes voices of different quality, report the BASIC one: the UI must never
 * present a video that contains local "modo básico" speech as premium.
 */
function pickProvider(current: ProviderRef | null, next: ProviderRef): ProviderRef {
  if (!current) return next;
  return current.quality === 'premium' && next.quality === 'basic' ? next : current;
}

async function narrateScene(
  run: RenderRun,
  scene: Scene,
  media: PreparedMedia,
): Promise<{
  narration: SceneNarration;
  runtime: RenderRuntime['scenes'][string];
  provider?: ProviderRef;
} | null> {
  const { ctx, ref, files } = run;
  const script = scene.script;
  if (script.kind === 'tts') {
    if (script.text.trim() === '') return null;
    const speech = await synthesizeCached(
      { db: ctx.db, providers: ctx.providers },
      ref.workspaceId,
      {
        text: script.text,
        voiceId: script.voiceId,
        language: script.language,
        speed: script.speed,
        pitch: script.pitch,
      },
    );
    const file = await files.fromStorage(speech.audioKey);
    return {
      runtime: speech.runtime,
      provider: speech.provider,
      narration: {
        sceneId: scene.id,
        path: file,
        durationMs: speech.runtime.audioDurationMs,
        pcm: lazy(async () => {
          // Providers return PCM16 mono WAV; anything else goes through ffmpeg.
          const parsed = parseMonoPcm16Wav(await fs.readFile(file));
          return parsed ?? decodeMonoPcm(run, file, ANALYSIS_SAMPLE_RATE);
        }),
      },
    };
  }
  if (script.kind === 'audio') {
    const file = media.audio.get(mediaRefKey({ source: 'asset', assetId: script.assetId }));
    if (!file) {
      throw new AppError('UNPROCESSABLE', 'The narration audio of a scene is missing', {
        sceneId: scene.id,
        assetId: script.assetId,
      });
    }
    const pcm = await decodeMonoPcm(run, file.path, ANALYSIS_SAMPLE_RATE);
    const durationMs = Math.round((pcm.samples.length * 1000) / pcm.sampleRate);
    if (durationMs <= 0) return null;
    return {
      runtime: sceneRuntimeFromAudio({
        audioDurationMs: durationMs,
        transcript: script.transcript,
        language: script.language,
        samples: toFloatSamples(pcm.samples),
        sampleRate: pcm.sampleRate,
      }),
      narration: {
        sceneId: scene.id,
        path: file.path,
        durationMs,
        pcm: () => Promise.resolve(pcm),
      },
    };
  }
  return null;
}

export async function buildNarrations(
  run: RenderRun,
  composition: Composition,
  media: PreparedMedia,
): Promise<Narrations> {
  const runtime: RenderRuntime = { scenes: {} };
  const byScene = new Map<string, SceneNarration>();
  let ttsProvider: ProviderRef | null = null;
  let done = 0;
  for (const scene of composition.scenes) {
    await run.cancel.check();
    const result = await narrateScene(run, scene, media);
    if (result) {
      runtime.scenes[scene.id] = result.runtime;
      byScene.set(scene.id, result.narration);
      if (result.provider) ttsProvider = pickProvider(ttsProvider, result.provider);
    }
    done += 1;
    // The mix (second half of the stage) takes the last tenth of the bar.
    await run.progress.update('audio', (done / composition.scenes.length) * 0.9);
  }
  return { runtime, byScene, ttsProvider };
}
