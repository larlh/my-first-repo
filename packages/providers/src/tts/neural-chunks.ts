import { closingPause, tokenMarks } from './neural-phonemes';
import type { SpokenWord } from './neural-phonemes';
import { SENTENCE_PAUSE_MS } from './text';
import type { PreparedSpeech } from './text';

/* -------------------------------------------------------------------------------------------
 * From spoken words to what a neural voice is asked to say in ONE inference.
 *
 * A neural voice sounds best on the kind of input it was trained on: Piper on one sentence,
 * Kokoro on a few sentences (about 100–200 symbols; it rushes near its 510-symbol limit and is
 * weak on very short inputs). A long script is therefore cut into CHUNKS:
 *
 *   - always at paragraph ends and at explicit pauses (`<break time="2s"/>`),
 *   - at sentence ends, packing whole sentences up to the voice's symbol budget,
 *   - inside a sentence only when it alone exceeds the budget: at the last comma or semicolon
 *     that fits, else at a space.
 *
 * Between two chunks the provider inserts the silence written here; INSIDE a chunk the pauses
 * at punctuation are the ones the model itself makes, which is what sounds natural.
 * ----------------------------------------------------------------------------------------- */

/** One symbol of the model's alphabet with what it stands for. */
export interface ChunkSymbol {
  text: string;
  /** Display token (word cue) it belongs to. */
  token: number;
  /** `speech` = part of a spoken word; `silent` = a space or a punctuation mark. */
  role: 'speech' | 'silent';
}

/** What a voice's alphabet must provide to lay a text out in symbols. */
export interface VoiceAlphabet {
  /** Symbols of one spoken word (eSpeak phonemes of the word, in order). */
  word(phonemes: readonly string[]): string[];
  /** Symbols of the opening / closing marks of a display token (may be none). */
  marks(marks: string, position: 'leading' | 'trailing'): string[];
  /** The word separator. */
  space: string;
}

export interface ChunkPolicy {
  /** Whole sentences are packed into a chunk up to this many symbols (1 = one per chunk). */
  targetSymbols: number;
  /** Never more than this many symbols in one inference. */
  maxSymbols: number;
}

export interface SpeechChunk {
  symbols: ChunkSymbol[];
  /** Silence after the chunk at normal speed, in ms (0 after the last one). */
  pauseAfterMs: number;
  /** False for a pause the user wrote (`<break>`): its length does not follow the speed. */
  pauseScales: boolean;
}

/** One display token laid out in symbols, with how it ends. */
export interface TokenUnit {
  token: number;
  symbols: ChunkSymbol[];
  /** `sentence` / `clause` / none, from its closing marks. */
  boundary: 'sentence' | 'clause' | '';
  /** Silence that MUST follow this unit (paragraph end, explicit break), or 0. */
  hardPauseMs: number;
  hardPauseScales: boolean;
}

/** A pause eSpeak makes that is longer than this was written by the user (`<break>`). */
const EXPLICIT_BREAK_MS = 700;
/** Silence where a sentence had to be cut at a comma, and at a space. */
const CLAUSE_SPLIT_PAUSE_MS = 140;
const WORD_SPLIT_PAUSE_MS = 0;

/**
 * Lay the spoken words of one prepared segment out as token units. `segmentPauseMs` is the
 * pause `prepareSpeech` wants after the segment (paragraph or sentence; 0 for the last).
 */
export function segmentUnits(
  prepared: PreparedSpeech,
  words: readonly SpokenWord[],
  alphabet: VoiceAlphabet,
  segmentPauseMs: number,
): TokenUnit[] {
  const units: TokenUnit[] = [];
  let index = 0;
  while (index < words.length) {
    const token = words[index]?.token ?? 0;
    const group: SpokenWord[] = [];
    while (index < words.length && words[index]?.token === token) {
      const word = words[index];
      if (word) group.push(word);
      index += 1;
    }
    const marks = tokenMarks(prepared.tokens[token]?.text ?? '');
    const last = index >= words.length;
    const pauseMs = group[group.length - 1]?.pauseAfterMs ?? 0;
    const symbols: ChunkSymbol[] = [];
    const push = (texts: readonly string[], role: ChunkSymbol['role']) => {
      for (const text of texts) symbols.push({ text, token, role });
    };
    push(alphabet.marks(marks.leading, 'leading'), 'silent');
    group.forEach((word, i) => {
      if (i > 0) push([alphabet.space], 'silent');
      push(alphabet.word(word.phonemes), 'speech');
    });
    // A closing mark only stands for a pause when eSpeak made one there ("Dr. Smith", "U.S."
    // and "3.5" have dots that are not pauses).
    const pauses = pauseMs > 0 || last;
    const closing = pauses ? closingPause(marks.trailing) : '';
    if (pauses) push(alphabet.marks(marks.trailing, 'trailing'), 'silent');
    const explicit = pauseMs >= EXPLICIT_BREAK_MS;
    units.push({
      token,
      symbols,
      boundary:
        closing === '.' || closing === '?' || closing === '!' || closing === '…'
          ? 'sentence'
          : closing !== ''
            ? 'clause'
            : '',
      // An explicit break at the very end of a segment replaces the segment's own pause.
      hardPauseMs: explicit
        ? Math.max(pauseMs, last ? segmentPauseMs : 0)
        : last
          ? segmentPauseMs
          : 0,
      hardPauseScales: !explicit,
    });
  }
  return units.filter((unit) => unit.symbols.some((symbol) => symbol.role === 'speech'));
}

function symbolCount(units: readonly TokenUnit[], space: boolean): number {
  let count = 0;
  for (const unit of units) count += unit.symbols.length;
  return count + (space ? Math.max(0, units.length - 1) : 0);
}

/** Join token units with the word separator into the symbols of one chunk. */
function joinUnits(units: readonly TokenUnit[], space: string): ChunkSymbol[] {
  const out: ChunkSymbol[] = [];
  units.forEach((unit, i) => {
    if (i > 0) out.push({ text: space, token: unit.token, role: 'silent' });
    out.push(...unit.symbols);
  });
  return out;
}

/** Cut one over-long sentence into pieces that fit: at clause ends when possible. */
function splitSentence(
  sentence: readonly TokenUnit[],
  maxSymbols: number,
): { units: TokenUnit[]; pauseMs: number }[] {
  const pieces: { units: TokenUnit[]; pauseMs: number }[] = [];
  let rest = [...sentence];
  while (symbolCount(rest, true) > maxSymbols && rest.length > 1) {
    let fit = 1;
    while (fit < rest.length && symbolCount(rest.slice(0, fit + 1), true) <= maxSymbols) fit += 1;
    let cut = fit;
    // Prefer the last clause end in the second half of what fits.
    for (let i = fit; i > Math.max(1, Math.floor(fit / 2)); i -= 1) {
      if (rest[i - 1]?.boundary === 'clause') {
        cut = i;
        break;
      }
    }
    const clause = rest[cut - 1]?.boundary === 'clause';
    pieces.push({
      units: rest.slice(0, cut),
      pauseMs: clause ? CLAUSE_SPLIT_PAUSE_MS : WORD_SPLIT_PAUSE_MS,
    });
    rest = rest.slice(cut);
  }
  pieces.push({ units: rest, pauseMs: 0 });
  return pieces;
}

/**
 * Chunks of a whole text. `units` are the token units of every segment in order (each
 * segment's last unit carries the segment pause).
 */
export function planChunks(
  units: readonly TokenUnit[],
  alphabet: VoiceAlphabet,
  policy: ChunkPolicy,
): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  let current: TokenUnit[] = [];
  const flush = (pauseAfterMs: number, pauseScales: boolean) => {
    if (current.length === 0) {
      // Nothing spoken since the last flush: the pause still counts (the longer one wins).
      const previous = chunks[chunks.length - 1];
      if (previous && pauseAfterMs > previous.pauseAfterMs) {
        previous.pauseAfterMs = pauseAfterMs;
        previous.pauseScales = pauseScales;
      }
      return;
    }
    chunks.push({ symbols: joinUnits(current, alphabet.space), pauseAfterMs, pauseScales });
    current = [];
  };

  let sentence: TokenUnit[] = [];
  const endSentence = (pauseMs: number, scales: boolean, hard: boolean) => {
    if (sentence.length === 0) {
      if (hard) flush(pauseMs, scales);
      return;
    }
    const pieces = splitSentence(sentence, policy.maxSymbols);
    sentence = [];
    pieces.forEach((piece, i) => {
      const lastPiece = i === pieces.length - 1;
      const size = symbolCount(piece.units, true);
      // Start a new chunk when this sentence does not fit next to what is already packed.
      if (
        current.length > 0 &&
        symbolCount(current, true) + 1 + size > Math.max(1, policy.targetSymbols)
      ) {
        flush(SENTENCE_PAUSE_MS, true);
      }
      current.push(...piece.units);
      if (!lastPiece) flush(piece.pauseMs, true);
    });
    if (hard) flush(pauseMs, scales);
  };

  for (const unit of units) {
    sentence.push(unit);
    if (unit.hardPauseMs > 0) endSentence(unit.hardPauseMs, unit.hardPauseScales, true);
    else if (unit.boundary === 'sentence') endSentence(SENTENCE_PAUSE_MS, true, false);
  }
  endSentence(0, true, false);
  flush(0, true);
  const last = chunks[chunks.length - 1];
  if (last) last.pauseAfterMs = 0;
  return chunks;
}
