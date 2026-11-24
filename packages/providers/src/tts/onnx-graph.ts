/* -------------------------------------------------------------------------------------------
 * The smallest possible editor of an ONNX file: it adds a tensor that already exists INSIDE
 * the graph to the list of graph outputs, so ONNX Runtime returns it.
 *
 * Why: a Piper voice (VITS) computes how many audio frames each phoneme lasts and then only
 * returns the audio. Those durations are exactly what lip-sync and word timing need. Exposing
 * them is a change of metadata, not of weights: the file on disk stays the one whose SHA-256
 * was verified, and the edit happens on a copy in memory when the voice is loaded.
 *
 * ONNX is Protocol Buffers. Only three message types matter, and only their framing:
 *   ModelProto.graph      = field 7  (GraphProto, length-delimited)
 *   GraphProto.node       = field 1  (NodeProto: output = 2, op_type = 4)
 *   GraphProto.output     = field 12 (ValueInfoProto: name = 1)
 * Everything else is copied byte for byte.
 * ----------------------------------------------------------------------------------------- */

interface Field {
  field: number;
  wire: number;
  /** Start of the tag. */
  start: number;
  /** Payload of a length-delimited field: [dataStart, end). */
  dataStart: number;
  end: number;
}

function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let scale = 1;
  let pos = at;
  for (;;) {
    const byte = bytes[pos];
    if (byte === undefined) throw new Error('Truncated ONNX file');
    pos += 1;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) break;
    scale *= 128;
    if (scale > 2 ** 56) throw new Error('Malformed varint in ONNX file');
  }
  return { value, next: pos };
}

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    const low = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? low | 0x80 : low);
  } while (rest > 0);
  return out;
}

function* fieldsOf(bytes: Uint8Array, from: number, to: number): Generator<Field> {
  let pos = from;
  while (pos < to) {
    const start = pos;
    const tag = readVarint(bytes, pos);
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    pos = tag.next;
    let dataStart = pos;
    if (wire === 0) pos = readVarint(bytes, pos).next;
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      const length = readVarint(bytes, pos);
      dataStart = length.next;
      pos = length.next + length.value;
    } else throw new Error(`Unsupported protobuf wire type ${wire} in ONNX file`);
    if (pos > to) throw new Error('Truncated ONNX file');
    yield { field, wire, start, dataStart, end: pos };
  }
}

const GRAPH_FIELD = 7;
const NODE_FIELD = 1;
const NODE_OUTPUT_FIELD = 2;
const NODE_OP_TYPE_FIELD = 4;
const GRAPH_OUTPUT_FIELD = 12;
const VALUE_NAME_FIELD = 1;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function findGraph(model: Uint8Array): Field {
  for (const field of fieldsOf(model, 0, model.length)) {
    if (field.field === GRAPH_FIELD && field.wire === 2) return field;
  }
  throw new Error('Not an ONNX model: it has no graph');
}

/** First output name of every node of the given operator type, in graph order. */
export function nodeOutputsByOp(model: Uint8Array, opType: string): string[] {
  const graph = findGraph(model);
  const found: string[] = [];
  for (const node of fieldsOf(model, graph.dataStart, graph.end)) {
    if (node.field !== NODE_FIELD || node.wire !== 2) continue;
    let op = '';
    let output: string | null = null;
    for (const part of fieldsOf(model, node.dataStart, node.end)) {
      if (part.wire !== 2) continue;
      if (part.field === NODE_OP_TYPE_FIELD) {
        op = decoder.decode(model.subarray(part.dataStart, part.end));
      } else if (part.field === NODE_OUTPUT_FIELD && output === null) {
        output = decoder.decode(model.subarray(part.dataStart, part.end));
      }
    }
    if (op === opType && output !== null) found.push(output);
  }
  return found;
}

/** Names the graph already returns. */
export function graphOutputNames(model: Uint8Array): string[] {
  const graph = findGraph(model);
  const names: string[] = [];
  for (const output of fieldsOf(model, graph.dataStart, graph.end)) {
    if (output.field !== GRAPH_OUTPUT_FIELD || output.wire !== 2) continue;
    for (const part of fieldsOf(model, output.dataStart, output.end)) {
      if (part.field === VALUE_NAME_FIELD && part.wire === 2) {
        names.push(decoder.decode(model.subarray(part.dataStart, part.end)));
      }
    }
  }
  return names;
}

/**
 * A copy of `model` whose graph also returns the tensor `tensorName` (which must be produced
 * by a node of the graph). The type and shape are left for the runtime to infer.
 */
export function withGraphOutput(model: Uint8Array, tensorName: string): Uint8Array {
  if (graphOutputNames(model).includes(tensorName)) return model;
  const graph = findGraph(model);
  const name = encoder.encode(tensorName);
  // ValueInfoProto { name }, wrapped as one more `output` entry of the graph.
  const valueInfo = [(VALUE_NAME_FIELD << 3) | 2, ...encodeVarint(name.length), ...name];
  const entry = Uint8Array.from([
    (GRAPH_OUTPUT_FIELD << 3) | 2,
    ...encodeVarint(valueInfo.length),
    ...valueInfo,
  ]);
  const graphLength = graph.end - graph.dataStart + entry.length;
  const header = Uint8Array.from([(GRAPH_FIELD << 3) | 2, ...encodeVarint(graphLength)]);
  const out = new Uint8Array(
    graph.start + header.length + graphLength + (model.length - graph.end),
  );
  let at = 0;
  out.set(model.subarray(0, graph.start), at);
  at += graph.start;
  out.set(header, at);
  at += header.length;
  out.set(model.subarray(graph.dataStart, graph.end), at);
  at += graph.end - graph.dataStart;
  out.set(entry, at);
  at += entry.length;
  out.set(model.subarray(graph.end), at);
  return out;
}
