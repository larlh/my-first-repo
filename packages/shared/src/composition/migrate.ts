import { COMPOSITION_VERSION, CANVAS_PRESETS, CompositionSchema } from './schema';
import type { AspectRatio, Composition } from './schema';

type RawDoc = Record<string, unknown>;

function isRecord(value: unknown): value is RawDoc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Migration steps, keyed by the version they upgrade FROM.
 * To introduce version N+1: bump COMPOSITION_VERSION, add `N: (doc) => docAtN+1` here and a test.
 * Steps must be pure and must not drop user data.
 */
const MIGRATIONS: Record<number, (doc: RawDoc) => RawDoc> = {
  /**
   * v0 → v1. v0 documents are the unversioned drafts produced before the schema was frozen:
   *  - `canvas.format` instead of `canvas.aspect`, width/height optional
   *  - `scene.script` could be a plain string (meaning: no voice chosen yet) or `{text, voiceId}`
   *  - `scene.durationSeconds` (number) instead of `scene.duration`
   */
  0: (doc) => {
    const canvasRaw = isRecord(doc.canvas) ? doc.canvas : {};
    const aspect = (canvasRaw.aspect ?? canvasRaw.format ?? '16:9') as AspectRatio;
    const preset = CANVAS_PRESETS[aspect] ?? CANVAS_PRESETS['16:9'];
    const canvas = {
      aspect,
      width: typeof canvasRaw.width === 'number' ? canvasRaw.width : preset.width,
      height: typeof canvasRaw.height === 'number' ? canvasRaw.height : preset.height,
      fps: 30,
    };
    const scenes = Array.isArray(doc.scenes) ? doc.scenes : [];
    const migratedScenes = scenes.map((sceneRaw) => {
      if (!isRecord(sceneRaw)) return sceneRaw;
      const scene: RawDoc = { ...sceneRaw };
      const script = scene.script;
      if (typeof script === 'string') {
        // No voice information in v0 plain-string scripts: keep the text as a scene note.
        scene.script = { kind: 'none' };
        if (script.trim() !== '' && typeof scene.name !== 'string') {
          scene.name = script.trim().slice(0, 80);
        }
      } else if (isRecord(script) && script.kind === undefined) {
        scene.script =
          typeof script.voiceId === 'string'
            ? {
                kind: 'tts',
                text: typeof script.text === 'string' ? script.text : '',
                voiceId: script.voiceId,
                speed: script.speed ?? 1,
                pitch: script.pitch ?? 0,
                language: script.language ?? 'es',
              }
            : { kind: 'none' };
      }
      if (typeof scene.durationSeconds === 'number' && scene.duration === undefined) {
        scene.duration = { mode: 'fixed', seconds: scene.durationSeconds };
      }
      delete scene.durationSeconds;
      return scene;
    });
    return { ...doc, version: 1, canvas, scenes: migratedScenes };
  },
};

export class CompositionMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositionMigrationError';
  }
}

/** Version of a raw document (unversioned documents are v0). */
export function getCompositionVersion(raw: unknown): number {
  if (!isRecord(raw)) throw new CompositionMigrationError('Composition must be an object');
  const v = raw.version;
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new CompositionMigrationError(`Invalid composition version: ${String(v)}`);
  }
  return v;
}

/**
 * Upgrade a raw document of any known version to the current one and validate it.
 * Call this whenever a Composition is read from storage (DB, template files, imports).
 * Throws CompositionMigrationError for unknown/newer versions and ZodError for invalid data.
 */
export function migrateComposition(raw: unknown): Composition {
  let version = getCompositionVersion(raw);
  if (version > COMPOSITION_VERSION) {
    throw new CompositionMigrationError(
      `Composition version ${version} is newer than supported version ${COMPOSITION_VERSION}`,
    );
  }
  let doc = raw as RawDoc;
  while (version < COMPOSITION_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new CompositionMigrationError(`No migration from version ${version}`);
    doc = step(doc);
    version += 1;
  }
  return CompositionSchema.parse(doc);
}

/** Validate a current-version document, applying defaults. Throws ZodError. */
export function parseComposition(raw: unknown): Composition {
  return CompositionSchema.parse(raw);
}
