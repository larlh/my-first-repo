// Worker thread of the local Whisper engine (see whisper-engine.ts, its only client).
//
// Plain JavaScript on purpose: a worker file must load without a TypeScript loader, whatever
// started the process (tsx, vitest, plain node). Everything heavy happens here — reading the
// model, the log-mel features and the ONNX sessions — so the thread that serves HTTP never
// blocks. One message in, one message out; jobs arrive one at a time.
//
//   in   { id, type: 'load' }
//        { id, type: 'transcribe', samples: Float32Array (16 kHz mono), language?, timestamps }
//   out  { id, ok: true, result } | { id, ok: false, error: { message, phase } }
//
// Nothing is ever downloaded: remote models are disabled and only `modelsDir` is read.
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const SAMPLE_RATE = 16_000;
const WINDOW_SAMPLES = 30 * SAMPLE_RATE;

/** @type {Promise<{ tf: any, asr: any, languageTokens: [string, number][] }> | null} */
let loading = null;

function load() {
  loading ??= (async () => {
    const tf = await import('@huggingface/transformers');
    tf.env.allowRemoteModels = false;
    tf.env.allowLocalModels = true;
    tf.env.localModelPath = workerData.modelsDir;
    tf.env.useFSCache = false;
    tf.env.useBrowserCache = false;
    // The absolute folder is not a valid Hub id (it holds `--`), so the library reads it as
    // a plain path and can never mistake it for a repository to fetch.
    const modelPath = path.join(workerData.modelsDir, workerData.modelFolder);
    const asr = await tf.pipeline('automatic-speech-recognition', modelPath, {
      dtype: workerData.dtype,
      device: 'cpu',
      local_files_only: true,
      session_options: {
        intraOpNumThreads: workerData.threads,
        interOpNumThreads: 1,
      },
    });
    const langToId = asr.model.generation_config.lang_to_id ?? {};
    const languageTokens = [];
    for (const code of workerData.languages) {
      const id = langToId[`<|${code}|>`];
      if (typeof id === 'number') languageTokens.push([code, id]);
    }
    return { tf, asr, languageTokens };
  })();
  return loading;
}

/**
 * Language of the speech: one decoder step after <|startoftranscript|> and the most likely
 * language token AMONG the product languages (the library itself would assume English).
 */
async function detectLanguage(state, samples) {
  const { tf, asr, languageTokens } = state;
  if (languageTokens.length === 0) return null;
  const { input_features } = await asr.processor(samples.subarray(0, WINDOW_SAMPLES));
  const start = asr.model.generation_config.decoder_start_token_id;
  const output = await asr.model.forward({
    input_features,
    decoder_input_ids: new tf.Tensor('int64', BigInt64Array.from([BigInt(start)]), [1, 1]),
  });
  const logits = output.logits.data;
  let best = languageTokens[0][0];
  let bestScore = -Infinity;
  for (const [code, id] of languageTokens) {
    if (logits[id] > bestScore) {
      bestScore = logits[id];
      best = code;
    }
  }
  return best;
}

async function transcribe(state, message) {
  const { asr } = state;
  /** @type {Float32Array} */
  const samples = message.samples;
  const language = message.language ?? (await detectLanguage(state, samples));
  const seconds = samples.length / SAMPLE_RATE;
  const output = await asr(samples, {
    language: language ?? 'en',
    task: 'transcribe',
    return_timestamps: Boolean(message.timestamps),
    // A decoder that starts looping must not run to the 448-token limit of the model: fast
    // speech stays under ~8 tokens per second, timestamps add two per phrase.
    max_new_tokens: Math.min(440, 32 + Math.ceil(seconds * 12)),
  });
  return {
    text: String(output.text ?? ''),
    language,
    chunks: Array.isArray(output.chunks)
      ? output.chunks.map((chunk) => ({
          startSec: chunk.timestamp?.[0] ?? 0,
          endSec: chunk.timestamp?.[1] ?? null,
          text: String(chunk.text ?? ''),
        }))
      : [],
  };
}

parentPort.on('message', async (message) => {
  let phase = 'load';
  try {
    const state = await load();
    if (message.type === 'load') {
      parentPort.postMessage({ id: message.id, ok: true, result: null });
      return;
    }
    phase = 'run';
    const result = await transcribe(state, message);
    parentPort.postMessage({ id: message.id, ok: true, result });
  } catch (err) {
    if (phase === 'load') loading = null;
    parentPort.postMessage({
      id: message.id,
      ok: false,
      error: { message: err instanceof Error ? err.message : String(err), phase },
    });
  }
});
