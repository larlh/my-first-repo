/* -------------------------------------------------------------------------------------------
 * Small text toolkit of the local ("modo básico") LLM replacement: sentence splitting,
 * keyword extraction and scoring. Pure and deterministic.
 * ----------------------------------------------------------------------------------------- */

/** Function words of the supported languages (accent-free, lowercase). */
const STOPWORDS = new Set(
  // es
  (
    'a al algo algun alguna algunas alguno algunos ante antes aquel aquella aquello aqui asi aun aunque cada ' +
    'como con contra cual cuales cuando cuanto de del desde donde dos el ella ellas ello ellos en entre era ' +
    'eran eres es esa esas ese eso esos esta estaba estan estar estas este esto estos fue fueron ha habia han ' +
    'hasta hay la las le les lo los mas me mi mis mucho muy nada ni no nos nosotros nuestra nuestras nuestro ' +
    'nuestros o os otra otras otro otros para pero poco por porque que quien quienes se sea segun ser si sido ' +
    'sin sobre son su sus tal tambien tan tanto te tengo tiene tienen todo todos tu tus un una unas uno unos ' +
    'usted ustedes va van vosotros y ya yo puedo puede pueden podria quiero quiere hacer hace hago dime ' +
    'decir saber sabes cuentame hola gracias favor vuestra vuestras vuestro vuestros teneis tenemos ' +
    // en
    'about above after again all also am an and any are as at be because been before being below between ' +
    'both but by can could did do does doing down during each few for from further had has have having he ' +
    'her here hers him his how i if in into is it its just me more most my no nor not now of off on once only ' +
    'or other our ours out over own same she should so some such than that the their theirs them then there ' +
    'these they this those through to too under until up very was we were what when where which while who ' +
    'whom why will with would you your yours tell know want need please hello hi thanks thank get got ' +
    // fr
    'au aux avec ce ces cette dans des du elle elles et etre il ils je le les leur leurs lui ma mais mes moi ' +
    'mon ne nos notre nous ou par pas pour qu que quel quelle qui sa se ses son sur ta te tes toi ton tu un ' +
    'une vos votre vous est sont etait ete avoir fait plus tres bonjour merci ' +
    // de
    'aber als am auch auf aus bei bin bis das dass dein deine dem den der des die dir du durch ein eine einem ' +
    'einen einer eines er es euch fur hat hatte ich ihm ihn ihr ihre im ist ja kann mein meine mich mir mit ' +
    'nach nicht noch nur oder sein seine sich sie sind um und uns unser unter vom von vor war was wenn wer ' +
    'wie wir wird zu zum zur uber hallo danke bitte ' +
    // it
    'ad agli ai alla alle anche che chi ci cosa cui da dal dalla degli dei della delle di dove e ed gli ha ' +
    'hanno il io le lei lo loro lui ma mi mia mio nei nel nella noi non nostra nostro per piu quale quando ' +
    'quello questa questo se sei si sono sua sue sul sulla suo tra tua tuo tutti tutto un una uno voi ciao ' +
    'grazie ' +
    // pt
    'ao aos as com da das dela dele do dos ela elas ele eles em entre essa esse esta este eu foi isso isto ja ' +
    'mais mas me meu minha muito na nao nas nem no nos nossa nosso num numa os ou para pela pelo por qual ' +
    'quando que quem sao se sem ser seu sua tambem te tem um uma voce voces ola obrigado obrigada ' +
    // ca / nl / sv
    'amb aixo aquest aquesta els les dels pel per que es son una uns unes hi ha hem heu ' +
    'de het een en van ik je dat niet op te zijn voor met als maar om ook dan zo of bij nog wel naar ' +
    'och att det som en pa ar av for med till den har inte om ett han men var jag sig fran vi sa kan'
  ).split(/\s+/),
);

/** Lowercase and remove accents (keeps letters of every script). */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');
}

/** Light plural stripping so that "precios" matches "precio" and "plans" matches "plan". */
export function stem(word: string): string {
  if (word.length > 5 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Content words of a text: folded, stemmed, without function words. Numbers are kept. */
export function keywords(text: string): string[] {
  const out: string[] = [];
  for (const raw of fold(text).split(/[^\p{L}\p{N}]+/u)) {
    if (raw === '') continue;
    const isNumber = /^\p{N}+$/u.test(raw);
    if (!isNumber && (raw.length < 3 || STOPWORDS.has(raw))) continue;
    out.push(isNumber ? raw : stem(raw));
  }
  return out;
}

const ABBREVIATIONS =
  /\b(?:sr|sra|srta|dr|dra|d|dña|ud|uds|etc|pág|p\.ej|ej|núm|art|mr|mrs|ms|prof|inc|ltd|vs|no|st|approx|e\.g|i\.e|m|mme|mlle|bzw|z\.b|ca|nr)\.$/iu;

/**
 * Split a text into sentences. Understands `.`, `!`, `?`, `…`, the Spanish inverted marks,
 * decimals ("3.5"), common abbreviations and line breaks (each line is its own unit).
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const line of text.split(/\r?\n+/)) {
    const clean = line.replace(/\s+/g, ' ').trim();
    if (clean === '') continue;
    let start = 0;
    const pattern = /[.!?…]+["'»”)\]]*(?=\s+|$)/gu;
    for (const match of clean.matchAll(pattern)) {
      const end = match.index + match[0].length;
      const candidate = clean.slice(start, end);
      // "3.5 million" and "Dr. Smith" do not end a sentence.
      if (match[0].startsWith('.') && ABBREVIATIONS.test(candidate)) continue;
      const next = clean.slice(end).trimStart();
      if (match[0] === '.' && next !== '' && /^[\p{Ll}\p{N}]/u.test(next)) continue;
      sentences.push(candidate.trim());
      start = end;
    }
    const rest = clean.slice(start).trim();
    if (rest !== '') sentences.push(rest);
  }
  return sentences;
}

/** `text` ends with sentence punctuation (adds a full stop otherwise). */
export function ensureFinalStop(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return trimmed;
  return /[.!?…]["'»”)\]]*$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function capitalize(text: string): string {
  const trimmed = text.trim();
  const first = trimmed.match(/^[¿¡"'«“(]*\p{L}/u)?.[0];
  if (!first) return trimmed;
  return first.slice(0, -1) + first.slice(-1).toLocaleUpperCase() + trimmed.slice(first.length);
}

/** Cut at a word boundary, adding an ellipsis when something was removed. */
export function clip(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > maxChars * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/u, '')}…`;
}

/** Deterministic 32-bit hash (FNV-1a) used to vary phrasing between topics without randomness. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Inverse document frequency of each keyword over a set of passages. */
export function inverseDocumentFrequency(documents: readonly string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of documents) {
    for (const word of new Set(doc)) df.set(word, (df.get(word) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [word, count] of df) {
    idf.set(word, Math.log(1 + documents.length / count));
  }
  return idf;
}
