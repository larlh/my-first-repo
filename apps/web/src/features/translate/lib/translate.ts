import {
  CREDIT_COSTS,
  LANGUAGE_CODES,
  creditsForTranslation,
  parseTranscript,
} from '@parlante/shared';
import type {
  LanguageCode,
  TranscriptFormat,
  TranslationJob,
  TranslationOutput,
} from '@parlante/shared';

/* Pure model of the translation tool: the form of a new job, its checks, its cost and the
 * reading of a job's outputs. No React, no network. */

/* ---------- source ---------- */

export type TranslationSource =
  | {
      kind: 'asset';
      assetId: string;
      name: string;
      durationMs: number | null;
      thumbnailUrl: string | null;
    }
  | {
      kind: 'video';
      videoId: string;
      name: string;
      durationMs: number | null;
      thumbnailUrl: string | null;
    };

/* ---------- target languages ---------- */

/** Languages a video in `source` can be translated to (every other one). */
export function targetChoices(source: LanguageCode): LanguageCode[] {
  return LANGUAGE_CODES.filter((code) => code !== source);
}

/**
 * Add or remove a target. Adding beyond `max` (the plan limit) changes nothing; the result
 * keeps the catalogue order so the request and the UI list agree.
 */
export function toggleTarget(
  targets: readonly LanguageCode[],
  code: LanguageCode,
  max: number,
): LanguageCode[] {
  if (targets.includes(code)) return targets.filter((item) => item !== code);
  if (targets.length >= max) return [...targets];
  const next = new Set([...targets, code]);
  return LANGUAGE_CODES.filter((item) => next.has(item));
}

/** Drop the source language from the targets (after the person changes it). */
export function withoutSource(
  targets: readonly LanguageCode[],
  source: LanguageCode,
): LanguageCode[] {
  return targets.filter((code) => code !== source);
}

/* ---------- transcript ---------- */

export const TRANSCRIPT_MAX_CHARS = 500_000;

/** Format suggested by a file name or by the content itself. */
export function detectTranscriptFormat(fileName: string, content: string): TranscriptFormat {
  const name = fileName.toLowerCase();
  if (name.endsWith('.vtt') || /^\uFEFF?WEBVTT/.test(content)) return 'vtt';
  if (name.endsWith('.srt')) return 'srt';
  return /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(content) ? 'srt' : 'text';
}

export type TranscriptProblem =
  /** Nothing written. */
  | 'empty'
  /** SRT / VTT without a single timed cue. */
  | 'noCues'
  /** Every cue starts after the end of the video. */
  | 'outOfRange'
  | 'tooLong';

export interface TranscriptCheck {
  problem: TranscriptProblem | null;
  /** Usable cues (inside the video). */
  cues: number;
  /** End of the last usable cue (ms). */
  coveredMs: number;
  /** Cues that start after the video ends (ignored by the server). */
  ignored: number;
}

/**
 * What the server will make of a transcript — the same parser (`parseTranscript`) and the
 * same rule (cues must start inside the video). `durationMs` null = length still unknown:
 * only the format is checked.
 */
export function checkTranscript(
  format: TranscriptFormat,
  content: string,
  durationMs: number | null,
): TranscriptCheck {
  if (content.trim() === '') return { problem: 'empty', cues: 0, coveredMs: 0, ignored: 0 };
  if (content.length > TRANSCRIPT_MAX_CHARS) {
    return { problem: 'tooLong', cues: 0, coveredMs: 0, ignored: 0 };
  }
  const total = durationMs ?? Number.MAX_SAFE_INTEGER;
  const parsed = parseTranscript(format, content, durationMs ?? 60_000).filter(
    (cue) => cue.text.trim() !== '' && cue.endMs > cue.startMs,
  );
  if (parsed.length === 0) return { problem: 'noCues', cues: 0, coveredMs: 0, ignored: 0 };
  const usable = parsed.filter((cue) => cue.startMs < total);
  if (usable.length === 0) {
    return { problem: 'outOfRange', cues: 0, coveredMs: 0, ignored: parsed.length };
  }
  return {
    problem: null,
    cues: usable.length,
    coveredMs: Math.min(total, Math.max(...usable.map((cue) => cue.endMs))),
    ignored: parsed.length - usable.length,
  };
}

/* ---------- form ---------- */

/** "No choice": the server picks a stock voice of the language. */
export const AUTO = 'auto';

export interface TranslationForm {
  source: TranslationSource | null;
  name: string;
  sourceLanguage: LanguageCode;
  targets: LanguageCode[];
  transcriptFormat: TranscriptFormat;
  transcript: string;
  /** Voice per target language (`AUTO` or absent = default voice). */
  voices: Partial<Record<LanguageCode, string>>;
  /** 0..1 */
  originalAudioVolume: number;
  burnSubtitles: boolean;
}

export const DEFAULT_ORIGINAL_VOLUME = 0.08;

export function emptyForm(sourceLanguage: LanguageCode): TranslationForm {
  return {
    source: null,
    name: '',
    sourceLanguage,
    targets: [],
    transcriptFormat: 'srt',
    transcript: '',
    voices: {},
    originalAudioVolume: DEFAULT_ORIGINAL_VOLUME,
    burnSubtitles: false,
  };
}

export interface FormContext {
  /** The STT provider cannot transcribe: the person must supply the transcript. */
  transcriptRequired: boolean;
  maxTargets: number;
  maxSourceSec: number;
  credits: number;
}

export type FormProblem =
  | 'noSource'
  | 'unknownDuration'
  | 'sourceTooLong'
  | 'noTargets'
  | 'tooManyTargets'
  | 'transcriptRequired'
  | 'transcriptInvalid'
  | 'insufficientCredits';

/** Credits a job will reserve; null until source length and targets are known. */
export function translationCost(form: TranslationForm): number | null {
  const duration = form.source?.durationMs;
  if (!duration || form.targets.length === 0) return null;
  return creditsForTranslation(duration, form.targets.length);
}

/** Started minutes the cost is computed from. */
export function billedMinutes(durationMs: number): number {
  return Math.max(1, Math.ceil(durationMs / 60_000));
}

export const CREDITS_PER_MINUTE_AND_LANGUAGE = CREDIT_COSTS.translationPerMinutePerLanguage;

/** Everything that stops the job from being queued, in the order the form shows it. */
export function formProblems(form: TranslationForm, context: FormContext): FormProblem[] {
  const problems: FormProblem[] = [];
  const duration = form.source?.durationMs ?? null;
  if (!form.source) problems.push('noSource');
  else if (!duration) problems.push('unknownDuration');
  else if (duration > context.maxSourceSec * 1000) problems.push('sourceTooLong');
  if (form.targets.length === 0) problems.push('noTargets');
  else if (form.targets.length > context.maxTargets) problems.push('tooManyTargets');
  const written = form.transcript.trim() !== '';
  if (context.transcriptRequired && !written) problems.push('transcriptRequired');
  else if (written && checkTranscript(form.transcriptFormat, form.transcript, duration).problem) {
    problems.push('transcriptInvalid');
  }
  const cost = translationCost(form);
  if (cost !== null && cost > context.credits) problems.push('insufficientCredits');
  return problems;
}

export interface CreateTranslationInput {
  name?: string;
  sourceAssetId?: string;
  sourceVideoId?: string;
  sourceLanguage: LanguageCode;
  targetLanguages: LanguageCode[];
  transcript?: { format: TranscriptFormat; content: string };
  voices: Partial<Record<LanguageCode, string>>;
  options: { originalAudioVolume: number; burnSubtitles: boolean };
}

/** Body of `POST /api/translations` for a form without problems. */
export function buildCreateBody(form: TranslationForm): CreateTranslationInput {
  if (!form.source) throw new Error('A source video is required');
  const name = form.name.trim();
  const voices: Partial<Record<LanguageCode, string>> = {};
  for (const code of form.targets) {
    const voice = form.voices[code];
    if (voice && voice !== AUTO) voices[code] = voice;
  }
  return {
    ...(name !== '' ? { name } : {}),
    ...(form.source.kind === 'asset'
      ? { sourceAssetId: form.source.assetId }
      : { sourceVideoId: form.source.videoId }),
    sourceLanguage: form.sourceLanguage,
    targetLanguages: form.targets,
    ...(form.transcript.trim() !== ''
      ? { transcript: { format: form.transcriptFormat, content: form.transcript } }
      : {}),
    voices,
    options: {
      originalAudioVolume: Math.round(form.originalAudioVolume * 100) / 100,
      burnSubtitles: form.burnSubtitles,
    },
  };
}

/* ---------- reading a job ---------- */

export type LanguageState = TranslationOutput['status'];

export interface LanguageResult {
  language: LanguageCode;
  status: LanguageState;
  output: TranslationOutput | null;
}

/**
 * One entry per target language, in the order they were asked for. A language whose output
 * row does not exist yet is `pending` — or `failed` when the whole job already failed.
 */
export function languageResults(job: TranslationJob): LanguageResult[] {
  const settledBadly = job.status === 'failed' || job.status === 'canceled';
  return job.targetLanguages.map((language) => {
    const output = job.outputs.find((item) => item.language === language) ?? null;
    const status: LanguageState = output?.status ?? (settledBadly ? 'failed' : 'pending');
    return {
      language,
      status: settledBadly && (status === 'pending' || status === 'processing') ? 'failed' : status,
      output,
    };
  });
}

export function countByStatus(results: readonly LanguageResult[]): Record<LanguageState, number> {
  const counts: Record<LanguageState, number> = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

export function isActive(job: Pick<TranslationJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'processing';
}
