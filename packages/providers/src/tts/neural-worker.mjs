// Worker thread of the local neural voices (see neural-engine.ts, its only client).
//
// Plain JavaScript on purpose: a worker file must load without a TypeScript loader, whatever
// started the process (tsx, vitest, plain node). The thread owns the ONNX Runtime sessions and
// does nothing else: the engine tells it which graphs to keep, and each job is "run this
// graph with these tensors". Text, phonemes, chunking and timing all stay on the other side.
//
//   in   { id, type: 'load', key, path?, bytes?, threads, device }
//        { id, type: 'run', key, feeds: { [name]: { type, data, dims } }, outputs: string[] }
//        { id, type: 'release', key }
//   out  { id, ok: true, result } | { id, ok: false, error: { message, phase } }
//
// Nothing is ever downloaded here: a graph comes from a local path or from bytes the engine
// read from disk. ONNX Runtime's telemetry is switched off by the engine before this thread
// starts (ORT_DISABLE_TELEMETRY in the real process environment).
import { parentPort } from 'node:worker_threads';

/** @type {Promise<typeof import('onnxruntime-node')> | null} */
let runtime = null;
/** @type {Map<string, import('onnxruntime-node').InferenceSession>} */
const sessions = new Map();

function loadRuntime() {
  runtime ??= import('onnxruntime-node').then((module) => module.default ?? module);
  return runtime;
}

async function load(message) {
  if (sessions.has(message.key)) return null;
  const ort = await loadRuntime();
  const source = message.bytes ?? message.path;
  const options = (executionProviders) => ({
    executionProviders,
    intraOpNumThreads: message.threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  let session;
  let device = 'cpu';
  if (message.device && message.device !== 'cpu') {
    // A GPU provider is optional and depends on the machine (drivers, the binaries of the
    // runtime): when it cannot be used the graph is loaded on the CPU, which always works.
    try {
      session = await ort.InferenceSession.create(source, options([message.device, 'cpu']));
      device = message.device;
    } catch {
      session = undefined;
    }
  }
  session ??= await ort.InferenceSession.create(source, options(['cpu']));
  sessions.set(message.key, session);
  return { device, inputs: [...session.inputNames], outputs: [...session.outputNames] };
}

async function run(message) {
  const session = sessions.get(message.key);
  if (!session) throw new Error(`The voice model "${message.key}" is not loaded`);
  const ort = await loadRuntime();
  const feeds = {};
  for (const [name, tensor] of Object.entries(message.feeds)) {
    feeds[name] = new ort.Tensor(tensor.type, tensor.data, tensor.dims);
  }
  const results = await session.run(feeds, message.outputs);
  const out = {};
  const transfer = [];
  for (const name of message.outputs) {
    const tensor = results[name];
    // Copy out of the runtime's memory: the buffer is transferred to the engine.
    const data = Float32Array.from(tensor.data, Number);
    out[name] = { data, dims: [...tensor.dims] };
    transfer.push(data.buffer);
  }
  return { result: out, transfer };
}

async function release(message) {
  const session = sessions.get(message.key);
  sessions.delete(message.key);
  if (session) await session.release();
  return null;
}

parentPort.on('message', async (message) => {
  const phase = message.type === 'run' ? 'run' : 'load';
  try {
    if (message.type === 'run') {
      const { result, transfer } = await run(message);
      parentPort.postMessage({ id: message.id, ok: true, result }, transfer);
      return;
    }
    const result = message.type === 'load' ? await load(message) : await release(message);
    parentPort.postMessage({ id: message.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      error: { message: err instanceof Error ? err.message : String(err), phase },
    });
  }
});
