import {
  COMPOSITION_LIMITS,
  DEFAULT_SILENT_SCENE_MS,
  LanguageCodeSchema,
  ProviderRefSchema,
  ScriptToneSchema,
  compositionFromScript,
  estimateSpeechMs,
} from '@parlante/shared';
import type {
  AspectRatio,
  Composition,
  GeneratedScript,
  LanguageCode,
  ProviderRef,
  ScriptTone,
} from '@parlante/shared';
import { z } from 'zod';

/* Pure model of the script writer: the brief the person fills in, the editable script that
 * comes back, its timing and its way into a Composition. No React, no network. */

/* ---------- brief ---------- */

export const TONES = ScriptToneSchema.options;
/** Bounds of `durationSec` in the contract. */
export const DURATION_MIN_SEC = 10;
export const DURATION_MAX_SEC = 600;
export const DURATION_STEP_SEC = 5;
export const TOPIC_MIN_CHARS = 3;
export const TOPIC_MAX_CHARS = 2000;
export const URL_MAX_CHARS = 2000;
export const AUDIENCE_MAX_CHARS = 200;
export const MAX_SCENE_COUNT = 12;

export const BriefSchema = z.object({
  sourceKind: z.enum(['topic', 'url']),
  topic: z.string().max(TOPIC_MAX_CHARS),
  url: z.string().max(URL_MAX_CHARS),
  tone: ScriptToneSchema,
  durationSec: z.number().int().min(DURATION_MIN_SEC).max(DURATION_MAX_SEC),
  language: LanguageCodeSchema,
  /** null = let the writer decide. */
  sceneCount: z.number().int().min(1).max(MAX_SCENE_COUNT).nullable(),
  audience: z.string().max(AUDIENCE_MAX_CHARS),
});
export type Brief = z.infer<typeof BriefSchema>;

export function defaultBrief(language: LanguageCode = 'es'): Brief {
  return {
    sourceKind: 'topic',
    topic: '',
    url: '',
    tone: 'professional',
    durationSec: 60,
    language,
    sceneCount: null,
    audience: '',
  };
}

/** `https://…` for what the person typed: a bare domain gets the scheme added. */
export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (text === '' || /\s/.test(text)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export type BriefProblem = 'topicShort' | 'urlInvalid';

/** What stops the brief from being sent (null = ready). */
export function briefProblem(brief: Brief): BriefProblem | null {
  if (brief.sourceKind === 'topic') {
    return brief.topic.trim().length < TOPIC_MIN_CHARS ? 'topicShort' : null;
  }
  return normalizeUrl(brief.url) === null ? 'urlInvalid' : null;
}

export interface GenerateBody {
  source: { kind: 'topic'; topic: string } | { kind: 'url'; url: string };
  tone: ScriptTone;
  durationSec: number;
  language: LanguageCode;
  sceneCount?: number;
  audience?: string;
}

/** Body of `POST /api/script-writer/generate` for a valid brief. */
export function briefToBody(brief: Brief): GenerateBody {
  const audience = brief.audience.trim();
  return {
    source:
      brief.sourceKind === 'topic'
        ? { kind: 'topic', topic: brief.topic.trim() }
        : { kind: 'url', url: normalizeUrl(brief.url) ?? brief.url.trim() },
    tone: brief.tone,
    durationSec: brief.durationSec,
    language: brief.language,
    ...(brief.sceneCount !== null ? { sceneCount: brief.sceneCount } : {}),
    ...(audience !== '' ? { audience } : {}),
  };
}

/* ---------- editable script ---------- */

export const TITLE_MAX_CHARS = 120;
export const HEADLINE_MAX_CHARS = 120;
export const SCENE_NAME_MAX_CHARS = 80;

export const DraftSceneSchema = z.object({
  id: z.string().min(1),
  /** Scene name shown in the Studio. */
  title: z.string(),
  /** On-screen headline (text layer); empty = none. */
  headline: z.string(),
  /** Narration. */
  text: z.string(),
});
export type DraftScene = z.infer<typeof DraftSceneSchema>;

export const ScriptDraftSchema = z.object({
  title: z.string(),
  language: LanguageCodeSchema,
  scenes: z.array(DraftSceneSchema).min(1),
  provider: ProviderRefSchema,
  basicMode: z.boolean(),
  sourceTitle: z.string().nullable(),
  /** Duration the person asked for (to compare with the estimate). */
  targetSec: z.number(),
  /** True once the person changed anything the writer produced. */
  edited: z.boolean(),
});
export type ScriptDraft = z.infer<typeof ScriptDraftSchema>;

export type MakeId = () => string;

export function draftFromGenerated(
  script: GeneratedScript,
  targetSec: number,
  makeId: MakeId,
): ScriptDraft {
  return {
    title: script.title.slice(0, TITLE_MAX_CHARS),
    language: script.language,
    scenes: script.scenes.map((scene) => ({
      id: makeId(),
      title: scene.title.slice(0, SCENE_NAME_MAX_CHARS),
      headline: scene.headline.slice(0, HEADLINE_MAX_CHARS),
      text: scene.text.slice(0, COMPOSITION_LIMITS.maxScriptChars),
    })),
    provider: script.provider,
    basicMode: script.basicMode,
    sourceTitle: script.sourceTitle,
    targetSec,
    edited: false,
  };
}

export function updateScene(
  draft: ScriptDraft,
  sceneId: string,
  patch: Partial<Omit<DraftScene, 'id'>>,
): ScriptDraft {
  return {
    ...draft,
    edited: true,
    scenes: draft.scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...patch } : scene)),
  };
}

/** Move a scene one place up (-1) or down (+1); out-of-range moves change nothing. */
export function moveScene(draft: ScriptDraft, sceneId: string, delta: -1 | 1): ScriptDraft {
  const from = draft.scenes.findIndex((scene) => scene.id === sceneId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= draft.scenes.length) return draft;
  const scenes = [...draft.scenes];
  const [moved] = scenes.splice(from, 1);
  if (!moved) return draft;
  scenes.splice(to, 0, moved);
  return { ...draft, edited: true, scenes };
}

/** Remove a scene; the last remaining scene cannot be removed. */
export function removeScene(draft: ScriptDraft, sceneId: string): ScriptDraft {
  if (draft.scenes.length <= 1) return draft;
  const scenes = draft.scenes.filter((scene) => scene.id !== sceneId);
  return scenes.length === draft.scenes.length ? draft : { ...draft, edited: true, scenes };
}

/** Insert an empty scene after `afterId` (or at the end). */
export function insertScene(
  draft: ScriptDraft,
  afterId: string | null,
  makeId: MakeId,
): { draft: ScriptDraft; sceneId: string } {
  const scene: DraftScene = { id: makeId(), title: '', headline: '', text: '' };
  const index = afterId === null ? -1 : draft.scenes.findIndex((s) => s.id === afterId);
  const scenes = [...draft.scenes];
  scenes.splice(index < 0 ? scenes.length : index + 1, 0, scene);
  return { draft: { ...draft, edited: true, scenes }, sceneId: scene.id };
}

/* ---------- timing ---------- */

/** Default paddings of a scene (`paddingStartMs` + `paddingEndMs` of the Composition schema). */
const SCENE_PADDING_MS = 300 + 500;

/**
 * Estimated duration of a scene with this narration — the same rule the API uses to estimate
 * a Composition before rendering (`estimateCompositionDurationMs`; a test keeps them equal).
 */
export function sceneMs(text: string): number {
  const narration = estimateSpeechMs(text);
  return narration <= 0 ? DEFAULT_SILENT_SCENE_MS : SCENE_PADDING_MS + narration;
}

export interface DraftTiming {
  /** Start of every scene on the running order (ms). */
  startsMs: number[];
  durationsMs: number[];
  totalMs: number;
}

export function draftTiming(draft: Pick<ScriptDraft, 'scenes'>): DraftTiming {
  const startsMs: number[] = [];
  const durationsMs: number[] = [];
  let totalMs = 0;
  for (const scene of draft.scenes) {
    const duration = sceneMs(scene.text);
    startsMs.push(totalMs);
    durationsMs.push(duration);
    totalMs += duration;
  }
  return { startsMs, durationsMs, totalMs };
}

/* ---------- checks before creating the video ---------- */

export interface DraftLimits {
  maxScenesPerVideo: number;
  maxVideoDurationSec: number;
}

export interface DraftProblems {
  /** No scene has any narration: there is nothing to say. */
  noNarration: boolean;
  /** Indexes of scenes without narration (allowed: they become silent scenes). */
  silentScenes: number[];
  /** More scenes than the plan allows. */
  tooManyScenes: boolean;
  /** Estimated duration above the plan limit. */
  tooLong: boolean;
  /** The title is empty. */
  untitled: boolean;
}

export function draftProblems(draft: ScriptDraft, limits: DraftLimits): DraftProblems {
  const silentScenes = draft.scenes.flatMap((scene, index) =>
    scene.text.trim() === '' ? [index] : [],
  );
  return {
    noNarration: silentScenes.length === draft.scenes.length,
    silentScenes,
    tooManyScenes: draft.scenes.length > limits.maxScenesPerVideo,
    tooLong: draftTiming(draft).totalMs > limits.maxVideoDurationSec * 1000,
    untitled: draft.title.trim() === '',
  };
}

/** True when the draft can become a video. */
export function canCreateVideo(problems: DraftProblems): boolean {
  return (
    !problems.noNarration && !problems.tooManyScenes && !problems.tooLong && !problems.untitled
  );
}

export interface VideoChoices {
  avatarId: string;
  voiceId: string;
  aspect: AspectRatio;
  subtitles: boolean;
}

/**
 * The draft as a Composition, through the one script → Composition layout shared with the
 * public API (`compositionFromScript`), so a script makes the same video however it arrives.
 */
export function draftToComposition(draft: ScriptDraft, choices: VideoChoices): Composition {
  return compositionFromScript(
    draft.scenes.map((scene, index) => ({
      text: scene.text.trim(),
      headline: scene.headline.trim(),
      title: scene.title.trim() || `${index + 1}`,
    })),
    {
      avatarId: choices.avatarId,
      voiceId: choices.voiceId,
      language: draft.language,
      aspect: choices.aspect,
      subtitles: choices.subtitles,
    },
  );
}

/** Whether a result came from the local heuristic, whoever was asked. */
export function isBasic(provider: ProviderRef, basicMode: boolean): boolean {
  return basicMode || provider.quality === 'basic';
}
