import type { ChatReply, ChatRequest, ProviderRef } from '@parlante/shared';
import { CHAT_PHRASES } from './chat-phrases';
import {
  clip,
  ensureFinalStop,
  fold,
  inverseDocumentFrequency,
  keywords,
  splitSentences,
} from './text';

/* -------------------------------------------------------------------------------------------
 * Local chat of the interactive avatar ("modo básico"): retrieval over the persona's own
 * knowledge, not a language model.
 *
 *  1. The persona's knowledge (FAQ text, "Q: … / A: …" pairs, headings, paragraphs) is split
 *     into passages. The user's question is matched against them by shared content words,
 *     weighted by how specific each word is.
 *  2. A good match is answered with THE STORED TEXT (the answer of the pair, or the most
 *     relevant sentences of the paragraph) — never invented or rephrased.
 *  3. Greetings, thanks, goodbyes and "who are you" get a fixed line.
 *  4. Anything else gets an honest "I do not have that information", listing what the avatar
 *     does know about.
 * It does not follow the persona's instructions (tone, role play): only an LLM can.
 * ----------------------------------------------------------------------------------------- */

interface Passage {
  /** Question or heading that introduces the passage, when there is one. */
  title: string;
  /** Text spoken as the answer. */
  answer: string;
  titleWords: string[];
  answerWords: string[];
}

const QUESTION_PREFIX = /^\s*(?:q|p|pregunta|question|frage|domanda|pergunta|vraag)\s*[:.)-]\s*/iu;
const ANSWER_PREFIX =
  /^\s*(?:a|r|respuesta|answer|réponse|reponse|antwort|risposta|resposta|antwoord)\s*[:.)-]\s*/iu;
const HEADING = /^\s*#{1,6}\s+/u;
/** A line that OPENS with one question (no earlier sentence end) and goes on with its answer. */
const INLINE_QUESTION = /^\s*([^.!?？…]{3,200}[?？])\s+(\S.*)$/u;
const BULLET = /^\s*(?:[-–—•*]|\d{1,2}[.)])\s+/u;

/** Sentences of the instructions that order the avatar around are not facts to recite. */
const DIRECTIVE =
  /^(?:eres|actua|actúa|responde|contesta|habla|sé |no |nunca|siempre|usa|utiliza|evita|manten|mantén|tu (?:tarea|objetivo|papel)|you are|act as|answer|respond|reply|speak|be |do not|don't|never|always|use |avoid|keep|your (?:task|goal|role|job))/iu;

function passage(title: string, answer: string): Passage | null {
  const cleanAnswer = answer.replace(/\s+/g, ' ').trim();
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  if (cleanAnswer === '') return null;
  return {
    title: cleanTitle,
    answer: cleanAnswer,
    titleWords: keywords(cleanTitle),
    answerWords: keywords(cleanAnswer),
  };
}

/** Split the knowledge text into question/answer pairs, headed sections and paragraphs. */
export function parseKnowledge(knowledge: string): Passage[] {
  const passages: Passage[] = [];
  const push = (title: string, answer: string) => {
    const made = passage(title, answer);
    if (made) passages.push(made);
  };

  for (const block of knowledge.split(/\r?\n\s*\r?\n/)) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (lines.length === 0) continue;

    let title = '';
    let body: string[] = [];
    const flush = () => {
      if (body.length === 0) return;
      const text = body.join(' ');
      // Long untitled paragraphs are cut into windows so an answer stays short.
      if (title === '' && text.length > 420) {
        const sentences = splitSentences(text);
        for (let i = 0; i < sentences.length; i += 2) {
          push('', sentences.slice(i, i + 3).join(' '));
        }
      } else {
        push(title, text);
      }
      body = [];
    };

    for (const line of lines) {
      const isQuestion = QUESTION_PREFIX.test(line) && !ANSWER_PREFIX.test(line);
      if (HEADING.test(line) || isQuestion || /[?？]$/u.test(line)) {
        flush();
        title = line.replace(HEADING, '').replace(QUESTION_PREFIX, '');
        continue;
      }
      // "¿Cuál es el horario? De lunes a viernes." — question and answer on ONE line, the way
      // people type a FAQ (and the way the product's own example shows it).
      const inline = INLINE_QUESTION.exec(line.replace(BULLET, ''));
      if (inline) {
        flush();
        title = inline[1]!;
        body.push(inline[2]!.replace(ANSWER_PREFIX, ''));
        continue;
      }
      body.push(line.replace(ANSWER_PREFIX, '').replace(BULLET, ''));
    }
    flush();
  }
  return passages;
}

function factsFromInstructions(instructions: string): Passage[] {
  const out: Passage[] = [];
  for (const sentence of splitSentences(instructions)) {
    if (DIRECTIVE.test(sentence.trim())) continue;
    const made = passage('', ensureFinalStop(sentence));
    if (made && made.answerWords.length >= 2) out.push(made);
  }
  return out;
}

type Intent = 'greeting' | 'thanks' | 'bye' | 'identity' | 'howAreYou';

const INTENTS: [Intent, RegExp][] = [
  [
    'identity',
    /\b(?:quien eres|como te llamas|cual es tu nombre|que eres|who are you|what is your name|what s your name|what are you|qui es tu|comment t appelles tu|comment vous appelez vous|wer bist du|wer sind sie|wie heisst du|wie heissen sie|chi sei|come ti chiami|quem e voce|como voce se chama|qual e o seu nome|wie ben je|hoe heet je|qui ets|com et dius|kim jestes|jak masz na imie|vem ar du|vad heter du|sen kimsin|adin ne)\b|кто ты|кто вы|как тебя зовут|как вас зовут|ποιος εισαι|πως σε λενε/u,
  ],
  [
    'howAreYou',
    /\b(?:como estas|que tal|como te va|how are you|how is it going|how s it going|comment ca va|ca va|comment allez vous|wie geht es|wie geht s|come stai|come va|como vai|tudo bem|hoe gaat het|com estas|com va|jak sie masz|co slychac|hur mar du|nasilsin|nasilsiniz)\b|как дела|как поживаете|τι κανεις|τι κανετε/u,
  ],
  [
    'thanks',
    /\b(?:gracias|muchas gracias|thanks|thank you|thx|merci|danke|dankeschon|vielen dank|grazie|obrigad[oa]|dank je|dank u|bedankt|gracies|merces|dziekuje|dzieki|tack|tesekkurler|tesekkur ederim|sagol)\b|спасибо|благодарю|ευχαριστω/u,
  ],
  [
    'bye',
    /\b(?:adios|hasta luego|hasta pronto|hasta manana|chao|chau|nos vemos|bye|goodbye|good bye|see you|au revoir|a bientot|tschuss|auf wiedersehen|bis bald|arrivederci|ciao ciao|a presto|tchau|ate logo|ate breve|doei|tot ziens|adeu|fins aviat|do widzenia|na razie|hej da|vi ses|gorusuruz|hosca kal)\b|до свидания|пока|αντιο|τα λεμε/u,
  ],
  [
    'greeting',
    /\b(?:hola|buenas|buenos dias|buenas tardes|buenas noches|hello|hi|hey|good morning|good afternoon|good evening|bonjour|bonsoir|salut|coucou|hallo|guten tag|guten morgen|guten abend|servus|ciao|buongiorno|buonasera|salve|ola|bom dia|boa tarde|boa noite|hoi|goedemorgen|goedemiddag|bon dia|bona tarda|czesc|dzien dobry|witam|hej|hejsan|god morgon|merhaba|selam|gunaydin)\b|привет|здравствуйте|добрый день|γεια|καλημερα|καλησπερα/u,
  ],
];

function detectIntent(text: string): Intent | null {
  const normalized = fold(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  for (const [intent, pattern] of INTENTS) {
    if (pattern.test(normalized)) return intent;
  }
  return null;
}

interface Match {
  passage: Passage;
  /** 0..1: share of the question's (weighted) content words found in the passage. */
  coverage: number;
  matched: Set<string>;
}

/** "hora" ~ "horario", "cancel" ~ "cancelar": equal, or one is the beginning of the other. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function findWord(word: string, words: readonly string[]): string | null {
  return words.find((candidate) => sameWord(word, candidate)) ?? null;
}

function bestMatch(question: string[], passages: Passage[]): Match | null {
  if (question.length === 0 || passages.length === 0) return null;
  const idf = inverseDocumentFrequency(passages.map((p) => [...p.titleWords, ...p.answerWords]));
  const unique = [...new Set(question)];
  const vocabulary = [...idf.keys()];
  // Weight of each question word: how specific it is in the knowledge. Words the knowledge
  // never uses still count against the match, at half the weight of a rare word (they are
  // often filler: "policy", "information").
  const unknown = Math.log(1 + passages.length) / 2;
  const weights = new Map<string, number>();
  for (const word of unique) {
    const known = findWord(word, vocabulary);
    weights.set(word, known ? (idf.get(known) ?? unknown) : unknown);
  }
  const total = unique.reduce((sum, word) => sum + (weights.get(word) ?? 0), 0);
  let best: Match | null = null;
  for (const candidate of passages) {
    const matched = new Set<string>();
    let score = 0;
    for (const word of unique) {
      const weight = weights.get(word) ?? 0;
      const inTitle = findWord(word, candidate.titleWords);
      const inAnswer = inTitle ? null : findWord(word, candidate.answerWords);
      if (inTitle) {
        score += weight; // a hit in the question / heading is the strongest signal
        matched.add(inTitle);
      } else if (inAnswer) {
        score += weight * 0.8;
        matched.add(inAnswer);
      }
    }
    const coverage = total > 0 ? score / total : 0;
    if (!best || coverage > best.coverage) best = { passage: candidate, coverage, matched };
  }
  return best;
}

/** Enough of the question is covered, and by at least one specific word. */
function isConfident(match: Match | null, question: string[]): match is Match {
  if (!match) return false;
  const specific = [...match.matched].some((word) => word.length >= 4 || /^\p{N}+$/u.test(word));
  const needed = new Set(question).size <= 2 ? 0.45 : 0.34;
  return specific && match.coverage >= needed;
}

function answerFrom(match: Match, question: string[], maxSentences: number): string {
  const sentences = splitSentences(match.passage.answer);
  if (sentences.length <= maxSentences) return clip(ensureFinalStop(match.passage.answer), 600);
  // The sentences that share most words with the question, in their original order; without
  // any such sentence (the match was on the heading) the passage is read from its beginning.
  const ranked = sentences
    .map((sentence, index) => ({
      index,
      hits: keywords(sentence).filter((word) => question.some((asked) => sameWord(asked, word)))
        .length,
    }))
    .sort((a, b) => b.hits - a.hits || a.index - b.index)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index);
  return clip(ranked.map((entry) => sentences[entry.index]).join(' '), 600);
}

function knownTopics(passages: Passage[]): string[] {
  const topics: string[] = [];
  for (const candidate of passages) {
    if (candidate.title === '') continue;
    const label = candidate.title.replace(/^[¿¡\s]+|[?？!.:\s]+$/gu, '');
    if (label.length >= 3 && label.length <= 60 && !topics.includes(label)) topics.push(label);
    if (topics.length === 3) break;
  }
  return topics;
}

export function localChatReply(request: ChatRequest, provider: ProviderRef): ChatReply {
  const phrases = CHAT_PHRASES[request.language];
  const name = request.persona.name.trim() || 'Parlante';
  const say = (text: string): ChatReply => ({
    text: text.replaceAll('{name}', name),
    provider,
  });
  const maxSentences = Math.min(6, Math.max(1, Math.round(request.maxSentences ?? 3)));

  const userTurns = request.messages.filter((message) => message.role === 'user');
  const last = request.messages.at(-1);
  const question = last?.role === 'user' ? last.text.trim() : '';
  if (question === '') return say(userTurns.length === 0 ? phrases.greeting : phrases.empty);

  const knowledge = parseKnowledge(request.persona.knowledge);
  const passages = [...knowledge, ...factsFromInstructions(request.persona.instructions)];
  const questionWords = keywords(question);

  let match = bestMatch(questionWords, passages);
  let confident = isConfident(match, questionWords);
  if (!confident && questionWords.length <= 3) {
    // A short follow-up ("¿y el precio?") leans on the previous question, as long as the
    // passage found also answers to something that was JUST asked.
    const previous = userTurns.at(-2)?.text;
    if (previous) {
      const combined = [...questionWords, ...keywords(previous)];
      const retry = bestMatch(combined, passages);
      const usesNewWords = questionWords.some((word) =>
        [...(retry?.matched ?? [])].some((hit) => sameWord(word, hit)),
      );
      if (isConfident(retry, combined) && usesNewWords) {
        match = retry;
        confident = true;
      }
    }
  }
  if (confident && match) return say(answerFrom(match, questionWords, maxSentences));

  const intent = detectIntent(question);
  if (intent && question.split(/\s+/).length <= 8) return say(phrases[intent]);

  if (passages.length === 0) return say(phrases.noKnowledge);
  const topics = knownTopics(knowledge);
  return say(
    topics.length > 0
      ? `${phrases.noMatch} ${phrases.topics.replace('{topics}', topics.join('; '))}`
      : phrases.noMatch,
  );
}
