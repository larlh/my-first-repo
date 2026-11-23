import { describe, expect, it } from 'vitest';
import { formatSrt, formatVtt } from '@parlante/shared';
import { createManualSttProvider, detectTranscriptFormat, parseUserTranscript } from './manual';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hola a todos,
bienvenidos al <i>curso</i>.

2
00:00:04,000 --> 00:00:06,250
{\\an8}Hoy hablamos de vídeo &amp; audio.

3
00:01:05,000 --> 00:01:08,000
- ¿Empezamos?
`;

const VTT = `WEBVTT - Demo
Kind: captions
Language: es

NOTE
Este comentario no es un subtítulo
ni esto tampoco.

STYLE
::cue { color: yellow }

intro
00:01.000 --> 00:03.500 line:0 position:20% align:start
<v Ana>Hola a <b>todos</b>,</v>
bienvenidos.

00:00:04.000 --> 00:00:06.250
<c.yellow>Segundo</c> <00:00:05.000>subtítulo&nbsp;aquí.
`;

describe('parseUserTranscript', () => {
  it('parses SRT: times kept, lines joined, tags and entities removed', () => {
    const { format, segments } = parseUserTranscript({
      content: SRT,
      format: 'srt',
      totalDurationMs: 0,
    });
    expect(format).toBe('srt');
    expect(segments).toEqual([
      { startMs: 1000, endMs: 3500, text: 'Hola a todos, bienvenidos al curso.' },
      { startMs: 4000, endMs: 6250, text: 'Hoy hablamos de vídeo & audio.' },
      { startMs: 65_000, endMs: 68_000, text: '- ¿Empezamos?' },
    ]);
  });

  it('parses WebVTT: header, NOTE and STYLE blocks, cue ids, settings and voice tags ignored', () => {
    const { format, segments } = parseUserTranscript({
      content: VTT,
      format: 'vtt',
      totalDurationMs: 60_000,
    });
    expect(format).toBe('vtt');
    expect(segments).toEqual([
      { startMs: 1000, endMs: 3500, text: 'Hola a todos, bienvenidos.' },
      { startMs: 4000, endMs: 6250, text: 'Segundo subtítulo aquí.' },
    ]);
  });

  it('detects the format, also when the declared one is wrong', () => {
    expect(detectTranscriptFormat(VTT)).toBe('vtt');
    expect(detectTranscriptFormat('\uFEFF' + SRT)).toBe('srt');
    expect(detectTranscriptFormat('Solo un texto --> con flecha pero sin tiempos')).toBe('text');
    expect(detectTranscriptFormat('Un texto normal.\nOtra línea.')).toBe('text');
    expect(parseUserTranscript({ content: SRT, totalDurationMs: 0 }).format).toBe('srt');
    expect(
      parseUserTranscript({ content: SRT, format: 'auto', totalDurationMs: 0 }).segments,
    ).toHaveLength(3);
    // Pasted an SRT into the "text" box: it is still read as SRT, not spoken as numbers.
    const asText = parseUserTranscript({ content: SRT, format: 'text', totalDurationMs: 90_000 });
    expect(asText.format).toBe('srt');
    expect(asText.segments[0]?.startMs).toBe(1000);
    // Declared SRT but it is plain text: timed as text.
    const asSrt = parseUserTranscript({
      content: 'Una frase. Otra frase.',
      format: 'srt',
      totalDurationMs: 4000,
    });
    expect(asSrt.format).toBe('text');
    expect(asSrt.segments).toHaveLength(2);
  });

  it('round-trips what the product itself exports', () => {
    const cues = [
      { startMs: 0, endMs: 1500, text: 'Primera línea.' },
      { startMs: 1500, endMs: 4200, text: 'Segunda línea, más larga.' },
      { startMs: 3_600_000, endMs: 3_601_250, text: 'Una hora después.' },
    ];
    expect(parseUserTranscript({ content: formatSrt(cues), totalDurationMs: 0 }).segments).toEqual(
      cues,
    );
    expect(parseUserTranscript({ content: formatVtt(cues), totalDurationMs: 0 }).segments).toEqual(
      cues,
    );
  });

  it('accepts timestamps without milliseconds and CRLF line ends', () => {
    const content =
      '1\r\n00:00:02 --> 00:00:04\r\nSin milisegundos\r\n\r\n2\r\n0:05 --> 0:07.5\r\nCorto\r\n';
    expect(parseUserTranscript({ content, totalDurationMs: 0 }).segments).toEqual([
      { startMs: 2000, endMs: 4000, text: 'Sin milisegundos' },
      { startMs: 5000, endMs: 7500, text: 'Corto' },
    ]);
  });

  it('tidies timed cues: sorted, trimmed to the audio, no overlaps, no rolling duplicates', () => {
    const content = `
00:00:10,000 --> 00:00:14,000
Tercero se solapa con el cuarto

00:00:01,000 --> 00:00:03,000
Primero

00:00:03,000 --> 00:00:05,000
Primero

00:00:12,000 --> 00:00:16,000
Cuarto

00:00:12,000 --> 00:00:15,000
Otra voz a la vez

00:00:19,000 --> 00:00:25,000
Se sale del audio

00:00:30,000 --> 00:00:32,000
Fuera del audio
`;
    const { segments } = parseUserTranscript({ content, totalDurationMs: 20_000 });
    expect(segments).toEqual([
      { startMs: 1000, endMs: 5000, text: 'Primero' },
      { startMs: 10_000, endMs: 12_000, text: 'Tercero se solapa con el cuarto' },
      { startMs: 12_000, endMs: 16_000, text: 'Otra voz a la vez Cuarto' },
      { startMs: 19_000, endMs: 20_000, text: 'Se sale del audio' },
    ]);
    segments.forEach((segment, i) => {
      expect(segment.endMs).toBeGreaterThan(segment.startMs);
      if (i > 0) expect(segment.startMs).toBeGreaterThanOrEqual(segments[i - 1]?.endMs ?? 0);
    });
  });

  it('spreads plain text over the audio in proportion to sentence length', () => {
    const { format, segments } = parseUserTranscript({
      content: 'Hola. Esta frase es bastante más larga que la primera.\n\n¿Y la tercera?',
      format: 'text',
      totalDurationMs: 10_000,
    });
    expect(format).toBe('text');
    expect(segments.map((s) => s.text)).toEqual([
      'Hola.',
      'Esta frase es bastante más larga que la primera.',
      '¿Y la tercera?',
    ]);
    expect(segments[0]?.startMs).toBe(0);
    expect(segments.at(-1)?.endMs).toBe(10_000);
    const [a, b] = segments;
    expect((b?.endMs ?? 0) - (b?.startMs ?? 0)).toBeGreaterThan(
      ((a?.endMs ?? 0) - (a?.startMs ?? 0)) * 5,
    );
    segments.forEach((segment, i) => {
      if (i > 0) expect(segment.startMs).toBe(segments[i - 1]?.endMs);
    });
  });

  it('splits sentences too long to subtitle, sharing their time', () => {
    const long =
      'Esta es una frase larguísima, llena de comas, que sigue y sigue sin terminar nunca, ' +
      'porque quien la escribió no conocía el punto, ni el punto y coma, ni la piedad con ' +
      'quien después tiene que doblarla y subtitularla en otro idioma, que no es poco.';
    const { segments } = parseUserTranscript({
      content: `${long} Fin.`,
      format: 'text',
      totalDurationMs: 30_000,
    });
    expect(segments.length).toBeGreaterThanOrEqual(3);
    for (const segment of segments) expect(segment.text.length).toBeLessThanOrEqual(160);
    expect(segments.map((s) => s.text).join(' ')).toBe(`${long} Fin.`);
    expect(segments[0]?.startMs).toBe(0);
    expect(segments.at(-1)?.endMs).toBe(30_000);
    segments.forEach((segment, i) => {
      expect(segment.endMs).toBeGreaterThan(segment.startMs);
      if (i > 0) expect(segment.startMs).toBe(segments[i - 1]?.endMs);
    });
  });

  it('honours line stamps in plain text', () => {
    const content = `[00:00] Bienvenidos al programa.
[00:07] Hoy tenemos una invitada
que viene de lejos.
(1:02) Empezamos.
01:10:05 - Una hora después.`;
    const { format, segments } = parseUserTranscript({ content, totalDurationMs: 4_300_000 });
    expect(format).toBe('text');
    expect(segments).toEqual([
      { startMs: 0, endMs: 7000, text: 'Bienvenidos al programa.' },
      { startMs: 7000, endMs: 62_000, text: 'Hoy tenemos una invitada que viene de lejos.' },
      { startMs: 62_000, endMs: 4_205_000, text: 'Empezamos.' },
      { startMs: 4_205_000, endMs: 4_300_000, text: 'Una hora después.' },
    ]);
    // Without the length of the audio the last line gets a reading-pace estimate.
    const open = parseUserTranscript({ content: '0:00 Uno\n0:05 Dos y tres', totalDurationMs: 0 });
    expect(open.segments).toEqual([
      { startMs: 0, endMs: 5000, text: 'Uno' },
      { startMs: 5000, endMs: 6000, text: 'Dos y tres' },
    ]);
    // A text that merely mentions a time is not a stamped transcript.
    const prose = parseUserTranscript({
      content: 'Quedamos mañana.\n10:30 es buena hora.\nLlevaré café.',
      totalDurationMs: 9000,
    });
    expect(prose.segments.map((s) => s.text)).toEqual([
      'Quedamos mañana.',
      '10:30 es buena hora.',
      'Llevaré café.',
    ]);
  });

  it('rejects transcripts with nothing usable', () => {
    for (const content of [
      '',
      '   \n\n',
      'WEBVTT\n\nNOTE nada',
      '1\n00:00:01,000 --> 00:00:02,000\n<i></i>\n',
    ]) {
      expect(() => parseUserTranscript({ content, totalDurationMs: 5000 })).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }),
      );
    }
    // Untimed text cannot be placed without the length of the audio.
    expect(() =>
      parseUserTranscript({ content: 'Hola a todos.', totalDurationMs: 0 }),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});

describe('manual STT provider', () => {
  it('declares that the user must supply the transcript', async () => {
    const stt = createManualSttProvider();
    expect(stt.requiresUserTranscript).toBe(true);
    expect(stt.info).toMatchObject({ id: 'manual', quality: 'basic', local: true });
    await expect(stt.transcribe({ audio: new Uint8Array(), language: 'es' })).rejects.toMatchObject(
      {
        code: 'TRANSCRIPT_REQUIRED',
        status: 422,
      },
    );
  });
});
