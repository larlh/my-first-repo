import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { composeInsertion, elementExclusion, exclusionOf, insertDictated } from './insert';

describe('composeInsertion', () => {
  it('inserts at the caret and adds the spaces a person would type', () => {
    const result = composeInsertion('Hola mundo', 4, 4, 'querido');
    expect(result.value).toBe('Hola querido mundo');
    expect(result.caret).toBe('Hola querido'.length);
    expect(result.inserted).toBe(' querido');
  });

  it('replaces the selection', () => {
    const result = composeInsertion('Hola mundo cruel', 5, 10, 'planeta');
    expect(result.value).toBe('Hola planeta cruel');
    expect(result.caret).toBe('Hola planeta'.length);
  });

  it('appends after existing text with a single space', () => {
    expect(composeInsertion('Primera frase.', 14, 14, 'segunda frase.').value).toBe(
      'Primera frase. Segunda frase.',
    );
    expect(composeInsertion('Primera frase. ', 15, 15, 'segunda.').value).toBe(
      'Primera frase. Segunda.',
    );
  });

  it('capitalises at the start of a sentence and only there', () => {
    expect(composeInsertion('', 0, 0, 'hola a todos').value).toBe('Hola a todos');
    expect(composeInsertion('¿Listos? ', 9, 9, 'empezamos').value).toBe('¿Listos? Empezamos');
    expect(composeInsertion('Uno.\n', 5, 5, 'dos').value).toBe('Uno.\nDos');
    expect(composeInsertion('¿', 1, 1, 'cómo estás?').value).toBe('¿Cómo estás?');
    expect(composeInsertion('Hola,', 5, 5, 'equipo').value).toBe('Hola, equipo');
    // A proper noun dictated mid-sentence keeps its capital.
    expect(composeInsertion('Vivo en', 7, 7, 'Madrid').value).toBe('Vivo en Madrid');
    expect(composeInsertion('', 0, 0, 'élite').value).toBe('Élite');
  });

  it('does not put a space before punctuation nor after an opening bracket', () => {
    expect(composeInsertion('Hola', 4, 4, ', mundo').value).toBe('Hola, mundo');
    expect(composeInsertion('Texto (', 7, 7, 'nota').value).toBe('Texto (nota');
    expect(composeInsertion('Hola .', 4, 4, 'mundo').value).toBe('Hola mundo .');
    expect(composeInsertion('uno, tres', 4, 4, 'dos').value).toBe('uno, dos tres');
  });

  it('tidies the recognised text: trims, collapses spaces, keeps line breaks in long fields', () => {
    expect(composeInsertion('', 0, 0, '   hola    mundo  ').value).toBe('Hola mundo');
    expect(composeInsertion('', 0, 0, 'uno\ndos').value).toBe('Uno\ndos');
    expect(composeInsertion('', 0, 0, 'uno\ndos', { singleLine: true }).value).toBe('Uno dos');
    expect(composeInsertion('abc', 1, 1, '   ').value).toBe('abc');
  });

  it('drops the final full stop in single-line fields (titles, names, searches)', () => {
    expect(composeInsertion('', 0, 0, 'Mi vídeo nuevo.', { singleLine: true }).value).toBe(
      'Mi vídeo nuevo',
    );
    expect(composeInsertion('', 0, 0, '¿Qué tal?', { singleLine: true }).value).toBe('¿Qué tal?');
    expect(composeInsertion('', 0, 0, 'Espera...', { singleLine: true }).value).toBe('Espera...');
    expect(composeInsertion('', 0, 0, 'Mi vídeo nuevo.').value).toBe('Mi vídeo nuevo.');
  });

  it('respects maxLength, cutting on a whole word, and says the text did not fit', () => {
    const result = composeInsertion('', 0, 0, 'uno dos tres cuatro', { maxLength: 12 });
    expect(result.value).toBe('Uno dos tres');
    expect(result.truncated).toBe(true);
    const mid = composeInsertion('', 0, 0, 'uno dos tres cuatro', { maxLength: 10 });
    expect(mid.value).toBe('Uno dos');
    expect(mid.truncated).toBe(true);
    const full = composeInsertion('lleno', 5, 5, 'más', { maxLength: 5 });
    expect(full).toMatchObject({ value: 'lleno', inserted: '', truncated: true });
    // Replacing a selection frees its room.
    expect(composeInsertion('abcde', 0, 5, 'xyz', { maxLength: 5 }).value).toBe('Xyz');
    // No limit: -1 is what `element.maxLength` reports.
    expect(composeInsertion('', 0, 0, 'hola', { maxLength: -1 }).truncated).toBe(false);
  });
});

describe('exclusions', () => {
  it('offers dictation in free-text fields only', () => {
    expect(exclusionOf({})).toBeNull();
    expect(exclusionOf({ type: 'text' })).toBeNull();
    expect(exclusionOf({ type: 'search' })).toBeNull();
    for (const type of [
      'password',
      'email',
      'url',
      'number',
      'tel',
      'date',
      'datetime-local',
      'time',
      'month',
      'week',
      'color',
      'range',
      'file',
      'hidden',
    ]) {
      expect(exclusionOf({ type }), type).toBe('type');
    }
  });

  it('never in read-only, disabled or secret fields, nor in formatted ones', () => {
    expect(exclusionOf({ readOnly: true })).toBe('readonly');
    expect(exclusionOf({ disabled: true })).toBe('disabled');
    expect(exclusionOf({ secret: true })).toBe('secret');
    expect(exclusionOf({ type: 'text', secret: true })).toBe('secret');
    expect(exclusionOf({ autoComplete: 'email' })).toBe('autocomplete');
    expect(exclusionOf({ autoComplete: 'current-password' })).toBe('autocomplete');
    expect(exclusionOf({ autoComplete: 'section-a one-time-code' })).toBe('autocomplete');
    expect(exclusionOf({ autoComplete: 'cc-number' })).toBe('autocomplete');
    expect(exclusionOf({ autoComplete: 'off' })).toBeNull();
    expect(exclusionOf({ autoComplete: 'name' })).toBeNull();
    expect(exclusionOf({ inputMode: 'numeric' })).toBe('inputmode');
    expect(exclusionOf({ inputMode: 'email' })).toBe('inputmode');
    expect(exclusionOf({ pattern: '[0-9]{4}' })).toBe('pattern');
  });

  it('re-checks the live element (it may have become read-only since it rendered)', () => {
    render(
      <fieldset disabled>
        <input aria-label="en grupo" />
      </fieldset>,
    );
    expect(elementExclusion(screen.getByLabelText('en grupo') as HTMLInputElement)).toBe(
      'disabled',
    );
    const { container } = render(
      <>
        <input data-testid="a" />
        <input data-testid="b" type="password" />
        <textarea data-testid="c" readOnly />
        <input data-testid="d" data-secret="" />
      </>,
    );
    const get = (id: string) =>
      container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement | HTMLTextAreaElement;
    expect(elementExclusion(get('a'))).toBeNull();
    expect(elementExclusion(get('b'))).toBe('type');
    expect(elementExclusion(get('c'))).toBe('readonly');
    expect(elementExclusion(get('d'))).toBe('secret');
  });
});

describe('insertDictated', () => {
  function Controlled({
    onChange,
    maxLength,
  }: {
    onChange: (v: string) => void;
    maxLength?: number;
  }) {
    const [value, setValue] = useState('Hola mundo');
    return (
      <textarea
        aria-label="guion"
        value={value}
        maxLength={maxLength}
        onChange={(event) => {
          setValue(event.target.value);
          onChange(event.target.value);
        }}
      />
    );
  }

  it('goes through the same path as typing: a controlled React field gets its onChange', () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const field = screen.getByLabelText<HTMLTextAreaElement>('guion');
    field.setSelectionRange(4, 4);
    const result = insertDictated(field, 'querido');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('Hola querido mundo');
    expect(field.value).toBe('Hola querido mundo');
    expect(result.caret).toBe(12);
    expect(field.selectionStart).toBe(12);
    expect(field.selectionEnd).toBe(12);
  });

  it('fires a bubbling `input` event, like a keystroke (form libraries and autosave listen)', () => {
    const onInput = vi.fn();
    render(
      <form onInput={onInput}>
        <input aria-label="título" defaultValue="" />
      </form>,
    );
    const field = screen.getByLabelText<HTMLInputElement>('título');
    insertDictated(field, 'mi primer vídeo.');
    expect(field.value).toBe('Mi primer vídeo');
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it('replaces the selected text and leaves the caret after the new text', () => {
    render(<Controlled onChange={() => undefined} />);
    const field = screen.getByLabelText<HTMLTextAreaElement>('guion');
    field.setSelectionRange(5, 10);
    insertDictated(field, 'planeta');
    expect(field.value).toBe('Hola planeta');
    expect(field.selectionStart).toBe(12);
  });

  it('respects the maxLength of the field and reports the truncation', () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} maxLength={16} />);
    const field = screen.getByLabelText<HTMLTextAreaElement>('guion');
    field.setSelectionRange(10, 10);
    const result = insertDictated(field, 'entero y más cosas');
    expect(field.value).toBe('Hola mundo');
    expect(result.truncated).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    const fits = insertDictated(field, 'feliz y contento');
    expect(field.value).toBe('Hola mundo feliz');
    expect(fits.truncated).toBe(true);
    expect(field.value.length).toBeLessThanOrEqual(16);
  });

  it('uses the browser editing command when the field has the focus (native undo keeps working)', () => {
    render(<Controlled onChange={() => undefined} />);
    const field = screen.getByLabelText<HTMLTextAreaElement>('guion');
    field.focus();
    field.setSelectionRange(10, 10);
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    try {
      const result = insertDictated(field, 'otra vez');
      expect(exec).toHaveBeenCalledWith('insertText', false, ' otra vez');
      expect(result.inserted).toBe(' otra vez');
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });

  it('does nothing for an empty recognition', () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const field = screen.getByLabelText<HTMLTextAreaElement>('guion');
    fireEvent.focus(field);
    expect(insertDictated(field, '   ').inserted).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });
});
