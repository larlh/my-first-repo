import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  SubtitleStyleSchema,
  creditsForTranslation,
  newId,
  parseSubtitles,
} from '@parlante/shared';
import type {
  LanguageCode,
  STTProvider,
  TTSProvider,
  TimedText,
  TranslationOptions,
  TranslationProvider,
} from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import {
  assets,
  chargeCredits,
  creditLedger,
  eq,
  getCreditBalance,
  netCharged,
  translationJobs,
  translationOutputs,
} from '@parlante/db';
import { seedAccount } from '@parlante/db/testing';
import {
  createLocalWhisperStt,
  disposeWhisperEngines,
  isLocalWhisperInstalled,
  providerEnvSchema,
} from '@parlante/providers';
import { createNodeCanvas, loadNodeImage } from '@parlante/renderer/node';
import { ffprobe, runFfmpeg } from '../../lib/ffmpeg';
import { createTempDir } from '../../lib/tmp';
import { createTestWorker } from '../../testing/index';
import type { TestWorker } from '../../testing/index';
import {
  MAX_TEMPO,
  MAX_VOICE_SPEED,
  SLOT_GAP_MS,
  dubSegments,
  dubSlots,
  fitFilters,
  planFastTake,
  planNaturalTake,
} from './dub';
import job from './index';
import { burnFrameSize, canCopyVideo, mixArguments } from './mix';
import type { SourceVideo } from './mix';
import { finishTranslation } from './status';
import { dubSubtitleCues, estimateWords, renderSubtitleOverlay } from './subtitles';
import { tidySegments } from './transcript';

/* -------------------------------------------------------------------------------------------
 * The translation job against the real thing: test database, local storage, ffmpeg, the local
 * TTS (eSpeak) and the local translation provider. The source is a 10 s video generated with
 * ffmpeg whose audio is real Spanish speech over a quiet tone (so "attenuate" and "replace"
 * the original audio can be told apart by measuring loudness).
 *
 * Set PARLANTE_KEEP_OUTPUT=<dir> to keep the produced videos and frames for inspection.
 * ----------------------------------------------------------------------------------------- */

const DURATION_MS = 10_000;
const WIDTH = 640;
const HEIGHT = 360;
const LINES = [
  { atMs: 500, text: 'Hola, bienvenidos a esta demostración de Parlante.' },
  { atMs: 4000, text: 'Hoy vamos a traducir este vídeo a otros idiomas.' },
  { atMs: 7300, text: 'Gracias por vernos.' },
];

let t: TestWorker;
let fixtureDir: string;
let sourceFile: string;
let transcript: TimedText[];
const voices = new Map<string, string>();
const keepDir = process.env.PARLANTE_KEEP_OUTPUT;

async function voiceFor(language: string): Promise<string> {
  const known = voices.get(language);
  if (known) return known;
  const tts = t.ctx.providers.tts.default;
  const voice = (await tts.listVoices()).find((v) => v.language.startsWith(language));
  if (!voice) throw new Error(`The local TTS has no ${language} voice`);
  const id = `${tts.info.id}:${voice.providerVoiceId}`;
  voices.set(language, id);
  return id;
}

/** 10 s test pattern with Spanish speech at known times over a quiet 220 Hz tone. */
async function buildSource(dir: string): Promise<void> {
  const tts = t.ctx.providers.tts.default;
  const voice = (await voiceFor('es')).split(':')[1] ?? '';
  transcript = [];
  const inputs: string[] = [];
  const delays: string[] = [];
  for (const [index, line] of LINES.entries()) {
    const speech = await tts.synthesize({
      text: line.text,
      providerVoiceId: voice,
      language: 'es',
      speed: 1,
      pitch: 0,
    });
    const file = path.join(dir, `line${index}.wav`);
    await fs.writeFile(file, speech.audio);
    inputs.push('-i', file);
    delays.push(`[${index + 2}:a]adelay=${line.atMs}[s${index}]`);
    transcript.push({
      startMs: line.atMs,
      endMs: Math.min(DURATION_MS, line.atMs + Math.round(speech.durationMs)),
      text: line.text,
    });
  }
  sourceFile = path.join(dir, 'source.mp4');
  await runFfmpeg([
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${WIDTH}x${HEIGHT}:rate=30:duration=10`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=48000:duration=10',
    ...inputs,
    '-filter_complex',
    `[1:a]volume=0.1[bed];${delays.join(';')};[bed]${LINES.map((_, i) => `[s${i}]`).join('')}amix=inputs=${LINES.length + 1}:normalize=0:duration=first[a]`,
    '-map',
    '0:v',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-t',
    '10',
    sourceFile,
  ]);
}

beforeAll(async () => {
  t = await createTestWorker({ MODERATION_EXTRA_BLOCKLIST: 'zarandajas' });
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-translation-fixture-'));
  await buildSource(fixtureDir);
  if (keepDir) await fs.mkdir(keepDir, { recursive: true });
}, 120_000);
afterAll(async () => {
  await t.close();
  await fs.rm(fixtureDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await t.reset();
  vi.restoreAllMocks();
});

interface SeedOptions {
  targets?: LanguageCode[];
  options?: Partial<TranslationOptions>;
  /** null = no transcript on the row (STT path). */
  transcript?: TimedText[] | null;
  voices?: Partial<Record<LanguageCode, string>>;
  credits?: number;
}

/** A translation exactly as `POST /api/translations` leaves it. */
async function seedTranslation(seed: SeedOptions = {}) {
  const targets = seed.targets ?? ['en'];
  const account = await seedAccount(t.ctx.db, { credits: seed.credits ?? 40 });
  const workspaceId = account.workspace.id;
  const assetId = newId('asset');
  const storageKey = storageKeys.asset(workspaceId, assetId, 'mp4');
  await t.ctx.providers.storage.put(
    storageKey,
    { filePath: sourceFile },
    { contentType: 'video/mp4' },
  );
  await t.ctx.db.insert(assets).values({
    id: assetId,
    workspaceId,
    kind: 'video',
    purpose: 'translation_source',
    name: 'demo.mp4',
    mimeType: 'video/mp4',
    sizeBytes: (await fs.stat(sourceFile)).size,
    width: WIDTH,
    height: HEIGHT,
    durationMs: DURATION_MS,
    storageKey,
  });
  const translationJobId = newId('translationJob');
  const cost = creditsForTranslation(DURATION_MS, targets.length);
  const rows = seed.transcript === undefined ? transcript : seed.transcript;
  const outputIds = new Map<LanguageCode, string>();
  await t.ctx.db.transaction(async (tx) => {
    await chargeCredits(tx, {
      workspaceId,
      amount: cost,
      reason: 'translation',
      refType: 'translationJob',
      refId: translationJobId,
    });
    await tx.insert(translationJobs).values({
      id: translationJobId,
      workspaceId,
      name: 'Demo de producto',
      sourceAssetId: assetId,
      sourceDurationMs: DURATION_MS,
      sourceLanguage: 'es',
      targetLanguages: targets,
      status: 'queued',
      transcriptSource: rows ? 'user' : 'stt',
      transcript: rows,
      options: { originalAudioVolume: 0.08, burnSubtitles: false, ...seed.options },
      creditsCharged: cost,
      createdBy: account.user.id,
    });
    for (const language of targets) {
      const id = newId('translationOutput');
      outputIds.set(language, id);
      await tx.insert(translationOutputs).values({
        id,
        workspaceId,
        jobId: translationJobId,
        language,
        voiceId: seed.voices?.[language] ?? (await voiceFor(language)),
      });
    }
  });
  return {
    workspaceId,
    translationJobId,
    cost,
    outputIds,
    payload: { translationJobId, workspaceId },
  };
}

async function state(seeded: { translationJobId: string }) {
  const [row] = await t.ctx.db
    .select()
    .from(translationJobs)
    .where(eq(translationJobs.id, seeded.translationJobId));
  const outputs = await t.ctx.db
    .select()
    .from(translationOutputs)
    .where(eq(translationOutputs.jobId, seeded.translationJobId));
  return { job: row, outputs: new Map(outputs.map((o) => [o.language, o])) };
}

const charged = async (seeded: { workspaceId: string; translationJobId: string }) =>
  (await netCharged(t.ctx.db, seeded.workspaceId, {
    refType: 'translationJob',
    refId: seeded.translationJobId,
  })) + 0;

function localFile(key: string | null | undefined): string {
  const file = key ? t.ctx.providers.storage.localPath(key) : null;
  if (!file) throw new Error(`no local file for ${String(key)}`);
  return file;
}

/** Mean loudness (dBFS) of a stretch of the audio of a file. */
async function meanVolumeDb(file: string, startSec: number, durationSec: number): Promise<number> {
  const { stderrTail } = await runFfmpeg([
    '-ss',
    String(startSec),
    '-t',
    String(durationSec),
    '-i',
    file,
    '-map',
    '0:a:0',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  const match = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderrTail);
  if (!match?.[1]) throw new Error(`volumedetect gave no result: ${stderrTail}`);
  return match[1] === '-inf' ? -120 : Number(match[1]);
}

/** One frame of a video as RGBA pixels. */
async function frameAt(file: string, sec: number, name: string) {
  const out = path.join(keepDir ?? fixtureDir, `${name}.png`);
  await runFfmpeg(['-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1', out]);
  const image = await loadNodeImage(out);
  const { ctx } = createNodeCanvas(image.width, image.height);
  ctx.drawImage(image.source, 0, 0);
  return { width: image.width, height: image.height, ctx };
}

/** Mean absolute difference (0..255) between two frames inside a horizontal band. */
function bandDifference(
  a: Awaited<ReturnType<typeof frameAt>>,
  b: Awaited<ReturnType<typeof frameAt>>,
  fromY: number,
  toY: number,
): number {
  const y = Math.round(fromY * a.height);
  const h = Math.round((toY - fromY) * a.height);
  const pa = a.ctx.getImageData(0, y, a.width, h).data;
  const pb = b.ctx.getImageData(0, y, b.width, h).data;
  let sum = 0;
  for (let i = 0; i < pa.length; i += 4) {
    sum += Math.abs((pa[i] ?? 0) - (pb[i] ?? 0));
    sum += Math.abs((pa[i + 1] ?? 0) - (pb[i + 1] ?? 0));
    sum += Math.abs((pa[i + 2] ?? 0) - (pb[i + 2] ?? 0));
  }
  return sum / ((pa.length / 4) * 3);
}

async function keep(file: string, name: string): Promise<void> {
  if (keepDir) await fs.copyFile(file, path.join(keepDir, name));
}

async function videoStreamMd5(file: string): Promise<string> {
  const { stdout } = await runFfmpeg([
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:v:0',
    '-c',
    'copy',
    '-f',
    'md5',
    '-',
  ]);
  return stdout.toString('utf8').trim();
}

describe('translation job — real run with local providers', () => {
  it('dubs a video into English with burned-in subtitles, SRT and VTT', async () => {
    const seeded = await seedTranslation({ options: { burnSubtitles: true } });
    let during: Awaited<ReturnType<typeof state>> | undefined;
    const translate = t.ctx.providers.translation.translate.bind(t.ctx.providers.translation);
    vi.spyOn(t.ctx.providers.translation, 'translate').mockImplementation(async (request) => {
      during = await state(seeded);
      return translate(request);
    });
    const { result, progress } = await t.run(job, seeded.payload);

    expect(result).toEqual({
      translationJobId: seeded.translationJobId,
      completedLanguages: ['en'],
      failedLanguages: [],
    });
    // Queue progress (throttled) starts with the transcription and is tagged with the language.
    expect(progress[0]?.stage).toBe('transcribing');
    expect(progress.some((p) => p.stage !== 'transcribing')).toBe(true);
    // Per-language stages carry their language. The closing report (`finalizing` at 100 %) covers
    // the whole job, so it has none; whether the recorder sees it depends on timing.
    const closing = (p: (typeof progress)[number]) =>
      p.stage === 'finalizing' && p.percent === 100 && p.language === undefined;
    expect(
      progress
        .filter((p) => p.stage !== 'transcribing' && !closing(p))
        .every((p) => p.language === 'en'),
    ).toBe(true);
    // What clients poll is the ROW: stage, progress and the state of each language.
    expect(during?.job).toMatchObject({ status: 'processing', stage: 'translating' });
    expect(during?.job?.progress).toBeGreaterThan(0);
    expect(during?.outputs.get('en')?.status).toBe('processing');
    const percents = progress.map((p) => p.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));

    const { job: row, outputs } = await state(seeded);
    expect(row).toMatchObject({ status: 'completed', stage: null, progress: 100, error: null });
    expect(row?.creditsCharged).toBe(seeded.cost);
    // Honesty rule: which providers did the work (both are the basic, local ones here).
    expect(row?.providers?.translation).toMatchObject({ id: 'local', quality: 'basic' });
    expect(row?.providers?.tts).toMatchObject({ id: 'espeak', local: true });
    expect(row?.providers?.stt).toBeUndefined(); // the transcript came from the user

    const en = outputs.get('en');
    expect(en).toMatchObject({
      status: 'completed',
      error: null,
      videoKey: storageKeys.translationOutput(
        seeded.workspaceId,
        seeded.translationJobId,
        'en',
        'video.mp4',
      ),
      srtKey: storageKeys.translationOutput(
        seeded.workspaceId,
        seeded.translationJobId,
        'en',
        'subtitles.srt',
      ),
      vttKey: storageKeys.translationOutput(
        seeded.workspaceId,
        seeded.translationJobId,
        'en',
        'subtitles.vtt',
      ),
    });
    // Translated segments keep the timing of the source.
    expect(en?.segments?.map((s) => [s.startMs, s.endMs])).toEqual(
      transcript.map((s) => [s.startMs, s.endMs]),
    );
    expect(en?.segments?.every((s) => s.text.length > 0)).toBe(true);
    expect(en?.segments?.[2]?.text.toLowerCase()).toContain('thank');

    /* ---- the MP4 ---- */
    const video = localFile(en?.videoKey);
    await keep(video, 'en-burned.mp4');
    const info = await ffprobe(video);
    expect(info).toMatchObject({
      hasVideo: true,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: WIDTH,
      height: HEIGHT,
      sampleRate: 48000,
      channels: 2,
    });
    expect(Math.abs((info.durationMs ?? 0) - DURATION_MS)).toBeLessThan(200);
    expect(info.formatName).toContain('mp4');

    /* ---- subtitles: files ---- */
    const srtText = Buffer.from(await t.ctx.providers.storage.get(en?.srtKey ?? '')).toString(
      'utf8',
    );
    const vttText = Buffer.from(await t.ctx.providers.storage.get(en?.vttKey ?? '')).toString(
      'utf8',
    );
    const cues = parseSubtitles(srtText);
    expect(vttText.startsWith('WEBVTT\n\n')).toBe(true);
    expect(parseSubtitles(vttText)).toEqual(cues);
    expect(cues.length).toBeGreaterThanOrEqual(3);
    // Cues follow the dub: inside the video, in order, never overlapping, first one where the
    // first sentence starts.
    expect(cues[0]?.startMs).toBeGreaterThanOrEqual(500);
    expect(cues[0]?.startMs).toBeLessThan(900);
    for (const [i, cue] of cues.entries()) {
      expect(cue.endMs).toBeGreaterThan(cue.startMs);
      expect(cue.endMs).toBeLessThanOrEqual(DURATION_MS);
      const next = cues[i + 1];
      if (next) expect(cue.endMs).toBeLessThanOrEqual(next.startMs);
    }
    expect(
      cues
        .map((c) => c.text)
        .join(' ')
        .toLowerCase(),
    ).toContain('thank');

    /* ---- subtitles: burned into the picture where a cue is showing, and only there ---- */
    const first = cues[0];
    if (!first) throw new Error('no cues');
    const cueSec = (first.startMs + first.endMs) / 2000;
    const withCue = await frameAt(video, cueSec, 'en-burned-cue');
    const sourceAtCue = await frameAt(sourceFile, cueSec, 'source-cue');
    const style = SubtitleStyleSchema.parse({});
    expect(style.position).toBe('bottom');
    const band = bandDifference(withCue, sourceAtCue, 0.72, 0.96);
    const top = bandDifference(withCue, sourceAtCue, 0.05, 0.5);
    expect(band).toBeGreaterThan(12); // the subtitle box changed the bottom of the frame
    expect(top).toBeLessThan(6); // the rest is the original picture (re-encoded)
    // Before the first cue (it starts at ≥ 0.5 s) nothing is painted.
    const quiet = await frameAt(video, 0.2, 'en-burned-gap');
    const sourceQuiet = await frameAt(sourceFile, 0.2, 'source-gap');
    expect(bandDifference(quiet, sourceQuiet, 0.72, 0.96)).toBeLessThan(6);

    /* ---- audio: the dub speaks, the original stays quietly underneath ---- */
    const speechDb = await meanVolumeDb(video, 0.6, 2);
    const gapDb = await meanVolumeDb(video, 9.4, 0.5);
    const sourceGapDb = await meanVolumeDb(sourceFile, 9.4, 0.5);
    expect(speechDb).toBeGreaterThan(-35);
    // Original at 8 % ≈ −22 dB under its own level (the bed tone is all there is at 9.4 s).
    expect(gapDb).toBeLessThan(sourceGapDb - 15);
    expect(gapDb).toBeGreaterThan(sourceGapDb - 30);

    // A completed translation keeps its price.
    expect(await charged(seeded)).toBe(seeded.cost);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(40 - seeded.cost);
  }, 120_000);

  it('replaces the original voice when its volume is 0 and copies the picture untouched', async () => {
    const seeded = await seedTranslation({ options: { originalAudioVolume: 0 } });
    await t.run(job, seeded.payload);
    const video = localFile((await state(seeded)).outputs.get('en')?.videoKey);
    await keep(video, 'en-replaced.mp4');

    // No subtitles to burn and an H.264 source: the video stream is copied bit for bit.
    expect(await videoStreamMd5(video)).toBe(await videoStreamMd5(sourceFile));
    // Nothing of the original audio is left: where nobody is dubbed there is silence…
    expect(await meanVolumeDb(video, 9.4, 0.5)).toBeLessThan(-70);
    // …and the dub is there.
    expect(await meanVolumeDb(video, 0.6, 2)).toBeGreaterThan(-35);
  }, 120_000);

  it('burns subtitles upright on a phone video that carries a rotation', async () => {
    // The same picture flagged as rotated 90°: players (and ffmpeg) show it as 360 × 640.
    const rotated = path.join(fixtureDir, 'rotated.mp4');
    await runFfmpeg([
      '-v',
      'error',
      '-display_rotation',
      '90',
      '-i',
      sourceFile,
      '-c',
      'copy',
      rotated,
    ]);
    const upright = sourceFile;
    sourceFile = rotated;
    try {
      const seeded = await seedTranslation({ options: { burnSubtitles: true } });
      await t.run(job, seeded.payload);
      const output = (await state(seeded)).outputs.get('en');
      expect(output?.status).toBe('completed');
      const video = localFile(output?.videoKey);
      await keep(video, 'en-rotated.mp4');
      const frame = await frameAt(video, 2, 'en-rotated-cue');
      expect([frame.width, frame.height]).toEqual([HEIGHT, WIDTH]);
      const info = await ffprobe(video);
      expect(info).toMatchObject({ videoCodec: 'h264', width: HEIGHT, height: WIDTH });
      // The subtitle sits at the bottom of the DISPLAYED (portrait) picture.
      const reference = await frameAt(rotated, 2, 'rotated-source-cue');
      expect(bandDifference(frame, reference, 0.8, 0.96)).toBeGreaterThan(10);
      expect(bandDifference(frame, reference, 0.05, 0.6)).toBeLessThan(6);
    } finally {
      sourceFile = upright;
    }
  }, 120_000);

  it('produces one output per target language', async () => {
    const seeded = await seedTranslation({ targets: ['en', 'fr'] });
    const { result, progress } = await t.run(job, seeded.payload);

    expect(result.completedLanguages).toEqual(['en', 'fr']);
    expect(new Set(progress.map((p) => p.language).filter(Boolean))).toEqual(new Set(['en', 'fr']));
    const { job: row, outputs } = await state(seeded);
    expect(row).toMatchObject({ status: 'completed', progress: 100, creditsCharged: 4 });
    for (const language of ['en', 'fr'] as const) {
      const output = outputs.get(language);
      expect(output?.status).toBe('completed');
      const info = await ffprobe(localFile(output?.videoKey));
      expect(info).toMatchObject({ hasVideo: true, hasAudio: true });
      expect(output?.videoKey).toContain(`/${language}/video.mp4`);
    }
    await keep(localFile(outputs.get('fr')?.videoKey), 'fr.mp4');
    const frSegments = outputs.get('fr')?.segments ?? [];
    const enSegments = outputs.get('en')?.segments ?? [];
    expect(frSegments[2]?.text).not.toBe(enSegments[2]?.text);
    expect(frSegments[2]?.text.toLowerCase()).toContain('merci');
    expect(await charged(seeded)).toBe(4);
  }, 180_000);
});

describe('translation job — failures, credits and idempotency', () => {
  it('partial success: the language that fails is refunded, the other is delivered', async () => {
    const seeded = await seedTranslation({
      targets: ['en', 'fr'],
      voices: { fr: 'ghost-provider:nobody' },
    });
    const { result } = await t.run(job, seeded.payload);

    expect(result).toEqual({
      translationJobId: seeded.translationJobId,
      completedLanguages: ['en'],
      failedLanguages: ['fr'],
    });
    const { job: row, outputs } = await state(seeded);
    expect(row).toMatchObject({ status: 'partial', stage: null, progress: 100, error: null });
    expect(outputs.get('en')?.status).toBe('completed');
    expect(outputs.get('fr')).toMatchObject({ status: 'failed', videoKey: null });
    expect(outputs.get('fr')?.error?.code).toBe('PROVIDER_NOT_CONFIGURED');

    // Reserved 2 languages × 2 credits; settled to the one that completed.
    expect(seeded.cost).toBe(4);
    expect(await charged(seeded)).toBe(2);
    expect(row?.creditsCharged).toBe(2);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(38);
    const ledger = await t.ctx.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.refId, seeded.translationJobId));
    expect(ledger.map((e) => [e.reason, e.delta]).sort()).toEqual([
      ['adjustment', 2],
      ['translation', -4],
    ]);
  }, 120_000);

  it('fails and refunds everything when no language can be produced', async () => {
    const seeded = await seedTranslation({ voices: { en: 'ghost-provider:nobody' } });
    await expect(t.run(job, seeded.payload)).rejects.toThrow(/PROVIDER_NOT_CONFIGURED|not active/);

    const { job: row, outputs } = await state(seeded);
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(row?.creditsCharged).toBe(0);
    expect(outputs.get('en')?.status).toBe('failed');
    expect(await charged(seeded)).toBe(0);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(40);
    // Nothing was published.
    expect(
      await t.ctx.providers.storage.exists(
        storageKeys.translationOutput(
          seeded.workspaceId,
          seeded.translationJobId,
          'en',
          'video.mp4',
        ),
      ),
    ).toBe(false);

    // The safety net after the handler's own failure path changes nothing more.
    await job.onFinalFailure?.(t.ctx, seeded.payload, { code: 'INTERNAL', message: 'again' });
    expect((await state(seeded)).job?.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(40);
  });

  it('without a transcript and with the manual STT provider it fails with TRANSCRIPT_REQUIRED', async () => {
    const seeded = await seedTranslation({ transcript: null });
    expect(t.ctx.providers.stt.requiresUserTranscript).toBe(true);
    await expect(t.run(job, seeded.payload)).rejects.toThrow(/TRANSCRIPT_REQUIRED/);
    const { job: row, outputs } = await state(seeded);
    expect(row).toMatchObject({ status: 'failed', creditsCharged: 0 });
    expect(row?.error?.code).toBe('TRANSCRIPT_REQUIRED');
    expect(outputs.get('en')?.error?.code).toBe('TRANSCRIPT_REQUIRED');
    expect(await charged(seeded)).toBe(0);
  });

  it('transcribes with the STT provider when the user gave no transcript, and moderates it', async () => {
    const realStt = t.ctx.providers.stt;
    const requests: { bytes: number; audioPath?: string; language?: string }[] = [];
    let heard: TimedText[] = transcript;
    const stt: STTProvider = {
      info: { id: 'fake-stt', name: 'Fake STT', quality: 'premium', local: false },
      requiresUserTranscript: false,
      async transcribe(request) {
        // WAV PCM 16 kHz mono, as the provider contract says.
        const probe = await ffprobe(request.audioPath ?? '');
        expect(probe).toMatchObject({ audioCodec: 'pcm_s16le', sampleRate: 16000, channels: 1 });
        expect(Buffer.from(request.audio.subarray(0, 4)).toString()).toBe('RIFF');
        requests.push({
          bytes: request.audio.length,
          audioPath: request.audioPath,
          language: request.language,
        });
        return { segments: heard, language: 'es', provider: stt.info };
      },
    };
    t.ctx.providers.stt = stt;
    try {
      const seeded = await seedTranslation({ transcript: null });
      const { result } = await t.run(job, seeded.payload);
      expect(result.completedLanguages).toEqual(['en']);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.language).toBe('es');
      expect(requests[0]?.bytes).toBeGreaterThan(300_000); // ≈ 10 s × 16 kHz × 2 bytes
      const { job: row } = await state(seeded);
      expect(row?.status).toBe('completed');
      expect(row?.transcript).toEqual(transcript); // kept on the row
      expect(row?.providers?.stt).toMatchObject({ id: 'fake-stt' });

      // What the STT heard is moderated before anything is dubbed.
      heard = [{ startMs: 500, endMs: 3000, text: 'Esto son zarandajas prohibidas.' }];
      const blocked = await seedTranslation({ transcript: null });
      await expect(t.run(job, blocked.payload)).rejects.toThrow(/CONTENT_BLOCKED/);
      expect((await state(blocked)).job).toMatchObject({ status: 'failed', creditsCharged: 0 });
      expect(await charged(blocked)).toBe(0);
    } finally {
      t.ctx.providers.stt = realStt;
    }
  }, 120_000);

  // [slow] The same path with the REAL local speech model (skipped when it is not installed:
  // `pnpm dictation:setup`). The harness keeps `auto` on the manual provider, so the real one
  // is put in place by hand, exactly as `createProviders` does on a machine with the model.
  const speechEnv = providerEnvSchema.parse({});
  it.skipIf(!isLocalWhisperInstalled(speechEnv))(
    '[slow] transcribes the video with the local Whisper model when the user gave no transcript',
    async () => {
      const realStt = t.ctx.providers.stt;
      const whisper = createLocalWhisperStt(speechEnv);
      expect(whisper.requiresUserTranscript).toBe(false);
      t.ctx.providers.stt = whisper;
      try {
        const seeded = await seedTranslation({ transcript: null });
        const { result } = await t.run(job, seeded.payload);
        expect(result.completedLanguages).toEqual(['en']);
        const { job: row, outputs } = await state(seeded);
        expect(row?.status).toBe('completed');
        expect(row?.transcriptSource).toBe('stt');
        // Honesty: the row says which provider heard the video, and that it is the basic one.
        expect(row?.providers?.stt).toEqual({
          id: 'local-whisper',
          name: 'Whisper base (local)',
          quality: 'basic',
          local: true,
        });
        // Timed segments inside the 10 s of the video, in order. The words are whatever a
        // small model makes of a robotic voice over a tone: only their shape is asserted.
        const heard = row?.transcript ?? [];
        expect(heard.length).toBeGreaterThanOrEqual(1);
        let previous = -1;
        for (const segment of heard) {
          expect(segment.text.trim()).not.toBe('');
          expect(segment.startMs).toBeGreaterThanOrEqual(previous);
          expect(segment.endMs).toBeGreaterThan(segment.startMs);
          expect(segment.endMs).toBeLessThanOrEqual(DURATION_MS);
          previous = segment.startMs;
        }
        expect(
          heard
            .map((segment) => segment.text)
            .join(' ')
            .split(/\s+/).length,
        ).toBeGreaterThan(5);
        // The dub was produced from that transcript.
        const english = outputs.get('en');
        expect(english?.status).toBe('completed');
        expect(await ffprobe(localFile(english?.videoKey))).toMatchObject({ hasAudio: true });
      } finally {
        t.ctx.providers.stt = realStt;
        await disposeWhisperEngines();
      }
    },
    240_000,
  );

  it('moderates the TRANSLATED text before dubbing: a blocked language fails, nothing of it is spoken', async () => {
    const realTranslation = t.ctx.providers.translation;
    const realTts = t.ctx.providers.tts;
    const spoken: string[] = [];
    t.ctx.providers.translation = {
      info: { id: 'fake-llm', name: 'Fake translator', quality: 'premium', local: false },
      // The source passed moderation; the French translation introduces a blocked term.
      translate: (request) =>
        Promise.resolve({
          texts: request.texts.map((text, index) =>
            request.targetLanguage === 'fr' ? `Zarandajas ${index}` : `Line ${index}: ${text}`,
          ),
          provider: { id: 'fake-llm', name: 'Fake translator', quality: 'premium', local: false },
        }),
    };
    const wrap = (tts: TTSProvider): TTSProvider => ({
      ...tts,
      info: tts.info,
      listVoices: () => tts.listVoices(),
      synthesize: (request) => {
        spoken.push(request.text);
        return tts.synthesize(request);
      },
    });
    t.ctx.providers.tts = {
      default: wrap(realTts.default),
      get: (id) => {
        const found = realTts.get(id);
        return found ? wrap(found) : null;
      },
      all: () => realTts.all().map(wrap),
    };
    try {
      const seeded = await seedTranslation({ targets: ['en', 'fr'] });
      const { result } = await t.run(job, seeded.payload);
      expect(result.completedLanguages).toEqual(['en']);
      expect(result.failedLanguages).toEqual(['fr']);
      const { outputs } = await state(seeded);
      expect(outputs.get('fr')).toMatchObject({ status: 'failed', videoKey: null, segments: null });
      expect(outputs.get('fr')?.error?.code).toBe('CONTENT_BLOCKED');
      // Not one blocked line reached the voice provider or the storage.
      expect(spoken.length).toBeGreaterThan(0);
      expect(spoken.some((text) => /zarandajas/i.test(text))).toBe(false);
      expect(
        await t.ctx.providers.storage.exists(
          storageKeys.translationOutput(
            seeded.workspaceId,
            seeded.translationJobId,
            'fr',
            'video.mp4',
          ),
        ),
      ).toBe(false);
      // Only the language that was delivered is paid for.
      expect(await charged(seeded)).toBe(2);
    } finally {
      t.ctx.providers.translation = realTranslation;
      t.ctx.providers.tts = realTts;
    }
  }, 120_000);

  it('is idempotent: finished jobs are not processed again and a re-run only does what is missing', async () => {
    const seeded = await seedTranslation({ targets: ['en', 'fr'] });
    const translate = vi.spyOn(t.ctx.providers.translation, 'translate');
    await t.run(job, seeded.payload);
    expect(translate.mock.calls.map(([request]) => request.targetLanguage)).toEqual(['en', 'fr']);

    // Finished: a duplicate delivery does nothing and charges nothing.
    const again = await t.run(job, seeded.payload);
    expect(again.result.completedLanguages).toEqual(['en', 'fr']);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(await charged(seeded)).toBe(4);

    // A worker that died while it was doing French: `processing`, en done, fr half-way.
    const frId = seeded.outputIds.get('fr') ?? '';
    await t.ctx.db
      .update(translationJobs)
      .set({ status: 'processing', stage: 'dubbing', progress: 70 })
      .where(eq(translationJobs.id, seeded.translationJobId));
    await t.ctx.db
      .update(translationOutputs)
      .set({ status: 'processing', videoKey: null, srtKey: null, vttKey: null })
      .where(eq(translationOutputs.id, frId));
    const enBefore = (await state(seeded)).outputs.get('en');
    const synthesize = vi.spyOn(t.ctx.providers.tts.default, 'synthesize');

    const resumed = await t.run(job, seeded.payload);
    expect(resumed.result.completedLanguages).toEqual(['en', 'fr']);
    expect(translate).toHaveBeenCalledTimes(3);
    expect(translate.mock.calls[2]?.[0].targetLanguage).toBe('fr'); // English was skipped
    expect(synthesize).not.toHaveBeenCalled(); // every narration came from the TTS cache
    const after = await state(seeded);
    expect(after.job).toMatchObject({ status: 'completed', progress: 100 });
    expect(after.outputs.get('en')?.updatedAt).toEqual(enBefore?.updatedAt);
    expect(after.outputs.get('fr')?.status).toBe('completed');
    expect(await charged(seeded)).toBe(4);
  }, 180_000);

  it('stops quietly and removes its files when the job is cancelled while it runs', async () => {
    for (const mode of ['canceled', 'deleted'] as const) {
      const seeded = await seedTranslation({ targets: ['en', 'fr'] });
      const provider: TranslationProvider = t.ctx.providers.translation;
      const original = provider.translate.bind(provider);
      vi.spyOn(provider, 'translate').mockImplementation(async (request) => {
        if (request.targetLanguage === 'fr') {
          // DELETE /api/translations/:id while French is being translated.
          if (mode === 'canceled') {
            await t.ctx.db
              .update(translationJobs)
              .set({ status: 'canceled', creditsCharged: 0 })
              .where(eq(translationJobs.id, seeded.translationJobId));
          } else {
            await t.ctx.db
              .delete(translationJobs)
              .where(eq(translationJobs.id, seeded.translationJobId));
          }
        }
        return original(request);
      });
      const balance = await getCreditBalance(t.ctx.db, seeded.workspaceId);

      const { result } = await t.run(job, seeded.payload);
      expect(result).toEqual({
        translationJobId: seeded.translationJobId,
        completedLanguages: [],
        failedLanguages: [],
      });
      // Not even the English output that had been stored survives a cancellation.
      const prefix = localFile(
        storageKeys.translationOutput(
          seeded.workspaceId,
          seeded.translationJobId,
          'en',
          'video.mp4',
        ),
      );
      await expect(fs.stat(prefix)).rejects.toThrow();
      const after = await state(seeded);
      if (mode === 'canceled') expect(after.job?.status).toBe('canceled');
      else expect(after.job).toBeUndefined();
      // Credits are the API's business when it cancels: the job touched nothing.
      expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(balance);
      vi.restoreAllMocks();
    }
  }, 180_000);

  it('a job cancelled before it starts does nothing', async () => {
    const seeded = await seedTranslation();
    await t.ctx.db
      .update(translationJobs)
      .set({ status: 'canceled' })
      .where(eq(translationJobs.id, seeded.translationJobId));
    const translate = vi.spyOn(t.ctx.providers.translation, 'translate');
    const { result, progress } = await t.run(job, seeded.payload);
    expect(result.completedLanguages).toEqual([]);
    expect(progress).toEqual([]);
    expect(translate).not.toHaveBeenCalled();
  });

  it('never loads a translation through another workspace', async () => {
    const seeded = await seedTranslation();
    const other = await seedAccount(t.ctx.db);
    await expect(
      t.run(job, { translationJobId: seeded.translationJobId, workspaceId: other.workspace.id }),
    ).rejects.toThrow(/NOT_FOUND/);
    expect((await state(seeded)).job?.status).toBe('queued');
    expect(await charged(seeded)).toBe(seeded.cost);
  });

  it('onFinalFailure: refunds a job that produced nothing, settles one that produced something', async () => {
    const error = { code: 'SERVICE_UNAVAILABLE' as const, message: 'The worker stopped' };
    const nothing = await seedTranslation({ targets: ['en', 'fr'] });
    await job.onFinalFailure?.(t.ctx, nothing.payload, error);
    await job.onFinalFailure?.(t.ctx, nothing.payload, error);
    const failed = await state(nothing);
    expect(failed.job).toMatchObject({ status: 'failed', error, creditsCharged: 0 });
    expect([...failed.outputs.values()].map((o) => o.status)).toEqual(['failed', 'failed']);
    expect(await charged(nothing)).toBe(0);
    expect(await getCreditBalance(t.ctx.db, nothing.workspaceId)).toBe(40);

    // The worker died after English was stored.
    const some = await seedTranslation({ targets: ['en', 'fr'] });
    await t.ctx.db
      .update(translationJobs)
      .set({ status: 'processing' })
      .where(eq(translationJobs.id, some.translationJobId));
    await t.ctx.db
      .update(translationOutputs)
      .set({ status: 'completed', videoKey: 'ws/x/translations/y/en/video.mp4' })
      .where(eq(translationOutputs.id, some.outputIds.get('en') ?? ''));
    const outcome = await finishTranslation(t.ctx, some.payload, error);
    expect(outcome).toEqual({
      status: 'partial',
      completedLanguages: ['en'],
      failedLanguages: ['fr'],
      creditsCharged: 2,
    });
    expect(await finishTranslation(t.ctx, some.payload, error)).toBeNull(); // already closed
    const partial = await state(some);
    expect(partial.job).toMatchObject({ status: 'partial', error: null, creditsCharged: 2 });
    expect(partial.outputs.get('fr')).toMatchObject({ status: 'failed', error });
    expect(await charged(some)).toBe(2);
  });
});

describe('dubbing: fitting each segment to its slot', () => {
  it('gives each segment the time until the next one starts', () => {
    const segments = [
      { startMs: 500, endMs: 2000, text: 'a' },
      { startMs: 2100, endMs: 4000, text: 'b' },
      { startMs: 9000, endMs: 9900, text: 'c' },
    ];
    expect(dubSlots(segments, 10_000)).toEqual([
      { startMs: 500, availableMs: 1600 - SLOT_GAP_MS },
      { startMs: 2100, availableMs: 6900 - SLOT_GAP_MS },
      { startMs: 9000, availableMs: 1000 },
    ]);
  });

  it('keeps, stretches, re-synthesises faster or cuts, in that order', () => {
    expect(planNaturalTake(900, 1000)).toEqual({ voiceSpeed: 1, tempo: 1, truncated: false });
    expect(planNaturalTake(1100, 1000)).toEqual({ voiceSpeed: 1, tempo: 1.1, truncated: false });
    const faster = planNaturalTake(1400, 1000);
    expect(faster.voiceSpeed).toBeCloseTo(1.456, 3);
    expect(faster.tempo).toBe(1);
    expect(planNaturalTake(5000, 1000).voiceSpeed).toBe(MAX_VOICE_SPEED);
    expect(planFastTake(900, 1000)).toBe(1);
    expect(planFastTake(1200, 1000)).toBeCloseTo(1.2);
    expect(planFastTake(3000, 1000)).toBe(MAX_TEMPO);
    expect(fitFilters({ tempo: 1, truncated: false, maxMs: 1500 })).toBe('atrim=end=1.500');
    expect(fitFilters({ tempo: 1.25, truncated: true, maxMs: 1000 })).toBe(
      'atempo=1.2500,atrim=end=1.000,afade=t=out:st=0.940:d=0.060',
    );
  });

  it('never lets the real voice overflow its slot', async () => {
    const account = await seedAccount(t.ctx.db);
    const segments: TimedText[] = [
      { startMs: 0, endMs: 2500, text: 'Good morning and welcome.' },
      // Far more text than 1.5 s can hold.
      {
        startMs: 3000,
        endMs: 4500,
        text: 'This sentence is deliberately much longer than the short time the original speaker needed to say it.',
      },
      { startMs: 4600, endMs: 9000, text: 'Thank you.' },
    ];
    const dub = await dubSegments(t.ctx, segments, 10_000, {
      workspaceId: account.workspace.id,
      voiceId: await voiceFor('en'),
      language: 'en',
    });
    expect(dub.segments).toHaveLength(3);
    expect(dub.provider?.id).toBe('espeak');
    const [easy, squeezed, last] = dub.segments;
    expect(easy).toMatchObject({ tempo: 1, voiceSpeed: 1, truncated: false });
    expect(squeezed?.voiceSpeed).toBe(MAX_VOICE_SPEED);
    expect(squeezed?.tempo).toBeGreaterThan(1);
    expect(dub.stats).toMatchObject({ segments: 3, resynthesised: 1 });
    for (const [i, segment] of dub.segments.entries()) {
      const next = dub.segments[i + 1];
      const end = segment.startMs + segment.spokenMs;
      if (next) expect(end).toBeLessThanOrEqual(next.startMs - SLOT_GAP_MS + 1);
      expect(segment.startMs + segment.maxMs).toBeLessThanOrEqual(
        next ? next.startMs : 10_000 + SLOT_GAP_MS,
      );
      // Words are on the clock of the video, inside the spoken span.
      expect(segment.words.length).toBeGreaterThan(0);
      expect(segment.words[0]?.tMs).toBeGreaterThanOrEqual(segment.startMs);
      expect(segment.words.at(-1)?.tMs).toBeLessThan(end);
    }
    expect(last?.truncated).toBe(false);
  });
});

describe('subtitles and mix plumbing', () => {
  const style = SubtitleStyleSchema.parse({});

  it('tidies transcripts: sorted, inside the video, without empty cues', () => {
    expect(
      tidySegments(
        [
          { startMs: 5000, endMs: 20_000, text: '  dos   palabras ' },
          { startMs: 0, endMs: 1000, text: '   ' },
          { startMs: 1000, endMs: 2000, text: 'uno' },
          { startMs: 12_000, endMs: 13_000, text: 'fuera' },
        ],
        10_000,
      ),
    ).toEqual([
      { startMs: 1000, endMs: 2000, text: 'uno' },
      { startMs: 5000, endMs: 10_000, text: 'dos palabras' },
    ]);
  });

  it('builds cues from the words of the dub, estimating them when the voice timed none', () => {
    expect(estimateWords('uno dos', 1000, 700)).toEqual([
      { tMs: 1000, durMs: 350, text: 'uno' },
      { tMs: 1350, durMs: 350, text: 'dos' },
    ]);
    const cues = dubSubtitleCues(
      [
        {
          index: 0,
          startMs: 1000,
          spokenMs: 3000,
          text: 'This is a fairly long sentence that needs more than one subtitle to be read comfortably by anyone.',
          words: [],
          audioKey: 'k',
          tempo: 1,
          voiceSpeed: 1,
          truncated: false,
          maxMs: 3000,
        },
      ],
      style,
      { width: 1280, height: 720 },
      10_000,
    );
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]?.startMs).toBe(1000);
    expect(cues.every((cue) => cue.text.length <= style.maxCharsPerLine * style.maxLines)).toBe(
      true,
    );
    for (const [i, cue] of cues.entries()) {
      const next = cues[i + 1];
      if (next) expect(cue.endMs).toBeLessThanOrEqual(next.startMs);
    }
  });

  it('paints one picture per subtitle state and a concat script covering the whole video', async () => {
    const tmp = await createTempDir(t.ctx, 'overlay-test');
    try {
      const karaoke = SubtitleStyleSchema.parse({ preset: 'karaoke' });
      const words = [
        { tMs: 1000, durMs: 450, text: 'uno' },
        { tMs: 1499.6, durMs: 450, text: 'dos' },
        { tMs: 2000, durMs: 500, text: 'tres' },
      ];
      const overlay = await renderSubtitleOverlay(
        tmp.path,
        [{ startMs: 1000, endMs: 2600, text: 'uno dos tres', words }],
        karaoke,
        { width: 320, height: 180 },
        5000,
      );
      // Karaoke: the highlighted word changes three times → three pictures.
      expect(overlay.images).toBe(3);
      expect(overlay.states.map((s) => [s.startMs, s.endMs])).toEqual([
        [0, 1000],
        [1000, 1500],
        [1500, 2000],
        [2000, 2600],
        [2600, 5000],
      ]);
      expect(overlay.states[0]?.file).toBe('blank.png');
      const script = await fs.readFile(overlay.scriptPath, 'utf8');
      expect(script.startsWith('ffconcat version 1.0\nfile blank.png\nduration 1.000\n')).toBe(
        true,
      );
      const total = [...script.matchAll(/^duration ([\d.]+)$/gm)].reduce(
        (s, m) => s + Number(m[1]),
        0,
      );
      expect(total).toBeCloseTo(5, 3);
      const image = await loadNodeImage(path.join(tmp.path, overlay.states[1]?.file ?? ''));
      expect([image.width, image.height]).toEqual([320, 180]);

      // A boxed cue that does not change is a single picture.
      const still = await createTempDir(t.ctx, 'overlay-test');
      const boxed = await renderSubtitleOverlay(
        still.path,
        [
          {
            startMs: 0,
            endMs: 1500,
            text: 'uno dos tres',
            words: estimateWords('uno dos tres', 0, 1500),
          },
        ],
        style,
        { width: 320, height: 180 },
        2000,
      );
      expect(boxed.images).toBe(1);
      expect(boxed.states).toHaveLength(2);
      await still.remove();
    } finally {
      await tmp.remove();
    }
  });

  it('builds the ffmpeg command: copy or encode, attenuate or replace', () => {
    const source = (videoCodec: string, hasAudio = true): SourceVideo => ({
      path: '/tmp/in.mp4',
      durationMs: 10_000,
      width: 1280,
      height: 720,
      info: {
        formatName: 'mov,mp4',
        durationMs: 10_000,
        sizeBytes: 1,
        hasVideo: true,
        hasAudio,
        width: 1280,
        height: 720,
        fps: 30,
        videoCodec,
        audioCodec: hasAudio ? 'aac' : null,
        sampleRate: 48000,
        channels: 2,
      },
    });
    const base = { dubPath: '/tmp/dub.s16le', outputPath: '/tmp/out.mp4', language: 'en' };

    const copy = mixArguments({
      ...base,
      source: source('h264'),
      originalAudioVolume: 0.08,
      overlay: null,
    });
    expect(canCopyVideo({ source: source('h264'), overlay: null })).toBe(true);
    expect(copy.join(' ')).toContain('-map 0:v:0 -map [a] -c:v copy');
    expect(copy.join(' ')).toContain('volume=0.080[orig]');
    expect(copy.join(' ')).toContain('amix=inputs=2');
    expect(copy.join(' ')).toContain('-t 10.000');
    expect(copy.join(' ')).toContain('language=eng');
    expect(copy.slice(-4)).toEqual(['+faststart', '-f', 'mp4', '/tmp/out.mp4']);

    // Volume 0 (or a silent source) = the dub alone.
    for (const args of [
      mixArguments({ ...base, source: source('h264'), originalAudioVolume: 0, overlay: null }),
      mixArguments({
        ...base,
        source: source('h264', false),
        originalAudioVolume: 0.5,
        overlay: null,
      }),
    ]) {
      expect(args.join(' ')).not.toContain('amix');
      expect(args.join(' ')).not.toContain('[0:a:0]');
    }

    // Another codec, or burned subtitles, re-encode to H.264.
    const vp9 = mixArguments({
      ...base,
      source: source('vp9'),
      originalAudioVolume: 0,
      overlay: null,
    });
    expect(vp9.join(' ')).toContain('-c:v libx264');
    expect(vp9.join(' ')).toContain('scale=1280:720');
    const burned = mixArguments({
      ...base,
      source: source('h264'),
      originalAudioVolume: 0,
      overlay: { scriptPath: '/tmp/o/overlay.ffconcat', width: 1280, height: 720 },
    });
    expect(burned.join(' ')).toContain('-f concat -safe 0 -i /tmp/o/overlay.ffconcat');
    expect(burned.join(' ')).toContain('overlay=0:0');
    expect(burned.join(' ')).toContain('-c:v libx264');
    // 4K sources are scaled down when subtitles are burned in.
    expect(burnFrameSize({ width: 3840, height: 2160 })).toEqual({ width: 1920, height: 1080 });
    expect(burnFrameSize({ width: 720, height: 1280 })).toEqual({ width: 720, height: 1280 });
  });

  it('rejects a source that is not a video', async () => {
    const seeded = await seedTranslation();
    const [row] = await t.ctx.db
      .select()
      .from(translationJobs)
      .where(eq(translationJobs.id, seeded.translationJobId));
    const [asset] = await t.ctx.db
      .select()
      .from(assets)
      .where(eq(assets.id, row?.sourceAssetId ?? ''));
    await t.ctx.providers.storage.put(asset?.storageKey ?? '', Buffer.from('not a video at all'), {
      contentType: 'video/mp4',
    });
    await expect(t.run(job, seeded.payload)).rejects.toThrow(
      new AppError('UNPROCESSABLE', 'The media file could not be read').message,
    );
    expect((await state(seeded)).job).toMatchObject({ status: 'failed', creditsCharged: 0 });
    expect(await charged(seeded)).toBe(0);
  });
});
