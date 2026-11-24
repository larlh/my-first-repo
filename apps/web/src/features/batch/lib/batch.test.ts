import { CompositionSchema, api, compositionFromScript } from '@parlante/shared';
import type { Composition } from '@parlante/shared';
import { describe, expect, it } from 'vitest';
import { makeBatch, makeItem } from '@/features/script-writer/kit/testing/fixtures';
import {
  allowedResolutions,
  autoMap,
  checkBatch,
  countItems,
  isBatchActive,
  mapRows,
  normalizeName,
  personalise,
  personalisedTexts,
  reconcileMapping,
  rowIssues,
  sampleRows,
  sourceVariables,
  unmappedRequired,
  unusedColumns,
} from './batch';
import type { SourceVariable } from './batch';
import { parseCsv, toCsv } from './csv';

/** A one-scene video that greets `{{nombre}}` of `{{empresa}}` (with a default for `ciudad`). */
function greeting(): Composition {
  const base = compositionFromScript(
    [
      {
        title: 'Saludo',
        text: 'Hola, {{nombre}}. Gracias por confiar en nosotros desde {{ ciudad }}.',
        headline: 'Bienvenida, {{empresa}}',
      },
    ],
    { avatarId: 'stock_lucia', voiceId: 'espeak:es-f1', language: 'es' },
  );
  return CompositionSchema.parse({
    ...base,
    variables: [
      { name: 'nombre', label: 'Nombre de pila', defaultValue: '' },
      { name: 'ciudad', label: '', defaultValue: 'tu ciudad' },
      { name: 'sobrante', label: 'No se usa', defaultValue: '' },
    ],
  });
}

const NOMBRE: SourceVariable = {
  name: 'nombre',
  label: 'Nombre de pila',
  defaultValue: '',
  required: true,
};
const EMPRESA: SourceVariable = { name: 'empresa', label: '', defaultValue: '', required: true };
const CIUDAD: SourceVariable = {
  name: 'ciudad',
  label: '',
  defaultValue: 'tu ciudad',
  required: false,
};
const VARIABLES = [NOMBRE, EMPRESA, CIUDAD];

describe('variables of the source video', () => {
  it('lists the placeholders a composition really uses, with their defaults', () => {
    const variables = sourceVariables(greeting());
    // `sobrante` is declared but used nowhere; `empresa` is used but not declared.
    expect(variables.map((variable) => variable.name).sort()).toEqual([
      'ciudad',
      'empresa',
      'nombre',
    ]);
    expect(variables.find((variable) => variable.name === 'empresa')).toEqual(EMPRESA);
    expect(variables.find((variable) => variable.name === 'nombre')).toEqual(NOMBRE);
    expect(variables.find((variable) => variable.name === 'ciudad')).toEqual(CIUDAD);
  });

  it('finds the texts that change from row to row', () => {
    expect(personalisedTexts(greeting())).toEqual([
      {
        kind: 'narration',
        scene: 1,
        text: 'Hola, {{nombre}}. Gracias por confiar en nosotros desde {{ ciudad }}.',
      },
      { kind: 'text', scene: 1, text: 'Bienvenida, {{empresa}}' },
    ]);
  });
});

describe('column mapping', () => {
  it('guesses by exact name, then loosely by name or label, one column per variable', () => {
    expect(normalizeName(' Nombre de Pila ')).toBe('nombredepila');
    expect(normalizeName('Compañía')).toBe('compania');
    expect(autoMap(VARIABLES, ['EMPRESA', 'nombre', 'Otra'])).toEqual({
      nombre: 'nombre',
      empresa: 'EMPRESA',
      ciudad: null,
    });
    // The label of the variable also counts ("Nombre de pila").
    expect(autoMap([NOMBRE], ['nombre de pila'])).toEqual({ nombre: 'nombre de pila' });
    // An exact match is never stolen by a loose one.
    expect(autoMap([NOMBRE, { ...EMPRESA, name: 'Nombre' }], ['Nombre', 'nombre'])).toEqual({
      nombre: 'nombre',
      Nombre: 'Nombre',
    });
  });

  it('follows the CSV as it changes and keeps what the person chose by hand', () => {
    // The video is picked before there is any data: nothing to map yet…
    expect(reconcileMapping({}, VARIABLES, [])).toEqual({
      nombre: null,
      empresa: null,
      ciudad: null,
    });
    // …and the guess appears as soon as the columns do (regression: it used to stay empty).
    expect(reconcileMapping({}, VARIABLES, ['nombre', 'empresa'])).toEqual({
      nombre: 'nombre',
      empresa: 'empresa',
      ciudad: null,
    });
    // A choice made by hand wins and its column is not guessed for another variable.
    expect(reconcileMapping({ nombre: 'empresa' }, VARIABLES, ['nombre', 'empresa'])).toEqual({
      nombre: 'empresa',
      empresa: null,
      ciudad: null,
    });
    // "No column" by hand is respected…
    expect(
      reconcileMapping({ empresa: null }, VARIABLES, ['nombre', 'empresa']).empresa,
    ).toBeNull();
    // …and a choice whose column disappeared falls back to the guess.
    expect(reconcileMapping({ nombre: 'Columna A' }, VARIABLES, ['nombre', 'empresa']).nombre).toBe(
      'nombre',
    );
  });

  it('reports required variables without a column and columns nobody uses', () => {
    const mapping = { nombre: 'Cliente', empresa: null, ciudad: null };
    expect(unmappedRequired(VARIABLES, mapping)).toEqual(['empresa']);
    expect(unusedColumns(['Cliente', 'Teléfono'], mapping)).toEqual(['Teléfono']);
  });

  it('builds rows keyed by variable name that the contract accepts', () => {
    const parsed = parseCsv('Cliente;Compañía\n Lucía ;Ferrer Asesores\nMarc;Taller Riera');
    const mapping = { nombre: 'Cliente', empresa: 'Compañía', ciudad: null };
    const rows = mapRows(parsed.rows, mapping, VARIABLES);
    expect(rows).toEqual([
      { nombre: 'Lucía', empresa: 'Ferrer Asesores' },
      { nombre: 'Marc', empresa: 'Taller Riera' },
    ]);
    const body = { name: 'Lote', sourceVideoId: 'vid_0001abcdefgh1234', rows, resolution: '720p' };
    expect(api.batches.create.body.safeParse(body).success).toBe(true);
    // The estimate is asked with the same rows, re-serialised under the variable names.
    expect(parseCsv(toCsv(['nombre', 'empresa'], rows)).rows).toEqual(rows);
  });
});

describe('row checks', () => {
  it('flags blank required values and values that are too long', () => {
    expect(rowIssues({ nombre: 'Lucía', empresa: 'Ferrer' }, VARIABLES)).toEqual([]);
    expect(rowIssues({ nombre: '', empresa: 'x'.repeat(501) }, VARIABLES)).toEqual([
      { variable: 'nombre', kind: 'blank' },
      { variable: 'empresa', kind: 'tooLong' },
    ]);
  });

  it('decides whether the batch can be launched', () => {
    const rows = [
      { Cliente: 'Lucía', Empresa: 'Ferrer' },
      { Cliente: '', Empresa: 'Riera' },
    ];
    const mapping = { nombre: 'Cliente', empresa: 'Empresa', ciudad: null };
    const bad = checkBatch({ variables: VARIABLES, mapping, rows, maxRows: 5 });
    expect(bad).toMatchObject({ ok: false, badRows: [1], unmapped: [], overLimit: false });

    const good = checkBatch({ variables: VARIABLES, mapping, rows: rows.slice(0, 1), maxRows: 5 });
    expect(good.ok).toBe(true);
    expect(
      checkBatch({ variables: VARIABLES, mapping, rows: rows.slice(0, 1), maxRows: 0 }).ok,
    ).toBe(false);
    expect(
      checkBatch({ variables: VARIABLES, mapping: { ...mapping, empresa: null }, rows, maxRows: 5 })
        .unmapped,
    ).toEqual(['empresa']);
    // A video without variables cannot be a batch: every row would be the same video.
    expect(checkBatch({ variables: [], mapping: {}, rows, maxRows: 5 }).ok).toBe(false);
  });
});

describe('preview of a personalised text', () => {
  it('replaces placeholders like the batch job: row value, then default, then nothing', () => {
    const parts = personalise(
      'Hola, {{nombre}} de {{ ciudad }}. Saludos a {{empresa}}.',
      { nombre: 'Lucía' },
      VARIABLES,
    );
    expect(parts).toEqual([
      { text: 'Hola, ' },
      { text: 'Lucía', variable: 'nombre' },
      { text: ' de ' },
      { text: 'tu ciudad', variable: 'ciudad' },
      { text: '. Saludos a ' },
      { text: '{{empresa}}', variable: 'empresa', missing: true },
      { text: '.' },
    ]);
    expect(personalise('Sin variables', {}, VARIABLES)).toEqual([{ text: 'Sin variables' }]);
  });

  it('writes an example that does not pretend to know what a variable means', () => {
    const people = [
      { name: 'Lucía', company: 'Ferrer Asesores', city: 'Madrid' },
      { name: 'Marc', company: 'Taller Riera', city: 'Girona' },
    ];
    const tema: SourceVariable = {
      name: 'tema',
      label: 'Tema del vídeo',
      defaultValue: '',
      required: true,
    };
    expect(sampleRows([NOMBRE, EMPRESA, CIUDAD, tema], people)).toEqual([
      { nombre: 'Lucía', empresa: 'Ferrer Asesores', ciudad: 'Madrid', tema: 'tema 1' },
      { nombre: 'Marc', empresa: 'Taller Riera', ciudad: 'Girona', tema: 'tema 2' },
    ]);
  });
});

describe('reading a batch', () => {
  it('counts items by status and knows when to keep polling', () => {
    const job = makeBatch(1, [
      makeItem(0, { nombre: 'Lucía' }, 'completed'),
      makeItem(1, { nombre: 'Marc' }, 'rendering'),
      makeItem(2, { nombre: 'Ainhoa' }, 'failed'),
      makeItem(3, { nombre: 'Jon' }, 'pending'),
    ]);
    expect(countItems(job.items)).toEqual({
      pending: 1,
      queued: 0,
      rendering: 1,
      completed: 1,
      failed: 1,
      canceled: 0,
    });
    expect(isBatchActive(job)).toBe(true);
    expect(isBatchActive({ status: 'partial' })).toBe(false);
    expect(allowedResolutions('720p')).toEqual(['720p']);
    expect(allowedResolutions('1080p')).toEqual(['720p', '1080p']);
  });
});
