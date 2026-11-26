import { ESTIMATED_CHARS_PER_SECOND, estimateSpeechMs } from '@parlante/shared';
import type {
  GeneratedScene,
  GeneratedScript,
  ProviderRef,
  ScriptGenerationRequest,
} from '@parlante/shared';
import { SCRIPT_PHRASEBOOKS, TONE_BODY_ORDER } from './phrases';
import type { ScriptPhrasebook } from './phrases';
import { capitalize, clip, ensureFinalStop, fold, keywords, splitSentences, stem } from './text';

/* -------------------------------------------------------------------------------------------
 * Local script writer ("modo básico"): a deterministic heuristic, not a language model.
 *
 * What it can do
 *  - Structure: opening, body scenes and closing sized to the requested duration, in the
 *    requested tone (Spanish, English) and language (13 languages).
 *  - Use what the user gives it: key points typed in the topic ("Tema: punto, punto, punto" or
 *    one per line) become one scene each; a source text (page of a URL, pasted notes) is
 *    summarised EXTRACTIVELY — its most representative sentences, in their original order.
 * What it cannot do
 *  - Know anything about the topic, rephrase, or translate source text. Scenes without user
 *    material are generic scaffolding to edit. The result says `basicMode: true`.
 * ----------------------------------------------------------------------------------------- */

/** Default `paddingStartMs + paddingEndMs` of a scene (composition schema), in seconds. */
const SCENE_PADDING_SEC = 0.8;
const MAX_SCENES = 12;
const MAX_POINTS = 8;

interface Block {
  title: string;
  headline: string;
  /** Candidate sentences in order of importance. */
  sentences: string[];
}

interface Analysis {
  /** What the video is about, as a short label. */
  subject: string;
  /** Key points given by the user (template mode). */
  points: string[];
  /** Text to summarise (source page or long notes), or '' in template mode. */
  material: string;
  /** The subject is just the first sentence of the material (notes without a title). */
  subjectIsExcerpt?: boolean;
}

function cleanSubject(value: string): string {
  return clip(
    value
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[-–—•*#\s]+/u, '')
      .replace(/[\s.:;,]+$/u, ''),
    90,
  );
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

const BULLET = /^\s*(?:[-–—•*]|\d{1,2}[.)])\s+/u;

/** "a, b y c" → ["a", "b", "c"] when it really is a list of short items. */
function splitList(value: string): string[] {
  const items = value
    .split(/\s*[;,\n]\s*|\s+(?:y|e|and|et|und|ed|och|и|και)\s+(?=[^,;]*$)/u)
    .map((item) =>
      item
        .replace(BULLET, '')
        .replace(/[\s.]+$/u, '')
        .trim(),
    )
    .filter((item) => item.length >= 2);
  const isList = items.length >= 2 && items.every((item) => item.length <= 70);
  return isList ? items.slice(0, MAX_POINTS) : [];
}

function analyse(request: ScriptGenerationRequest): Analysis {
  const topic = request.topic.trim();
  const sourceText = request.sourceText?.trim() ?? '';
  const sourceTitle = request.sourceTitle?.trim() ?? '';

  if (sourceText !== '') {
    const topicIsUrl = /^https?:\/\//i.test(topic);
    const subject =
      sourceTitle || (topicIsUrl ? (hostOf(topic) ?? topic) : (topic.split(/\r?\n/)[0] ?? topic));
    return { subject: cleanSubject(subject), points: [], material: sourceText };
  }

  const lines = topic
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  // "Subject" on the first line and one short key point per line after it.
  if (lines.length >= 3 && lines.slice(1).every((line) => line.length <= 90)) {
    return {
      subject: cleanSubject(sourceTitle || lines[0]!),
      points: lines
        .slice(1, 1 + MAX_POINTS)
        .map((line) => line.replace(BULLET, '').replace(/[\s.]+$/u, '')),
      material: '',
    };
  }

  // Long text typed as the topic: treat it as notes to summarise.
  if (topic.length > 180 || splitSentences(topic).length >= 3) {
    const first = splitSentences(topic)[0] ?? topic;
    return {
      subject: cleanSubject(sourceTitle || first),
      points: [],
      material: topic,
      subjectIsExcerpt: sourceTitle === '',
    };
  }

  // "Subject: point, point and point"
  const colon = topic.indexOf(':');
  if (colon > 2 && colon < topic.length - 3) {
    const points = splitList(topic.slice(colon + 1));
    if (points.length >= 2) {
      return { subject: cleanSubject(topic.slice(0, colon)), points, material: '' };
    }
  }
  return { subject: cleanSubject(sourceTitle || topic), points: [], material: '' };
}

/** The subject as it reads inside a sentence (function words lose their capital). */
function inlineSubject(subject: string, book: ScriptPhrasebook): string {
  const first = subject.match(/^[\p{L}]+/u)?.[0];
  if (!first || !book.lowerFirst.includes(first.toLowerCase())) return subject;
  if (first === first.toUpperCase() && first.length > 1) return subject; // acronym
  return first.charAt(0).toLowerCase() + subject.slice(1);
}

function fill(
  template: string,
  book: ScriptPhrasebook,
  subject: string,
  audience: string,
  keepCase = false,
): string {
  // Titles of source pages are quoted as they are; typed topics blend into the sentence.
  const inline = keepCase ? subject : inlineSubject(subject, book);
  return (
    template
      // After a colon the subject stands on its own and keeps the capitals it was typed with.
      .replace(/(:\s*)\{topic\}/gu, (_match, lead: string) => lead + subject)
      .replaceAll('{topic}', inline)
      .replaceAll('{it}', book.it)
      .replaceAll('{audience}', audience)
      // "… sobre ¿qué es X?." → no double punctuation.
      .replace(/([?!…])[.!]/gu, '$1')
  );
}

function sceneSeconds(text: string): number {
  return Math.round((estimateSpeechMs(text) / 1000 + SCENE_PADDING_SEC) * 10) / 10;
}

function toScene(block: Block, sentences: string[]): GeneratedScene {
  const text = sentences.join(' ');
  return {
    title: block.title,
    text,
    headline: block.headline,
    estimatedSec: sceneSeconds(text),
  };
}

/** Scenes for a duration: one for a few seconds, opening + closing up to ~24 s, then ~13 s each. */
function autoSceneCount(durationSec: number): number {
  if (durationSec < 16) return 1;
  if (durationSec < 24) return 2;
  return Math.min(10, Math.max(3, Math.round(durationSec / 13)));
}

function charBudget(durationSec: number, scenes: number): number {
  return Math.max(0, durationSec - scenes * SCENE_PADDING_SEC) * ESTIMATED_CHARS_PER_SECOND;
}

/**
 * Choose how many sentences each block speaks so the total fits the duration: every block
 * starts with its first sentence, then sentences are added round by round while they fit.
 */
function fitBlocks(blocks: Block[], durationSec: number): GeneratedScene[] {
  const budget = charBudget(durationSec, blocks.length) * 1.06;
  const taken = blocks.map(() => 1);
  let used = blocks.reduce((sum, block) => sum + (block.sentences[0]?.length ?? 0) + 1, 0);
  for (let round = 1; ; round += 1) {
    let added = false;
    for (const [index, block] of blocks.entries()) {
      const sentence = block.sentences[round];
      if (sentence === undefined || taken[index] !== round) continue;
      if (used + sentence.length + 1 > budget) continue;
      taken[index] = round + 1;
      used += sentence.length + 1;
      added = true;
    }
    if (!added) break;
  }
  return blocks.map((block, index) => toScene(block, block.sentences.slice(0, taken[index])));
}

/* ------------------------------------ template mode ------------------------------------ */

function templateBlocks(
  request: ScriptGenerationRequest,
  analysis: Analysis,
  book: ScriptPhrasebook,
): { hook: Block; body: Block[]; close: Block } {
  const audience = request.audience?.trim() ?? '';
  const render = (template: string) => fill(template, book, analysis.subject, audience);

  const hookSentences = (book.hook[request.tone] ?? book.hook.default).map(render);
  if (audience !== '') hookSentences.splice(1, 0, render(book.audience));
  const hook: Block = {
    title: book.hookTitle,
    headline: clip(capitalize(analysis.subject), 48),
    sentences: hookSentences,
  };

  const body: Block[] = analysis.points.map((point, index) => ({
    title: clip(capitalize(point), 60),
    headline: clip(capitalize(point), 48),
    sentences: [
      ensureFinalStop(
        book.pointLead.replace('{n}', String(index + 1)).replace('{point}', point),
      ).replace(/([?!…])\./u, '$1'),
      render(book.pointFillers[index % book.pointFillers.length]!),
      render(book.pointFillers[(index + 1) % book.pointFillers.length]!),
    ],
  }));
  for (const role of TONE_BODY_ORDER[request.tone]) {
    const text = book.body[role];
    if (!text) continue;
    body.push({
      title: text.title,
      headline: text.headline,
      sentences: text.sentences.map(render),
    });
  }

  const close: Block = {
    title: book.closeTitle,
    headline: book.closeHeadline,
    sentences: (book.close[request.tone] ?? book.close.default).map(render),
  };
  return { hook, body, close };
}

function templateScenes(
  request: ScriptGenerationRequest,
  analysis: Analysis,
  book: ScriptPhrasebook,
): GeneratedScene[] {
  const { hook, body, close } = templateBlocks(request, analysis, book);
  const points = analysis.points.length;
  // Every key point the user typed gets its scene unless they asked for fewer scenes.
  const wanted =
    request.sceneCount ??
    Math.max(autoSceneCount(request.durationSec), points > 0 ? points + 2 : 0);
  const count = Math.min(MAX_SCENES, wanted, body.length + 2);

  if (count <= 1) {
    // One scene: the opening line, the user's key points and one closing line — as much as
    // fits, in that order of preference; then spoken in their natural order.
    const closing = close.sentences[1] ?? close.sentences[0]!;
    const pointLines = body.slice(0, points).map((block) => block.sentences[0]!);
    const candidates = [hook.sentences[0]!, ...pointLines, closing, ...hook.sentences.slice(1)];
    const budget = charBudget(request.durationSec, 1) * 1.06;
    const chosen = new Set<string>();
    let used = 0;
    for (const sentence of candidates) {
      if (chosen.size > 0 && used + sentence.length + 1 > budget) continue;
      chosen.add(sentence);
      used += sentence.length + 1;
    }
    const spoken = [...hook.sentences, ...pointLines, closing].filter((sentence) =>
      chosen.has(sentence),
    );
    return [toScene({ ...hook, title: capitalize(analysis.subject) }, spoken)];
  }

  const bodyCount = count - 2;
  const chosenBody = body.slice(0, bodyCount);
  // Key points that did not get their own scene are still said, in the last point scene.
  if (points > bodyCount && bodyCount > 0) {
    const last = chosenBody[bodyCount - 1]!;
    const extra = body.slice(bodyCount, points).map((block) => block.sentences[0]!);
    chosenBody[bodyCount - 1] = {
      ...last,
      sentences: [last.sentences[0]!, ...extra, ...last.sentences.slice(1)],
    };
  }
  return fitBlocks([hook, ...chosenBody, close], request.durationSec);
}

/* ------------------------------------ extractive mode ------------------------------------ */

const BOILERPLATE =
  /https?:\/\/|www\.|@|©|cookies?\b|all rights reserved|todos los derechos|suscr[ií]bete|subscribe|newsletter|iniciar sesi[oó]n|log ?in\b|sign ?up|pol[ií]tica de privacidad|privacy policy|aviso legal|terms of (?:use|service)|haz clic|click here|leer m[aá]s|read more|compartir en|share on/iu;

interface Candidate {
  index: number;
  text: string;
  words: string[];
  score: number;
}

function usableSentences(material: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const [index, raw] of splitSentences(material).entries()) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length < 25 || text.length > 320) continue;
    if (BOILERPLATE.test(text)) continue;
    const letters = text.replace(/[^\p{L}]/gu, '').length;
    if (letters / text.length < 0.6 || text.split(' ').length < 4) continue;
    const key = fold(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ index, text: ensureFinalStop(text), words: keywords(text), score: 0 });
  }
  return out;
}

function scoreCandidates(candidates: Candidate[], subject: string): void {
  const frequency = new Map<string, number>();
  for (const candidate of candidates) {
    for (const word of candidate.words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  const subjectWords = new Set(keywords(subject));
  const lead = Math.max(1, Math.ceil(candidates.length * 0.15));
  for (const [position, candidate] of candidates.entries()) {
    if (candidate.words.length === 0) continue;
    const unique = [...new Set(candidate.words)];
    // Words that recur across the text carry its subject; one-off words carry no weight.
    const mass = unique.reduce((sum, word) => sum + ((frequency.get(word) ?? 1) - 1), 0);
    const overlap = unique.filter((word) => subjectWords.has(word)).length;
    candidate.score =
      (mass / Math.sqrt(unique.length + 2)) * (position < lead ? 1.25 : 1) + overlap * 0.75;
  }
}

/** The word of `text` behind a keyword, as written ("Energía" for the stem "energia"). */
function surfaceForm(text: string, keyword: string): string | null {
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (word !== '' && stem(fold(word)) === keyword) return word;
  }
  return null;
}

function headlineOf(sentence: string): string {
  const clause = sentence.split(/[,;:—–(]| - /u)[0] ?? sentence;
  return clip(clause.replace(/[.!?…]+$/u, ''), 48);
}

function extractiveScenes(
  request: ScriptGenerationRequest,
  analysis: Analysis,
  book: ScriptPhrasebook,
): GeneratedScene[] | null {
  const candidates = usableSentences(analysis.material);
  if (candidates.length === 0) return null;
  scoreCandidates(candidates, analysis.subject);

  const audience = request.audience?.trim() ?? '';
  const render = (template: string) => fill(template, book, analysis.subject, audience, true);
  const toneHook = (book.hook[request.tone] ?? book.hook.default).map(render);
  const allClose = (book.close[request.tone] ?? book.close.default).map(render);
  // Notes without a title: quoting their first sentence as "the subject" would say it twice,
  // so the opening and closing use the lines that do not name the subject.
  const toneClose = analysis.subjectIsExcerpt ? allClose.slice(1) : allClose;
  const hookSentences = [
    ...(analysis.subjectIsExcerpt ? [] : [render(book.sourceHook)]),
    ...(audience !== '' ? [render(book.audience)] : []),
    ...toneHook.slice(1),
  ];

  const count = Math.min(MAX_SCENES, request.sceneCount ?? autoSceneCount(request.durationSec));
  const framed = count >= 3;
  // The opening line (and, with three or more scenes, the closing line) is always spoken.
  const frameChars = hookSentences[0]!.length + 1 + (framed ? toneClose[0]!.length + 1 : 0);
  const budget = Math.max(0, charBudget(request.durationSec, count) - frameChars);

  // Best sentences first, as many as fit; then back to their original order.
  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: Candidate[] = [];
  let used = 0;
  for (const candidate of ranked) {
    if (chosen.length > 0 && used + candidate.text.length + 1 > budget * 1.05) continue;
    chosen.push(candidate);
    used += candidate.text.length + 1;
  }
  chosen.sort((a, b) => a.index - b.index);

  const frequency = new Map<string, number>();
  for (const candidate of candidates) {
    for (const word of new Set(candidate.words)) {
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }
  const usedLabels = new Set<string>();
  const sceneFrom = (group: Candidate[], number: number): Block => {
    const text = group.map((candidate) => candidate.text).join(' ');
    // The most recurrent word of the text that no earlier scene already carries in its title.
    const top = [...new Set(group.flatMap((candidate) => candidate.words))]
      .filter((word) => !/^\p{N}+$/u.test(word) && !usedLabels.has(word))
      .sort((a, b) => (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0))[0];
    if (top) usedLabels.add(top);
    const label = top ? surfaceForm(text, top) : null;
    const part = book.partTitle.replace('{n}', String(number));
    return {
      title: label ? `${part}: ${capitalize(label)}` : part,
      headline: headlineOf(group[0]!.text),
      sentences: group.map((candidate) => candidate.text),
    };
  };

  // Contiguous groups of similar length. Unless the caller fixed the number of scenes, a body
  // scene holds about two extracted sentences.
  const bodySlots =
    request.sceneCount !== undefined || !framed
      ? framed
        ? count - 2
        : count
      : Math.min(MAX_SCENES - 2, Math.ceil(chosen.length / 2));
  const groupCount = Math.max(1, Math.min(bodySlots, chosen.length));
  const perGroup = used / groupCount;
  const groups: Candidate[][] = [];
  let current: Candidate[] = [];
  let currentChars = 0;
  for (const [position, candidate] of chosen.entries()) {
    const remainingItems = chosen.length - position;
    const remainingGroups = groupCount - groups.length;
    if (
      current.length > 0 &&
      groups.length < groupCount - 1 &&
      (currentChars + candidate.text.length / 2 > perGroup || remainingItems < remainingGroups)
    ) {
      groups.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(candidate);
    currentChars += candidate.text.length + 1;
  }
  if (current.length > 0) groups.push(current);

  const bodyBlocks = groups.map((group, index) => sceneFrom(group, index + 1));
  const bodyScenes = bodyBlocks.map((block) => toScene(block, block.sentences));
  if (!framed) {
    // One or two scenes: no room for a separate opening and closing.
    const first = bodyBlocks[0]!;
    const opening = toScene({ ...first, title: clip(capitalize(analysis.subject), 60) }, [
      hookSentences[0]!,
      ...first.sentences,
    ]);
    return [opening, ...bodyScenes.slice(1)];
  }

  const hook: Block = {
    title: book.hookTitle,
    headline: clip(capitalize(analysis.subject), 48),
    sentences: hookSentences,
  };
  const close: Block = {
    title: book.closeTitle,
    headline: book.closeHeadline,
    sentences: toneClose,
  };
  // Opening and closing grow into whatever time the extracted sentences left over.
  const bodySeconds = bodyScenes.reduce((sum, scene) => sum + scene.estimatedSec, 0);
  const [hookScene, closeScene] = fitBlocks(
    [hook, close],
    Math.max(0, request.durationSec - bodySeconds),
  );
  return [hookScene!, ...bodyScenes, closeScene!];
}

/* ----------------------------------------- entry ----------------------------------------- */

export function generateLocalScript(
  request: ScriptGenerationRequest,
  provider: ProviderRef,
): GeneratedScript {
  const book = SCRIPT_PHRASEBOOKS[request.language];
  const analysis = analyse(request);
  const scenes =
    (analysis.material !== '' ? extractiveScenes(request, analysis, book) : null) ??
    templateScenes(request, analysis, book);
  const sourceTitle = request.sourceTitle?.trim() ?? '';
  return {
    title: clip(capitalize(sourceTitle || analysis.subject), 80),
    language: request.language,
    scenes,
    provider,
    basicMode: true,
    sourceTitle: sourceTitle !== '' ? sourceTitle : null,
  };
}
