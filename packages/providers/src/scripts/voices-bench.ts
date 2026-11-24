import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { TTSProvider } from '@parlante/shared';
import { parseEnv } from '@parlante/shared/node';
import { providerEnvSchema } from '../env';
import { createLocalWhisperStt, disposeWhisperEngines } from '../stt/index';
import { createEspeakProvider } from '../tts/espeak';
import { createKokoroProvider, createPiperProvider } from '../tts/neural';
import { disposeNeuralEngines } from '../tts/neural-engine';
import type { KokoroVariant } from '../tts/neural-models';
import { decodeWav } from '../tts/wav';
import { analyzeVoice } from '../voice-clone/analysis';

/* -------------------------------------------------------------------------------------------
 * Measurements behind the voice table of docs/MODELS.md. A developer tool, not part of the
 * product: it speaks a fixed set of sentences with one voice THROUGH THE PRODUCT PROVIDERS and
 * measures what can be measured without ears.
 *
 *   tsx src/scripts/voices-bench.ts synth --provider kokoro --voice ef_dora --lang es
 *        [--variant fp32] [--dir <models>] --out <folder>
 *     one fresh process per candidate: compute time per second of audio (first phrase apart,
 *     it includes loading the model), peak memory of the process, median pitch, and how far
 *     the onsets of sound after a pause are from the nearest word cue.
 *
 *   tsx src/scripts/voices-bench.ts compare --variants fp32,uint8,q8 --voice ef_dora --lang es
 *        [--rounds 5] [--dir <models>] --out <folder>
 *     the same phrases with several Kokoro precisions in ONE process, in interleaved rounds
 *     (A B C, A B C…): on a machine that is busy with other work the best round of each is
 *     the fair comparison, because every candidate met the same mix of loads.
 *
 *   tsx src/scripts/voices-bench.ts latency --kind sentence|paragraph [--provider kokoro]
 *        [--voice ef_dora] [--lang es] --out <folder>
 *     how long a person waits: one sentence of about 5 s of speech, or one paragraph of about
 *     30 s. In a fresh process the first request is the COLD one (the thread starts and the
 *     model loads); it is followed by three WARM ones with other texts of the same length.
 *
 *   tsx src/scripts/voices-bench.ts align --out <folder>
 *     recomputes the alignment figures of every candidate from the WAV and timeline files it
 *     left (no model is loaded).
 *
 *   tsx src/scripts/voices-bench.ts wer --out <folder>
 *     transcribes every phrase of every candidate under <folder> with the local Whisper model
 *     of the repository and prints the word error rate against the text that was spoken.
 *
 * No recordings of people are involved: everything is synthesised here.
 * ----------------------------------------------------------------------------------------- */

/** Plain sentences (no digits, no abbreviations): what the word error rate is computed on. */
const PLAIN: Readonly<Record<string, readonly string[]>> = {
  es: [
    'El tiempo en la costa será soleado durante todo el fin de semana.',
    'Nuestra empresa presenta hoy una nueva forma de crear vídeos con avatares.',
    'Para empezar, escribe el guion y elige la voz que más te guste.',
    'La reunión de mañana se ha cambiado a las cuatro de la tarde.',
    'Gracias por confiar en nosotros; te responderemos lo antes posible.',
    'Este curso explica paso a paso cómo preparar una presentación eficaz.',
    'Los niños jugaban en el parque mientras sus padres conversaban tranquilamente.',
    'Si tienes alguna pregunta, puedes escribirnos a cualquier hora del día.',
    'La ciudad antigua conserva murallas, plazas pequeñas y calles muy estrechas.',
    'Hemos mejorado el producto gracias a las sugerencias de nuestros clientes.',
    'Recuerda guardar los cambios antes de cerrar la ventana del navegador.',
    'El tren con destino a Sevilla saldrá con unos minutos de retraso.',
  ],
  en: [
    'The weather on the coast will be sunny for the whole weekend.',
    'Our company is presenting a new way to create videos with avatars today.',
    'To get started, write the script and choose the voice you like best.',
    "Tomorrow's meeting has been moved to four o'clock in the afternoon.",
    'Thank you for trusting us; we will answer as soon as possible.',
    'This course explains step by step how to prepare an effective presentation.',
    'The children were playing in the park while their parents talked quietly.',
    'If you have any questions, you can write to us at any time of day.',
    'The old town still has its walls, small squares and very narrow streets.',
    'We have improved the product thanks to the suggestions of our customers.',
    'Remember to save your changes before closing the browser window.',
    'The train to Manchester will leave a few minutes behind schedule.',
  ],
  fr: [
    'Le temps sur la côte sera ensoleillé pendant tout le week-end.',
    'Notre entreprise présente une nouvelle façon de créer des vidéos.',
    'Pour commencer, écrivez le texte et choisissez la voix que vous préférez.',
    'Merci de votre confiance ; nous vous répondrons dès que possible.',
    'Les enfants jouaient dans le parc pendant que leurs parents discutaient.',
    'La vieille ville conserve ses remparts et ses rues très étroites.',
  ],
  it: [
    'Il tempo sulla costa sarà soleggiato per tutto il fine settimana.',
    'La nostra azienda presenta oggi un nuovo modo di creare video.',
    'Per iniziare, scrivi il testo e scegli la voce che preferisci.',
    'Grazie per la fiducia; ti risponderemo il prima possibile.',
    'I bambini giocavano nel parco mentre i genitori parlavano tranquillamente.',
    'La città vecchia conserva le mura e strade molto strette.',
  ],
  pt: [
    'O tempo na costa será ensolarado durante todo o fim de semana.',
    'A nossa empresa apresenta hoje uma nova forma de criar vídeos.',
    'Para começar, escreva o texto e escolha a voz de que mais gosta.',
    'Obrigado pela confiança; responderemos o mais depressa possível.',
    'As crianças brincavam no parque enquanto os pais conversavam tranquilamente.',
    'A cidade antiga conserva as muralhas e ruas muito estreitas.',
  ],
  de: [
    'Das Wetter an der Küste wird das ganze Wochenende über sonnig sein.',
    'Unser Unternehmen stellt heute eine neue Art vor, Videos zu erstellen.',
    'Schreiben Sie zuerst den Text und wählen Sie die Stimme, die Ihnen gefällt.',
    'Vielen Dank für Ihr Vertrauen; wir antworten so schnell wie möglich.',
    'Die Kinder spielten im Park, während ihre Eltern sich ruhig unterhielten.',
    'Die Altstadt hat noch ihre Mauern und sehr enge Straßen.',
  ],
  nl: [
    'Het weer aan de kust blijft het hele weekend zonnig.',
    'Ons bedrijf presenteert vandaag een nieuwe manier om video te maken.',
    'Schrijf eerst de tekst en kies de stem die je het mooist vindt.',
    'Bedankt voor je vertrouwen; we antwoorden zo snel mogelijk.',
    'De kinderen speelden in het park terwijl hun ouders rustig praatten.',
    'De oude stad heeft nog haar muren en heel smalle straten.',
  ],
  pl: [
    'Pogoda na wybrzeżu będzie słoneczna przez cały weekend.',
    'Nasza firma przedstawia dziś nowy sposób tworzenia filmów.',
    'Na początek napisz tekst i wybierz głos, który najbardziej ci się podoba.',
    'Dziękujemy za zaufanie; odpowiemy tak szybko, jak to możliwe.',
    'Dzieci bawiły się w parku, a ich rodzice spokojnie rozmawiali.',
    'Stare miasto zachowało mury i bardzo wąskie ulice.',
  ],
  ru: [
    'Погода на побережье будет солнечной все выходные.',
    'Наша компания представляет сегодня новый способ создавать видео.',
    'Сначала напишите текст и выберите голос, который вам нравится.',
    'Спасибо за доверие; мы ответим как можно скорее.',
    'Дети играли в парке, пока их родители спокойно разговаривали.',
    'В старом городе сохранились стены и очень узкие улицы.',
  ],
  sv: [
    'Vädret vid kusten blir soligt under hela helgen.',
    'Vårt företag presenterar i dag ett nytt sätt att skapa videor.',
    'Börja med att skriva texten och välj den röst du tycker bäst om.',
    'Tack för ditt förtroende; vi svarar så snart som möjligt.',
    'Barnen lekte i parken medan deras föräldrar pratade lugnt.',
    'Den gamla staden har kvar sina murar och mycket smala gator.',
  ],
  el: [
    'Ο καιρός στην ακτή θα είναι ηλιόλουστος όλο το Σαββατοκύριακο.',
    'Η εταιρεία μας παρουσιάζει σήμερα έναν νέο τρόπο δημιουργίας βίντεο.',
    'Για να ξεκινήσετε, γράψτε το κείμενο και επιλέξτε τη φωνή που σας αρέσει.',
    'Σας ευχαριστούμε για την εμπιστοσύνη· θα απαντήσουμε το συντομότερο δυνατό.',
    'Τα παιδιά έπαιζαν στο πάρκο ενώ οι γονείς τους μιλούσαν ήσυχα.',
    'Η παλιά πόλη διατηρεί τα τείχη της και πολύ στενούς δρόμους.',
  ],
  ca: [
    'El temps a la costa serà assolellat durant tot el cap de setmana.',
    'La nostra empresa presenta avui una nova manera de crear vídeos.',
    'Per començar, escriu el text i tria la veu que més t’agradi.',
    'Gràcies per la confiança; et respondrem tan aviat com sigui possible.',
    'Els nens jugaven al parc mentre els seus pares conversaven tranquil·lament.',
    'La ciutat antiga conserva les muralles i carrers molt estrets.',
  ],
};

/** Real-life texts: numbers, acronyms, signs and accents. Reported with their transcripts. */
const REAL: Readonly<Record<string, readonly string[]>> = {
  es: [
    'El 23 de abril de 2024 la ONU aprobó el 15,5 % del plan (según la OTAN).',
    '¿Sabías que el AVE Madrid–Barcelona tarda 2 h 30 min? ¡Increíble!',
    'Llama al 912 345 678 o escribe a la Dra. Núñez: cuesta 49,99 € al mes.',
    'El PIB creció un 3 % en 2023; la UE y el FMI revisarán sus previsiones.',
  ],
  en: [
    'On May 3rd, 2024, Dr. Smith paid $1,250 — NASA and the FBI agreed.',
    "Did you know the U.S. GDP grew 2.5% in Q3? That's remarkable!",
    'Call 555-0199 or e-mail Mr. O’Neil: it costs £49.99 per month.',
    'The CEO of IBM said AI will change 80% of jobs by 2030.',
  ],
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: 'string' },
    voice: { type: 'string' },
    lang: { type: 'string' },
    variant: { type: 'string' },
    dir: { type: 'string' },
    out: { type: 'string' },
    label: { type: 'string' },
    threads: { type: 'string' },
    variants: { type: 'string' },
    rounds: { type: 'string' },
    kind: { type: 'string' },
  },
});
const mode = positionals[0];
const outRoot = values.out;
if (!['synth', 'wer', 'compare', 'latency', 'align'].includes(mode ?? '') || !outRoot) {
  console.error(
    'Usage: voices-bench.ts synth|compare|latency|align|wer --out <folder> [options] (see the file header)',
  );
  process.exit(2);
}

function median(list: readonly number[]): number {
  if (list.length === 0) return NaN;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? NaN)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function percentile(list: readonly number[], p: number): number {
  if (list.length === 0) return NaN;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? NaN;
}

/**
 * Onsets of speech after a REAL pause: moments where the 5 ms loudness envelope rises above
 * 8 % of its 95th percentile after at least 120 ms below 3 % of it — longer than the closure
 * of a stop consonant, so a "p" or a "k" in the middle of a word is not taken for a start.
 * Returned in milliseconds.
 */
function energyOnsets(audio: Uint8Array): number[] {
  const pcm = decodeWav(audio);
  const hop = Math.max(1, Math.round(pcm.sampleRate * 0.005));
  const rms: number[] = [];
  for (let i = 0; i + hop <= pcm.samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < hop; j += 1) sum += ((pcm.samples[i + j] ?? 0) / 32768) ** 2;
    rms.push(Math.sqrt(sum / hop));
  }
  const loud = percentile(rms, 0.95);
  const high = loud * 0.08;
  const low = loud * 0.03;
  const onsets: number[] = [];
  let quiet = 1000; // the start of the file counts as silence
  for (let i = 0; i < rms.length; i += 1) {
    const value = rms[i] ?? 0;
    if (value < low) quiet += 1;
    else if (value >= high) {
      if (quiet * 5 >= 120) onsets.push(i * 5);
      quiet = 0;
    }
  }
  return onsets;
}

/**
 * Alignment error where it can be observed: at every onset of sound after a real pause (the
 * start of the audio and each pause inside it), the distance to the nearest word cue
 * (ms, signed: cue − onset). Words that follow another without a pause cannot be checked.
 */
function alignmentErrors(audio: Uint8Array, words: readonly { tMs: number }[]): number[] {
  return energyOnsets(audio).map((onset) => {
    let best = Infinity;
    for (const word of words) {
      if (Math.abs(word.tMs - onset) < Math.abs(best)) best = word.tMs - onset;
    }
    return best;
  });
}

function alignmentSummary(errors: readonly number[]) {
  const absolute = errors.map(Math.abs);
  return {
    onsets: errors.length,
    medianAbsMs: Math.round(median(absolute)),
    p90AbsMs: Math.round(percentile(absolute, 0.9)),
    meanSignedMs: Math.round(errors.reduce((sum, e) => sum + e, 0) / Math.max(1, errors.length)),
    within50Ms: Number(
      (absolute.filter((e) => e <= 50).length / Math.max(1, absolute.length)).toFixed(3),
    ),
  };
}

interface PhraseRecord {
  set: 'plain' | 'real';
  text: string;
  file: string;
  audioMs: number;
  computeMs: number;
  words: number;
}

async function synth(): Promise<void> {
  const providerId = values.provider ?? 'kokoro';
  const voice = values.voice ?? 'ef_dora';
  const language = values.lang ?? 'es';
  const label =
    values.label ?? `${providerId}-${voice}${values.variant ? `-${values.variant}` : ''}`;
  const base = parseEnv(providerEnvSchema);
  const env = {
    ...base,
    ...(values.dir ? { VOICE_MODEL_DIR: values.dir } : {}),
    ...(values.variant ? { VOICE_KOKORO_VARIANT: values.variant as KokoroVariant } : {}),
    ...(values.threads ? { VOICE_THREADS: Number(values.threads) } : {}),
    VOICE_IDLE_UNLOAD_SEC: 0,
  };
  const provider: TTSProvider =
    providerId === 'kokoro'
      ? createKokoroProvider(env)
      : providerId === 'piper'
        ? createPiperProvider(env)
        : createEspeakProvider(env);
  const outDir = path.join(outRoot ?? '.', label);
  fs.mkdirSync(outDir, { recursive: true });
  const base2 = language.slice(0, 2);
  const phrases: { set: 'plain' | 'real'; text: string }[] = [
    ...(PLAIN[base2] ?? []).map((text) => ({ set: 'plain' as const, text })),
    ...(REAL[base2] ?? []).map((text) => ({ set: 'real' as const, text })),
  ];
  const records: PhraseRecord[] = [];
  const errors: number[] = [];
  const pitches: number[] = [];
  const loadBefore = os.loadavg()[0] ?? 0;
  let firstMs = 0;
  for (const [index, phrase] of phrases.entries()) {
    const t0 = performance.now();
    const result = await provider.synthesize({
      text: phrase.text,
      providerVoiceId: voice,
      language,
      speed: 1,
      pitch: 0,
    });
    const computeMs = performance.now() - t0;
    if (index === 0) firstMs = computeMs;
    const file = `${String(index).padStart(2, '0')}.wav`;
    fs.writeFileSync(path.join(outDir, file), result.audio);
    fs.writeFileSync(
      path.join(outDir, `${String(index).padStart(2, '0')}.json`),
      JSON.stringify({ words: result.words, visemes: result.visemes }),
    );
    records.push({
      set: phrase.set,
      text: phrase.text,
      file,
      audioMs: result.durationMs,
      computeMs,
      words: result.words.length,
    });
    errors.push(...alignmentErrors(result.audio, result.words));
    const pcm = decodeWav(result.audio);
    const f0 = analyzeVoice(pcm.samples, pcm.sampleRate).medianF0Hz;
    if (f0 !== null) pitches.push(f0);
  }
  // The first phrase pays for loading the model: the rate is computed on the others.
  const warm = records.slice(1);
  const warmCompute = warm.reduce((sum, record) => sum + record.computeMs, 0);
  const warmAudio = warm.reduce((sum, record) => sum + record.audioMs, 0);
  const summary = {
    label,
    provider: providerId,
    voice,
    language,
    variant: providerId === 'kokoro' ? env.VOICE_KOKORO_VARIANT : null,
    threads: env.VOICE_THREADS,
    phrases: records.length,
    audioSec: Number((records.reduce((sum, r) => sum + r.audioMs, 0) / 1000).toFixed(1)),
    computePerAudioSec: Number((warmCompute / warmAudio).toFixed(3)),
    firstPhraseMs: Math.round(firstMs),
    firstPhraseAudioMs: records[0]?.audioMs ?? 0,
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    medianF0Hz: Math.round(median(pitches)),
    alignment: alignmentSummary(errors),
    loadAverage: {
      before: Number(loadBefore.toFixed(2)),
      after: Number((os.loadavg()[0] ?? 0).toFixed(2)),
    },
    records,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const { records: _records, ...printable } = summary;
  console.log(JSON.stringify(printable));
  await disposeNeuralEngines();
}

async function compare(): Promise<void> {
  const variants = (values.variants ?? 'fp32,q8').split(',') as KokoroVariant[];
  const voice = values.voice ?? 'ef_dora';
  const language = values.lang ?? 'es';
  const rounds = Number(values.rounds ?? 5);
  const base = parseEnv(providerEnvSchema);
  const phrases = (PLAIN[language.slice(0, 2)] ?? []).slice(0, 4);
  const providers = variants.map((variant) =>
    createKokoroProvider({
      ...base,
      ...(values.dir ? { VOICE_MODEL_DIR: values.dir } : {}),
      ...(values.threads ? { VOICE_THREADS: Number(values.threads) } : {}),
      VOICE_KOKORO_VARIANT: variant,
      VOICE_IDLE_UNLOAD_SEC: 0,
    }),
  );
  const speak = async (provider: TTSProvider) => {
    let compute = 0;
    let audio = 0;
    for (const text of phrases) {
      const t0 = performance.now();
      const result = await provider.synthesize({
        text,
        providerVoiceId: voice,
        language,
        speed: 1,
        pitch: 0,
      });
      compute += performance.now() - t0;
      audio += result.durationMs;
    }
    return compute / audio;
  };
  // Load every graph first, so no round pays for it.
  for (const provider of providers) await speak(provider);
  const rates: number[][] = variants.map(() => []);
  const loads: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    loads.push(os.loadavg()[0] ?? 0);
    for (const [index, provider] of providers.entries()) rates[index]?.push(await speak(provider));
  }
  const rows = variants.map((variant, index) => {
    const list = rates[index] ?? [];
    return {
      variant,
      best: Number(Math.min(...list).toFixed(3)),
      median: Number(median(list).toFixed(3)),
      rounds: list.map((rate) => Number(rate.toFixed(3))),
    };
  });
  const summary = {
    voice,
    language,
    phrases: phrases.length,
    threads: values.threads ? Number(values.threads) : 0,
    loadAverage: loads.map((load) => Number(load.toFixed(2))),
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    rows,
  };
  fs.mkdirSync(outRoot ?? '.', { recursive: true });
  fs.writeFileSync(
    path.join(outRoot ?? '.', `compare-${voice}-${variants.join('-')}.json`),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
  await disposeNeuralEngines();
}

/** Sentences of about 5 s of speech (15–16 words), and how they are joined into paragraphs. */
const LATENCY: Readonly<Record<string, readonly string[]>> = {
  es: [
    'Bienvenida a Parlante, la plataforma con la que cualquiera puede crear vídeos con avatares que hablan.',
    'Escribe el guion, elige un presentador y una voz, y en unos minutos tendrás tu vídeo listo.',
    'Puedes cambiar el fondo, añadir texto, música y subtítulos, y exportarlo en varios formatos distintos.',
    'Todo funciona en tu propio equipo, sin suscripciones, sin claves y sin enviar nada a otros servidores.',
    'Las voces neuronales suenan naturales y mueven los labios del avatar siguiendo el audio real generado.',
    'Cuando termines, descarga el resultado en alta calidad o compártelo con un enlace público muy sencillo.',
    'Si necesitas otro idioma, instala sus voces con un solo comando y aparecerán enseguida en la biblioteca.',
    'Cada escena puede tener su propio guion, su ritmo y su tono, y todo se guarda automáticamente.',
  ],
  en: [
    'Welcome to Parlante, the platform that lets anyone create videos with avatars that really speak to people.',
    'Write the script, choose a presenter and a voice, and in a few minutes your video is ready.',
    'You can change the background, add text, music and subtitles, and export it in several formats.',
    'Everything runs on your own machine, with no subscriptions, no keys and nothing sent to other servers.',
    'The neural voices sound natural and move the lips of the avatar following the real generated audio.',
    'When you are done, download the result in high quality or share it with a simple public link.',
    'If you need another language, install its voices with one command and they appear in the library.',
    'Every scene can have its own script, its own pace and tone, and everything is saved automatically.',
  ],
};

async function latency(): Promise<void> {
  const providerId = values.provider ?? 'kokoro';
  const voice = values.voice ?? 'ef_dora';
  const language = values.lang ?? 'es';
  const kind = values.kind === 'paragraph' ? 'paragraph' : 'sentence';
  const base = parseEnv(providerEnvSchema);
  const env = {
    ...base,
    ...(values.dir ? { VOICE_MODEL_DIR: values.dir } : {}),
    ...(values.variant ? { VOICE_KOKORO_VARIANT: values.variant as KokoroVariant } : {}),
    VOICE_IDLE_UNLOAD_SEC: 0,
  };
  const provider: TTSProvider =
    providerId === 'kokoro'
      ? createKokoroProvider(env)
      : providerId === 'piper'
        ? createPiperProvider(env)
        : createEspeakProvider(env);
  const sentences = LATENCY[language.slice(0, 2)] ?? LATENCY.es ?? [];
  // Four different texts: one cold request and three warm ones. A paragraph is six sentences.
  const texts = [0, 1, 2, 3].map((shift) =>
    kind === 'sentence'
      ? (sentences[shift] ?? '')
      : Array.from({ length: 6 }, (_, i) => sentences[(i + shift) % sentences.length]).join(' '),
  );
  const loadBefore = os.loadavg()[0] ?? 0;
  const runs: { computeMs: number; audioMs: number }[] = [];
  for (const text of texts) {
    const t0 = performance.now();
    const result = await provider.synthesize({
      text,
      providerVoiceId: voice,
      language,
      speed: 1,
      pitch: 0,
    });
    runs.push({ computeMs: Math.round(performance.now() - t0), audioMs: result.durationMs });
  }
  const warm = runs.slice(1);
  const summary = {
    provider: providerId,
    voice,
    kind,
    variant: providerId === 'kokoro' ? env.VOICE_KOKORO_VARIANT : null,
    coldMs: runs[0]?.computeMs ?? 0,
    coldAudioMs: runs[0]?.audioMs ?? 0,
    warmMs: warm.map((run) => run.computeMs),
    warmAudioMs: warm.map((run) => run.audioMs),
    warmMedianMs: Math.round(median(warm.map((run) => run.computeMs))),
    loadAverage: {
      before: Number(loadBefore.toFixed(2)),
      after: Number((os.loadavg()[0] ?? 0).toFixed(2)),
    },
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  };
  fs.mkdirSync(outRoot ?? '.', { recursive: true });
  fs.writeFileSync(
    path.join(outRoot ?? '.', `latency-${providerId}-${voice}-${kind}.json`),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
  await disposeNeuralEngines();
}

/** Recompute the alignment figures of every candidate from the files it left (no model). */
function align(): void {
  const root = outRoot ?? '.';
  for (const label of fs.readdirSync(root).sort()) {
    const summaryPath = path.join(root, label, 'summary.json');
    if (!fs.existsSync(summaryPath)) continue;
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
      records: PhraseRecord[];
      alignment: unknown;
    };
    const errors: number[] = [];
    for (const record of summary.records) {
      const timeline = JSON.parse(
        fs.readFileSync(path.join(root, label, record.file.replace('.wav', '.json')), 'utf8'),
      ) as { words: { tMs: number; durMs: number }[] };
      errors.push(
        ...alignmentErrors(fs.readFileSync(path.join(root, label, record.file)), timeline.words),
      );
    }
    summary.alignment = alignmentSummary(errors);
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`${label.padEnd(40)} ${JSON.stringify(summary.alignment)}`);
  }
}

function normalise(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** Word-level edit distance. */
function wordErrors(reference: readonly string[], hypothesis: readonly string[]): number {
  const previous = Array.from({ length: hypothesis.length + 1 }, (_, i) => i);
  for (let i = 1; i <= reference.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= hypothesis.length; j += 1) {
      const above = previous[j] ?? 0;
      const cost = reference[i - 1] === hypothesis[j - 1] ? 0 : 1;
      previous[j] = Math.min(above + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[hypothesis.length] ?? 0;
}

function toWav16k(file: string): Uint8Array {
  const converted = spawnSync(
    process.env.FFMPEG_PATH ?? 'ffmpeg',
    ['-v', 'error', '-nostdin', '-i', file, '-ac', '1', '-ar', '16000', '-f', 'wav', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (converted.status !== 0)
    throw new Error(`ffmpeg failed on ${file}: ${String(converted.stderr)}`);
  return new Uint8Array(converted.stdout);
}

async function wer(): Promise<void> {
  const env = parseEnv(providerEnvSchema);
  const stt = createLocalWhisperStt(env);
  const root = outRoot ?? '.';
  const rows: string[] = [];
  for (const label of fs.readdirSync(root).sort()) {
    const summaryPath = path.join(root, label, 'summary.json');
    if (!fs.existsSync(summaryPath)) continue;
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
      language: string;
      records: PhraseRecord[];
      computePerAudioSec: number;
      firstPhraseMs: number;
      peakRssMb: number;
      medianF0Hz: number;
      alignment: { medianAbsMs: number; p90AbsMs: number; onsets: number };
      loadAverage: { before: number };
    };
    let errors = 0;
    let words = 0;
    const transcripts: { set: string; text: string; heard: string }[] = [];
    // A candidate that was already transcribed is only printed again.
    const werPath = path.join(root, label, 'wer.json');
    const done = fs.existsSync(werPath)
      ? (JSON.parse(fs.readFileSync(werPath, 'utf8')) as { errors: number; words: number })
      : null;
    if (done) {
      errors = done.errors;
      words = done.words;
    }
    for (const record of done ? [] : summary.records) {
      const result = await stt.transcribe({
        audio: toWav16k(path.join(root, label, record.file)),
        language: summary.language.slice(0, 2) as never,
      });
      const heard = result.segments.map((segment) => segment.text).join(' ');
      transcripts.push({ set: record.set, text: record.text, heard });
      if (record.set !== 'plain') continue;
      const reference = normalise(record.text);
      errors += wordErrors(reference, normalise(heard));
      words += reference.length;
    }
    const rate = words > 0 ? (errors / words) * 100 : NaN;
    if (!done) {
      fs.writeFileSync(werPath, JSON.stringify({ wer: rate, errors, words, transcripts }, null, 2));
    }
    rows.push(
      [
        label.padEnd(40),
        `WER ${rate.toFixed(1).padStart(5)} % (${errors}/${words})`,
        `x${summary.computePerAudioSec.toFixed(2)}`,
        `first ${summary.firstPhraseMs} ms`,
        `rss ${summary.peakRssMb} MB`,
        `f0 ${summary.medianF0Hz} Hz`,
        `align ${summary.alignment.medianAbsMs}/${summary.alignment.p90AbsMs} ms (${summary.alignment.onsets})`,
        `load ${summary.loadAverage.before}`,
      ].join('  '),
    );
  }
  console.log(rows.join('\n'));
  await disposeWhisperEngines();
}

if (mode === 'synth') await synth();
else if (mode === 'compare') await compare();
else if (mode === 'latency') await latency();
else if (mode === 'align') align();
else await wer();
