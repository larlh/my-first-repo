import { describe, expect, it } from 'vitest';
import { CSV_MAX_CHARS, CsvError, detectDelimiter, parseCsv, toCsv } from './csv';

function codeOf(text: string): string {
  try {
    parseCsv(text);
    return 'ok';
  } catch (err) {
    return err instanceof CsvError ? err.code : 'other';
  }
}

describe('parseCsv', () => {
  it('reads commas, semicolons and tabs, trimming cells', () => {
    expect(parseCsv('nombre,empresa\n Lucía , Ferrer Asesores \nMarc,Taller Riera\n')).toEqual({
      columns: ['nombre', 'empresa'],
      rows: [
        { nombre: 'Lucía', empresa: 'Ferrer Asesores' },
        { nombre: 'Marc', empresa: 'Taller Riera' },
      ],
      delimiter: ',',
    });
    expect(parseCsv('nombre;empresa\r\nLucía;Ferrer, S.L.\r\n').rows).toEqual([
      { nombre: 'Lucía', empresa: 'Ferrer, S.L.' },
    ]);
    expect(parseCsv('nombre\tempresa\nLucía\tFerrer').delimiter).toBe('\t');
  });

  it('handles a BOM, quoted cells, escaped quotes, blank lines and short rows', () => {
    const parsed = parseCsv(
      '﻿nombre,frase,ciudad\n"Ferrer, Lucía","Dijo ""hola""",Madrid\n\n,,\nMarc,Solo dos\n',
    );
    expect(parsed.columns).toEqual(['nombre', 'frase', 'ciudad']);
    expect(parsed.rows).toEqual([
      { nombre: 'Ferrer, Lucía', frase: 'Dijo "hola"', ciudad: 'Madrid' },
      // A short row is padded: the row check, not the parser, decides if that is a problem.
      { nombre: 'Marc', frase: 'Solo dos', ciudad: '' },
    ]);
  });

  it('does not count separators inside quotes when detecting the delimiter', () => {
    expect(detectDelimiter('"a;b;c",d\n1,2')).toBe(',');
    expect(detectDelimiter('una sola columna\nvalor')).toBe(',');
  });

  it('explains what is wrong with a code the UI translates', () => {
    expect(codeOf('   ')).toBe('empty');
    expect(codeOf('x'.repeat(CSV_MAX_CHARS + 1))).toBe('tooLarge');
    expect(codeOf('nombre,empresa\n"Lucía,Ferrer')).toBe('malformed');
    expect(codeOf('nombre,,ciudad\na,b,c')).toBe('blankHeader');
    expect(codeOf('nombre,nombre\na,b')).toBe('duplicateHeader');
    expect(codeOf('nombre,empresa\n')).toBe('noRows');
    expect(codeOf('nombre\na,b,c')).toBe('rowTooWide');
    expect(codeOf(`n\n${Array.from({ length: 501 }, (_, i) => `fila ${i}`).join('\n')}`)).toBe(
      'tooManyRows',
    );
    expect(codeOf(`${Array.from({ length: 61 }, (_, i) => `c${i}`).join(',')}\n1`)).toBe(
      'tooManyColumns',
    );
    try {
      parseCsv('a,b\n1,2\n1,2,3');
    } catch (err) {
      expect((err as CsvError).detail).toEqual({ row: 3, values: 3, columns: 2 });
    }
  });
});

describe('toCsv', () => {
  it('writes what parseCsv reads back, whatever the cells contain', () => {
    const columns = ['nombre', 'frase'];
    const rows = [
      { nombre: 'Ferrer, Lucía', frase: 'Dijo "hola"' },
      { nombre: 'Marc', frase: 'dos\nlíneas' },
      { nombre: 'Ainhoa', frase: '' },
    ];
    const text = toCsv(columns, rows);
    expect(text.split('\n')[0]).toBe('nombre,frase');
    expect(parseCsv(text)).toEqual({ columns, rows, delimiter: ',' });
  });
});
