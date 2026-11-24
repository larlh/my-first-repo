import { describe, expect, it } from 'vitest';
import { graphOutputNames, nodeOutputsByOp, withGraphOutput } from './onnx-graph';

/* A hand-made ONNX file: just enough Protocol Buffers framing to stand for a real graph. */

const text = (value: string) => [...new TextEncoder().encode(value)];
const length = (value: number): number[] =>
  value < 128 ? [value] : [(value % 128) | 0x80, ...length(Math.floor(value / 128))];
const field = (number: number, payload: number[]) => [
  (number << 3) | 2,
  ...length(payload.length),
  ...payload,
];
const varint = (number: number, value: number) => [(number << 3) | 0, value];

function node(op: string, outputs: string[], name: string): number[] {
  return field(1, [
    ...field(1, text('some-input')),
    ...outputs.flatMap((output) => field(2, text(output))),
    ...field(3, text(name)),
    ...field(4, text(op)),
  ]);
}

function model(): Uint8Array {
  const graph = [
    ...node('Mul', ['/Mul_output_0'], '/Mul'),
    ...node('Ceil', ['/Ceil_output_0'], '/Ceil'),
    ...node('Conv', ['audio'], '/dec/conv'),
    ...field(2, text('graph-name')),
    ...field(12, field(1, text('output'))),
  ];
  return Uint8Array.from([
    ...varint(1, 9), // ir_version, before the graph
    ...field(2, text('piper')), // producer_name
    ...field(7, graph),
    ...field(8, [...varint(2, 15)]), // opset_import, after the graph
  ]);
}

describe('ONNX graph outputs', () => {
  it('finds the output of every node of an operator type', () => {
    expect(nodeOutputsByOp(model(), 'Ceil')).toEqual(['/Ceil_output_0']);
    expect(nodeOutputsByOp(model(), 'Conv')).toEqual(['audio']);
    expect(nodeOutputsByOp(model(), 'Erf')).toEqual([]);
  });

  it('lists the outputs a graph already returns', () => {
    expect(graphOutputNames(model())).toEqual(['output']);
  });

  it('adds an inner tensor to the outputs without touching anything else', () => {
    const original = model();
    const patched = withGraphOutput(original, '/Ceil_output_0');
    expect(graphOutputNames(patched)).toEqual(['output', '/Ceil_output_0']);
    // Same nodes, and the fields around the graph survive byte for byte.
    expect(nodeOutputsByOp(patched, 'Ceil')).toEqual(['/Ceil_output_0']);
    expect(nodeOutputsByOp(patched, 'Mul')).toEqual(['/Mul_output_0']);
    expect([...patched.subarray(0, 9)]).toEqual([...original.subarray(0, 9)]); // before it
    expect([...patched.subarray(patched.length - 4)]).toEqual([
      ...original.subarray(original.length - 4),
    ]);
    // The input is left as it was.
    expect(graphOutputNames(original)).toEqual(['output']);
  });

  it('is a no-op when the tensor is already an output', () => {
    const original = model();
    expect(withGraphOutput(original, 'output')).toBe(original);
    const once = withGraphOutput(original, '/Ceil_output_0');
    expect(withGraphOutput(once, '/Ceil_output_0')).toBe(once);
  });

  it('keeps the framing right when the graph grows past a length-prefix boundary', () => {
    // 16 384 bytes is where the length prefix of the graph grows from two bytes to three.
    const original = model();
    const name = `/${'x'.repeat(17_000)}`;
    const patched = withGraphOutput(original, name);
    expect(graphOutputNames(patched)).toEqual(['output', name]);
    expect(nodeOutputsByOp(patched, 'Conv')).toEqual(['audio']);
  });

  it('rejects bytes that are not an ONNX model', () => {
    expect(() => nodeOutputsByOp(Uint8Array.from([...varint(1, 9)]), 'Ceil')).toThrow(/no graph/);
    expect(() => graphOutputNames(Uint8Array.from([0x3a, 0x7f, 1, 2]))).toThrow(/Truncated/);
  });
});
