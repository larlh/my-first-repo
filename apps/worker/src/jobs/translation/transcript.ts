import fs from 'node:fs/promises';
import { AppError } from '@parlante/shared';
import type { LanguageCode, ProviderRef, TimedText } from '@parlante/shared';
import type { WorkerContext } from '../../context';
import type { TempDir } from '../../lib/tmp';
import { extractSpeechAudio } from './mix';
import type { SourceVideo } from './mix';

/* -------------------------------------------------------------------------------------------
 * Transcript of the source video, as timed segments in the source language:
 *   - supplied by the user when the job was created (already parsed and moderated by the API)
 *   - or produced here by the STT provider from the audio of the video (WAV 16 kHz mono) and
 *     then moderated, because nobody has read it yet.
 * With the local `manual` STT provider only the first path exists: a job without a transcript
 * fails with TRANSCRIPT_REQUIRED (the API normally rejects it before it is ever queued).
 * ----------------------------------------------------------------------------------------- */

/** Segments sorted, non-empty, inside the video, with whitespace collapsed. */
export function tidySegments(segments: readonly TimedText[], totalMs: number): TimedText[] {
  return segments
    .map((segment) => ({
      startMs: Math.max(0, Math.round(segment.startMs)),
      endMs: Math.min(totalMs, Math.round(segment.endMs)),
      text: segment.text.replace(/\s+/g, ' ').trim(),
    }))
    .filter((segment) => segment.text !== '' && segment.endMs > segment.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export interface Transcript {
  segments: TimedText[];
  /** Provider that transcribed, or null when the user supplied the transcript. */
  provider: ProviderRef | null;
}

export async function transcribeSource(
  ctx: Pick<WorkerContext, 'providers'>,
  source: SourceVideo,
  tmp: TempDir,
  language: LanguageCode,
  signal?: AbortSignal,
): Promise<Transcript> {
  const { stt, moderation } = ctx.providers;
  if (stt.requiresUserTranscript) {
    throw new AppError(
      'TRANSCRIPT_REQUIRED',
      'Automatic transcription is not configured on this server: provide the transcript of the video (SRT, VTT or plain text)',
      { sttProvider: stt.info.id },
    );
  }
  if (!source.info.hasAudio) {
    throw new AppError(
      'UNPROCESSABLE',
      'This video has no audio to transcribe: provide its transcript',
    );
  }
  const audioPath = tmp.file('speech.wav');
  await extractSpeechAudio(source, audioPath, signal);
  const result = await stt.transcribe({
    audio: await fs.readFile(audioPath),
    audioPath,
    language,
  });
  const segments = tidySegments(result.segments, source.durationMs);
  if (segments.length === 0) {
    throw new AppError('UNPROCESSABLE', 'No speech was recognised in this video', {
      sttProvider: result.provider.id,
    });
  }
  const verdict = await moderation.check({
    text: segments.map((segment) => segment.text).join('\n'),
    language,
    context: 'translation',
  });
  if (!verdict.allowed) {
    throw new AppError('CONTENT_BLOCKED', 'The content of this video was blocked by moderation', {
      field: 'transcript',
      flags: verdict.flags,
    });
  }
  return { segments, provider: result.provider };
}
