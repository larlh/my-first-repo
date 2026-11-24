import {
  CompositionSchema,
  GeneratedScriptSchema,
  api,
  estimateCompositionDurationMs,
} from '@parlante/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  briefProblem,
  briefToBody,
  canCreateVideo,
  defaultBrief,
  draftFromGenerated,
  draftProblems,
  draftTiming,
  draftToComposition,
  insertScene,
  isBasic,
  moveScene,
  normalizeUrl,
  removeScene,
  sceneMs,
  updateScene,
} from './script';
import type { ScriptDraft } from './script';
import { clearWork, loadWork, saveWork } from './storage';

const generated = GeneratedScriptSchema.parse({
  title: 'Reservas sin llamadas',
  language: 'es',
  scenes: [
    {
      title: 'Gancho',
      headline: 'Menos llamadas',
      text: 'Reservar no debería costar una llamada.',
      estimatedSec: 4,
    },
    {
      title: 'Cómo',
      headline: '',
      text: 'Tus pacientes eligen hora desde el móvil.',
      estimatedSec: 4,
    },
    { title: 'Cierre', headline: 'Pruébalo', text: 'Empieza hoy mismo.', estimatedSec: 2 },
  ],
  provider: { id: 'heuristic', name: 'Heurística local', quality: 'basic', local: true },
  basicMode: true,
  sourceTitle: null,
});

function ids(): () => string {
  let n = 0;
  return () => `s${(n += 1)}`;
}

function draft(): ScriptDraft {
  return draftFromGenerated(generated, 60, ids());
}

const LIMITS = { maxScenesPerVideo: 10, maxVideoDurationSec: 180 };

describe('brief', () => {
  it('accepts bare domains and rejects anything that is not a web address', () => {
    expect(normalizeUrl('parlante.app/precios')).toBe('https://parlante.app/precios');
    expect(normalizeUrl('  http://ejemplo.com ')).toBe('http://ejemplo.com/');
    expect(normalizeUrl('ftp://ejemplo.com')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('una frase suelta')).toBeNull();
    expect(normalizeUrl('palabra')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });

  it('says what stops a brief from being sent', () => {
    expect(briefProblem(defaultBrief())).toBe('topicShort');
    expect(briefProblem({ ...defaultBrief(), topic: ' ab ' })).toBe('topicShort');
    expect(briefProblem({ ...defaultBrief(), topic: 'IA en clínicas' })).toBeNull();
    expect(briefProblem({ ...defaultBrief(), sourceKind: 'url', url: 'no es una url' })).toBe(
      'urlInvalid',
    );
    expect(briefProblem({ ...defaultBrief(), sourceKind: 'url', url: 'parlante.app' })).toBeNull();
  });

  it('builds a request body the contract accepts, without empty optional fields', () => {
    const topic = briefToBody({ ...defaultBrief('en'), topic: '  Dental booking app  ' });
    expect(topic).toEqual({
      source: { kind: 'topic', topic: 'Dental booking app' },
      tone: 'professional',
      durationSec: 60,
      language: 'en',
    });
    const url = briefToBody({
      ...defaultBrief(),
      sourceKind: 'url',
      url: 'parlante.app/blog',
      sceneCount: 4,
      audience: ' Dentistas ',
      tone: 'friendly',
      durationSec: 90,
    });
    expect(url.source).toEqual({ kind: 'url', url: 'https://parlante.app/blog' });
    expect(url.sceneCount).toBe(4);
    expect(url.audience).toBe('Dentistas');
    for (const body of [topic, url]) {
      expect(api.scriptWriter.generate.body.safeParse(body).success).toBe(true);
    }
  });
});

describe('editable script', () => {
  it('starts from the generated script, untouched', () => {
    const d = draft();
    expect(d.scenes.map((scene) => scene.id)).toEqual(['s1', 's2', 's3']);
    expect(d.edited).toBe(false);
    expect(d.targetSec).toBe(60);
    expect(isBasic(d.provider, d.basicMode)).toBe(true);
  });

  it('edits, moves, inserts and removes scenes, marking the draft as edited', () => {
    let d = updateScene(draft(), 's2', { text: 'Nuevo texto.' });
    expect(d.edited).toBe(true);
    expect(d.scenes[1]?.text).toBe('Nuevo texto.');

    d = moveScene(d, 's3', -1);
    expect(d.scenes.map((scene) => scene.id)).toEqual(['s1', 's3', 's2']);
    // Out-of-range moves return the same object.
    expect(moveScene(d, 's1', -1)).toBe(d);
    expect(moveScene(d, 's2', 1)).toBe(d);

    const inserted = insertScene(d, 's1', () => 'nueva');
    expect(inserted.sceneId).toBe('nueva');
    expect(inserted.draft.scenes.map((scene) => scene.id)).toEqual(['s1', 'nueva', 's3', 's2']);
    expect(insertScene(d, null, () => 'fin').draft.scenes.at(-1)?.id).toBe('fin');

    d = removeScene(inserted.draft, 'nueva');
    expect(d.scenes).toHaveLength(3);
    expect(removeScene(d, 'no-existe')).toBe(d);
  });

  it('never removes the last scene', () => {
    let d = draft();
    d = removeScene(removeScene(d, 's1'), 's2');
    expect(d.scenes).toHaveLength(1);
    expect(removeScene(d, 's3')).toBe(d);
  });
});

describe('timing and checks', () => {
  it('estimates like the API estimates the composition it becomes', () => {
    const d = updateScene(draft(), 's2', { text: '' });
    const composition = draftToComposition(d, {
      avatarId: 'stock_lucia',
      voiceId: 'espeak:es-f1',
      aspect: '16:9',
      subtitles: true,
    });
    expect(CompositionSchema.safeParse(composition).success).toBe(true);
    expect(draftTiming(d).totalMs).toBe(estimateCompositionDurationMs(composition));
    expect(draftTiming(d).startsMs[0]).toBe(0);
    expect(draftTiming(d).durationsMs[1]).toBe(sceneMs(''));
  });

  it('turns the draft into a composition with the chosen presenter, voice and shape', () => {
    const composition = draftToComposition(draft(), {
      avatarId: 'stock_mateo',
      voiceId: 'espeak:es-m1',
      aspect: '9:16',
      subtitles: false,
    });
    expect(composition.canvas.aspect).toBe('9:16');
    expect(composition.scenes).toHaveLength(3);
    expect(composition.subtitles.enabled).toBe(false);
    const first = composition.scenes[0];
    expect(first?.script).toMatchObject({
      kind: 'tts',
      text: 'Reservar no debería costar una llamada.',
      voiceId: 'espeak:es-m1',
      language: 'es',
    });
    expect(first?.layers.find((layer) => layer.type === 'avatar')).toMatchObject({
      avatarId: 'stock_mateo',
    });
    expect(
      first?.layers.some((layer) => layer.type === 'text' && layer.text === 'Menos llamadas'),
    ).toBe(true);
  });

  it('blocks a script with nothing to say, no title, too many scenes or too long', () => {
    const ok = draftProblems(draft(), LIMITS);
    expect(canCreateVideo(ok)).toBe(true);
    expect(ok.silentScenes).toEqual([]);

    const oneSilent = draftProblems(updateScene(draft(), 's2', { text: '  ' }), LIMITS);
    expect(oneSilent.silentScenes).toEqual([1]);
    expect(canCreateVideo(oneSilent)).toBe(true);

    let silent = draft();
    for (const scene of silent.scenes) silent = updateScene(silent, scene.id, { text: '' });
    expect(canCreateVideo(draftProblems(silent, LIMITS))).toBe(false);

    expect(canCreateVideo(draftProblems({ ...draft(), title: '  ' }, LIMITS))).toBe(false);
    expect(draftProblems(draft(), { ...LIMITS, maxScenesPerVideo: 2 }).tooManyScenes).toBe(true);
    expect(draftProblems(draft(), { ...LIMITS, maxVideoDurationSec: 5 }).tooLong).toBe(true);
  });
});

describe('work in progress (sessionStorage)', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('survives a reload per workspace and ignores anything unreadable', () => {
    const brief = { ...defaultBrief(), topic: 'Un tema' };
    saveWork('ws_a', brief, draft());
    expect(loadWork('ws_a')).toEqual({ brief, draft: draft() });
    expect(loadWork('ws_b')).toBeNull();

    window.sessionStorage.setItem('parlante.script-writer.ws_b', '{"v":1,"brief":{"tone":"x"}}');
    expect(loadWork('ws_b')).toBeNull();
    window.sessionStorage.setItem('parlante.script-writer.ws_b', 'no es json');
    expect(loadWork('ws_b')).toBeNull();

    clearWork('ws_a');
    expect(loadWork('ws_a')).toBeNull();
  });
});
