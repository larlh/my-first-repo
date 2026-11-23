import { describe, expect, it } from 'vitest';
import { PARAGRAPH_PAUSE_MS, SENTENCE_PAUSE_MS, prepareSpeech, splitPlainText } from './text';

const markup = (input: string) => prepareSpeech(input).segments.map((s) => s.markup);

describe('prepareSpeech', () => {
  it('keeps plain text as it is and tokenises it by whitespace', () => {
    const prepared = prepareSpeech('  Hola   mundo,\t¿qué tal?  ');
    expect(prepared.display).toBe('Hola mundo, ¿qué tal?');
    expect(prepared.spoken).toBe('Hola mundo, ¿qué tal?');
    expect(prepared.tokens.map((t) => t.text)).toEqual(['Hola', 'mundo,', '¿qué', 'tal?']);
    expect(prepared.tokens[2]).toEqual({ text: '¿qué', start: 12, end: 16 });
    expect(prepared.segments).toHaveLength(1);
    expect(prepared.segments[0]?.markup.trim()).toBe('Hola mundo, ¿qué tal?');
    expect(prepared.segments[0]?.pauseAfterMs).toBe(0);
  });

  it('maps every markup character back to the display text (code points)', () => {
    const prepared = prepareSpeech('A & B 🙂 <c>');
    const segment = prepared.segments[0];
    expect(segment).toBeDefined();
    if (!segment) return;
    const chars = [...segment.markup];
    expect(segment.map.length).toBe(chars.length);
    const display = [...prepared.display];
    // "&" is escaped to five characters, all pointing at the one display character.
    const amp = segment.markup.indexOf('&amp;');
    expect([...segment.map.slice(amp, amp + 5)]).toEqual([2, 2, 2, 2, 2]);
    // "<c>" is not a known tag: it is spoken literally, escaped.
    expect(segment.markup).toContain('&lt;c&gt;');
    // The emoji is shown but not spoken.
    expect(prepared.display).toContain('🙂');
    expect(segment.markup).not.toContain('🙂');
    chars.forEach((ch, i) => {
      const at = segment.map[i] ?? -1;
      if (at >= 0 && !'&amp;lt;gt;'.includes(ch)) expect(display[at]).toBe(ch);
    });
  });

  it('lets only whitelisted SSML through, with sanitised attributes', () => {
    expect(
      markup(
        '<speak version="1.0">Hola <break time="1.5s"/> y <break time="999999ms"/> <break strength="strong"/> <break time="javascript:1"/></speak>',
      ),
    ).toEqual([
      // Whitespace is collapsed across tags (one space per word gap).
      'Hola <break time="1500ms"/>y <break time="5000ms"/><break strength="strong"/><break/>',
    ]);
    expect(
      markup(
        '<emphasis level="strong" onclick="x()">muy</emphasis> <emphasis level="evil">bien</emphasis>',
      ),
    ).toEqual(['<emphasis level="strong">muy</emphasis> <emphasis>bien</emphasis>']);
    expect(
      markup(
        '<prosody rate="slow" pitch="+20%" volume="x-loud" foo="bar">a</prosody> <prosody rate="1e9">b</prosody>',
      ),
    ).toEqual(['<prosody rate="slow" pitch="+20%" volume="x-loud">a</prosody> b']);
    expect(
      markup(
        '<say-as interpret-as="spell-out">ONU</say-as> <say-as interpret-as="date" format="dmy">1/2</say-as>',
      ),
    ).toEqual(['<say-as interpret-as="characters">ONU</say-as> 1/2']);
  });

  it('never lets the engine open files, switch voice or run markup from the script', () => {
    const prepared = prepareSpeech(
      'Uno <audio src="/etc/passwd">sonido</audio> <voice name="en">dos</voice> <lang xml:lang="fr">tres</lang> ' +
        '<mark name="m"/> <phoneme alphabet="ipa" ph="x">cuatro</phoneme> <!-- nota --> <?xml version="1.0"?> ' +
        '<script>alert(1)</script><style>p{}</style> <b>cinco</b> <a href="http://x">seis</a>',
    );
    expect(prepared.display).toBe('Uno sonido dos tres cuatro cinco seis');
    const all = prepared.segments.map((s) => s.markup).join('');
    expect(all).not.toMatch(/<|passwd|alert|href|nota|xml/);
  });

  it('decodes entities in text and re-escapes them for the engine', () => {
    const prepared = prepareSpeech('Tom &amp; Jerry &lt;3 &#233;xito &#x1F600; AT&T');
    expect(prepared.display).toBe('Tom & Jerry <3 éxito 😀 AT&T');
    expect(prepared.segments[0]?.markup).toContain('Tom &amp; Jerry &lt;3 éxito');
    expect(prepared.segments[0]?.markup).toContain('AT&amp;T');
  });

  it('speaks the alias of <sub> and shows its content', () => {
    const prepared = prepareSpeech(
      'La <sub alias="Organización de las Naciones Unidas">ONU</sub> opina.',
    );
    expect(prepared.display).toBe('La ONU opina.');
    expect(prepared.spoken).toBe('La Organización de las Naciones Unidas opina.');
    const segment = prepared.segments[0];
    expect(segment?.markup).toContain('Organización de las Naciones Unidas');
    expect(segment?.markup).not.toContain('ONU');
    // Every spoken alias character points at the token shown instead.
    const at = [...(segment?.markup ?? '')].indexOf('N', 10);
    const token = prepared.tokens[1];
    expect(token?.text).toBe('ONU');
    expect(segment?.map[at]).toBe(token?.start);
  });

  it('does not read markdown markers or emoji aloud, but keeps them on screen', () => {
    const prepared = prepareSpeech('**Hola** _mundo_ `código` # Título snake_case #5 ~no~ 🎉👍🏽 ©');
    expect(prepared.display).toBe('**Hola** _mundo_ `código` # Título snake_case #5 ~no~ 🎉👍🏽 ©');
    expect(prepared.spoken).toBe('Hola mundo código Título snake_case #5 no ©');
    expect(prepared.tokens.map((t) => t.text)).toContain('🎉👍🏽');
  });

  it('removes control and zero-width characters', () => {
    const prepared = prepareSpeech('Ho\u0000la\u200B \u0007mundo\uFEFF');
    expect(prepared.display).toBe('Hola mundo');
  });

  it('splits paragraphs into segments with a longer pause', () => {
    const prepared = prepareSpeech('Uno dos.\n\nTres.\n \nCuatro.<p>Cinco</p>seis');
    expect(prepared.display).toBe('Uno dos. Tres. Cuatro. Cinco seis');
    expect(prepared.segments.map((s) => s.markup.trim())).toEqual([
      'Uno dos.',
      'Tres.',
      'Cuatro.',
      'Cinco',
      'seis',
    ]);
    expect(prepared.segments.map((s) => s.pauseAfterMs)).toEqual([
      PARAGRAPH_PAUSE_MS,
      PARAGRAPH_PAUSE_MS,
      PARAGRAPH_PAUSE_MS,
      PARAGRAPH_PAUSE_MS,
      0,
    ]);
    // A single line break is not a paragraph.
    expect(prepareSpeech('Uno\ndos').segments).toHaveLength(1);
  });

  it('splits long texts at sentence ends and re-opens inline tags across segments', () => {
    const sentence = 'Esta es una frase de prueba con varias palabras. ';
    const prepared = prepareSpeech(`<prosody rate="slow">${sentence.repeat(12)}</prosody>`, {
      maxSegmentChars: 120,
    });
    expect(prepared.segments.length).toBeGreaterThanOrEqual(4);
    for (const segment of prepared.segments) {
      expect(segment.markup.startsWith('<prosody rate="slow">')).toBe(true);
      expect(segment.markup.trimEnd().endsWith('</prosody>')).toBe(true);
      expect([...segment.markup].length).toBe(segment.map.length);
      expect(segment.markup.replace(/<[^>]+>/g, '').trim()).toMatch(/\.$/);
    }
    expect(prepared.segments.slice(0, -1).every((s) => s.pauseAfterMs === SENTENCE_PAUSE_MS)).toBe(
      true,
    );
    expect(prepared.segments.at(-1)?.pauseAfterMs).toBe(0);
    // Nothing is lost or duplicated: the segments spell the whole display text.
    const spoken = prepared.segments.map((s) => s.markup.replace(/<[^>]+>/g, '').trim()).join(' ');
    expect(spoken).toBe(prepared.display);
    expect(prepared.tokens).toHaveLength(9 * 12);
  });

  it('breaks a run without punctuation rather than building one huge segment', () => {
    const prepared = prepareSpeech('palabra '.repeat(200), { maxSegmentChars: 100 });
    expect(prepared.segments.length).toBeGreaterThan(5);
    expect(Math.max(...prepared.segments.map((s) => s.map.length))).toBeLessThan(260);
  });

  it('returns nothing for empty or markup-only input', () => {
    for (const input of ['', '   \n ', '<speak></speak>', '<break time="1s"/>', '<!-- x -->']) {
      const prepared = prepareSpeech(input);
      expect(prepared.tokens).toEqual([]);
      expect(prepared.segments).toEqual([]);
      expect(prepared.display).toBe('');
    }
  });
});

describe('splitPlainText', () => {
  it('returns short text whole and nothing for blank text', () => {
    expect(splitPlainText('Hola  mundo.', 100)).toEqual(['Hola mundo.']);
    expect(splitPlainText('   ', 100)).toEqual([]);
  });

  it('cuts at sentence ends, never exceeds the limit and loses nothing', () => {
    const text = Array.from(
      { length: 40 },
      (_, i) => `Frase número ${i + 1} del guion, con una coma.`,
    ).join(' ');
    const pieces = splitPlainText(text, 200);
    expect(pieces.length).toBeGreaterThan(5);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(200);
      expect(piece).toMatch(/\.$/);
    }
    expect(pieces.join(' ')).toBe(text);
  });

  it('falls back to clause marks, spaces and finally a hard cut', () => {
    const clauses = splitPlainText(
      'uno dos tres, cuatro cinco seis, siete ocho nueve, diez once doce',
      30,
    );
    expect(clauses.every((p) => p.length <= 30)).toBe(true);
    expect(clauses[0]).toMatch(/,$/);
    expect(clauses.join(' ')).toBe(
      'uno dos tres, cuatro cinco seis, siete ocho nueve, diez once doce',
    );
    const words = splitPlainText('a'.repeat(15) + ' ' + 'b'.repeat(15) + ' ' + 'c'.repeat(15), 20);
    expect(words).toEqual(['a'.repeat(15), 'b'.repeat(15), 'c'.repeat(15)]);
    const hard = splitPlainText('x'.repeat(95), 40);
    expect(hard.map((p) => p.length)).toEqual([40, 40, 15]);
    expect(hard.join('')).toBe('x'.repeat(95));
  });
});
