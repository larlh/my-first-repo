import {
  AppError,
  LANGUAGES,
  LocaleSchema,
  baseLanguage,
  isAppError,
  isClonedVoiceId,
  makeStockVoiceId,
  parseStockVoiceId,
} from '@parlante/shared';
import type {
  Gender,
  LanguageCode,
  ProviderVoice,
  Providers,
  TTSProvider,
  Voice,
} from '@parlante/shared';
import { and, desc, eq, voices } from '@parlante/db';
import type { Db, VoiceRow } from '@parlante/db';
import { iso } from '../../lib/dto';

/* -------------------------------------------------------------------------------------------
 * The voice catalogue as ONE list of `Voice` DTOs:
 *   <provider>:<id>  stock voices of EVERY active TTS provider (`providers.tts.all()`)
 *   vcl_…            cloned voices of the workspace (table `voices`)
 * Used by `GET /api/voices` and reusable by any other listing of voices (public API v1).
 * ----------------------------------------------------------------------------------------- */

export interface VoiceCatalogDeps {
  db: Db;
  providers: Pick<Providers, 'tts' | 'voiceClone'>;
  /** Called when one provider cannot list its voices but others can (the list goes on). */
  onProviderError?: (providerId: string, error: unknown) => void;
}

export interface VoiceFilters {
  kind?: Voice['kind'] | undefined;
  /** Voices of this language PLUS every multilingual voice. */
  language?: LanguageCode | undefined;
  gender?: Gender | undefined;
  /** Provider id: `espeak`, `elevenlabs`, `openai`… (cloned voices: who cloned them). */
  provider?: string | undefined;
  q?: string | undefined;
  /**
   * `installed` (default): only voices that can synthesize now. `all`: also the local neural
   * voices whose model is not installed, marked `unavailable` (the library explains how to
   * install them).
   */
  availability?: 'installed' | 'all' | undefined;
}

/**
 * Stock voice lists change rarely and, for external providers, cost a network call: keep each
 * provider's answer for a few minutes. Failures are never cached.
 */
const VOICE_LIST_TTL_MS = 5 * 60_000;
const voiceListCache = new WeakMap<TTSProvider, { at: number; voices: Promise<ProviderVoice[]> }>();

function listProviderVoices(tts: TTSProvider): Promise<ProviderVoice[]> {
  // Asking is free and the answer follows the disk (voices installed a moment ago must be
  // listed at once): never reuse an old answer.
  if (tts.volatileVoices) return (async () => tts.listVoices())();
  const now = Date.now();
  const cached = voiceListCache.get(tts);
  if (cached && now - cached.at < VOICE_LIST_TTL_MS) return cached.voices;
  // `async` wrapper: a provider that throws synchronously becomes a rejection too.
  const pending = (async () => tts.listVoices())();
  voiceListCache.set(tts, { at: now, voices: pending });
  pending.catch(() => {
    if (voiceListCache.get(tts)?.voices === pending) voiceListCache.delete(tts);
  });
  return pending;
}

/** Provider voice → DTO, or null when its language is not one the product supports. */
function stockVoiceDto(tts: TTSProvider, voice: ProviderVoice): Voice | null {
  if (!LocaleSchema.safeParse(voice.language).success) return null;
  const languages = (voice.languages ?? []).filter((l) => LocaleSchema.safeParse(l).success);
  return {
    id: makeStockVoiceId(tts.info.id, voice.providerVoiceId),
    kind: 'stock',
    name: voice.name,
    provider: tts.info,
    language: voice.language,
    // One voice that speaks every language — never one copy per language.
    multilingual: languages.length > 0,
    ...(languages.length > 0 ? { languages } : {}),
    gender: voice.gender,
    description: voice.description,
    tags: voice.tags,
    status: 'ready',
    workspaceId: null,
    consentId: null,
    profile: null,
    error: null,
    createdAt: null,
    ...(voice.unavailable ? { unavailable: voice.unavailable } : {}),
    ...(voice.pitchRange ? { pitchRange: voice.pitchRange } : {}),
  };
}

/**
 * Mark the voice this server recommends for NEW content in each language and gender
 * (`Voice.isDefault`; read it with `pickDefaultVoice` of @parlante/shared). `voices` must be
 * the usable stock voices in order of preference (see `listStockVoices`): for every language
 * and gender the first voice that speaks it wins — a multilingual voice wins every language,
 * so nothing after it is marked for that gender.
 */
export function markDefaultVoices(voices: readonly Voice[]): void {
  const taken = new Set<string>();
  for (const voice of voices) {
    if (voice.kind !== 'stock' || voice.status !== 'ready' || voice.unavailable) continue;
    if (voice.gender !== 'female' && voice.gender !== 'male') continue;
    const languages = voice.multilingual
      ? LANGUAGES.map((language) => language.code)
      : [baseLanguage(voice.language)];
    let wins = false;
    for (const language of languages) {
      if (language === null) continue;
      const slot = `${language}:${voice.gender}`;
      if (taken.has(slot)) continue;
      taken.add(slot);
      wins = true;
    }
    if (wins) voice.isDefault = true;
  }
}

/** Row → DTO for a cloned voice of the workspace. */
export function toClonedVoiceDto(providers: Pick<Providers, 'voiceClone'>, row: VoiceRow): Voice {
  return {
    id: row.id,
    kind: 'cloned',
    name: row.name,
    // Null on the row only before the job confirms it: the provider that is doing the cloning.
    provider: row.provider ?? providers.voiceClone.info,
    language: row.language,
    multilingual: false,
    gender: row.gender,
    description: '',
    tags: [],
    status: row.status,
    workspaceId: row.workspaceId,
    consentId: row.consentId,
    profile: row.profile ?? null,
    error: row.error,
    createdAt: iso(row.createdAt),
  };
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function searchText(voice: Voice): string {
  const language = LANGUAGES.find((l) => l.code === baseLanguage(voice.language));
  return fold(
    [
      voice.name,
      voice.description,
      ...voice.tags,
      voice.language,
      language?.name ?? '',
      language?.englishName ?? '',
      voice.provider.name,
      voice.provider.id,
    ].join(' \n '),
  );
}

function matches(voice: Voice, filters: VoiceFilters): boolean {
  if (filters.kind && voice.kind !== filters.kind) return false;
  if (filters.gender && voice.gender !== filters.gender) return false;
  if (filters.provider && voice.provider.id !== filters.provider) return false;
  if (
    filters.language &&
    !voice.multilingual &&
    baseLanguage(voice.language) !== filters.language
  ) {
    return false;
  }
  if (filters.q) {
    const haystack = searchText(voice);
    const words = fold(filters.q)
      .split(/\s+/)
      .filter((word) => word !== '');
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  return true;
}

function providerFailure(tts: TTSProvider, error: unknown): AppError {
  if (isAppError(error)) return error;
  return new AppError(
    'PROVIDER_ERROR',
    `${tts.info.name} could not list its voices`,
    { provider: tts.info.id },
    { cause: error },
  );
}

/**
 * Active providers in the order their voices are preferred: the ranking of the registry
 * (`TTS_PROVIDER`; with `auto`, installed local neural voices before eSpeak), then the rest.
 */
function providersByPreference(providers: VoiceCatalogDeps['providers']): TTSProvider[] {
  const ranked = providers.tts.ranked?.() ?? [providers.tts.default];
  const position = new Map(ranked.map((tts, index) => [tts.info.id, index]));
  const rankOf = (tts: TTSProvider) => position.get(tts.info.id) ?? ranked.length;
  // Not ranked (eSpeak under an explicit TTS_PROVIDER excluded): neural ones still go first.
  const tier = (tts: TTSProvider) => (tts.info.quality === 'premium' ? 0 : 1);
  return [...providers.tts.all()].sort((a, b) => rankOf(a) - rankOf(b) || tier(a) - tier(b));
}

/**
 * Stock voices of every active provider, the preferred provider first, each one marked when
 * it is the default of its language and gender. Voices that are not installed come last and
 * only with `availability: 'all'`.
 */
async function listStockVoices(deps: VoiceCatalogDeps, filters: VoiceFilters): Promise<Voice[]> {
  const active = providersByPreference(deps.providers);
  const ranked = new Set(
    (deps.providers.tts.ranked?.() ?? [deps.providers.tts.default]).map((tts) => tts.info.id),
  );
  const results = await Promise.allSettled(active.map((tts) => listProviderVoices(tts)));

  const usable: Voice[] = [];
  const unavailable: Voice[] = [];
  /** Voices of the providers the defaults may come from, in order. */
  const candidates: Voice[] = [];
  let firstFailure: AppError | null = null;
  let asked = 0;
  let failed = 0;
  results.forEach((result, index) => {
    const tts = active[index];
    if (!tts) return;
    const wanted = !filters.provider || tts.info.id === filters.provider;
    if (wanted) asked += 1;
    if (result.status === 'rejected') {
      if (!wanted) return;
      failed += 1;
      firstFailure ??= providerFailure(tts, result.reason);
      deps.onProviderError?.(tts.info.id, result.reason);
      return;
    }
    for (const voice of result.value) {
      const dto = stockVoiceDto(tts, voice);
      if (!dto) continue;
      if (dto.unavailable) unavailable.push(dto);
      else {
        usable.push(dto);
        if (ranked.has(tts.info.id)) candidates.push(dto);
      }
    }
  });
  // One provider down must not hide the others; but when NONE of the providers asked for
  // could answer, an empty list would be a lie — report why there are no voices.
  if (firstFailure && failed === asked) throw firstFailure;
  // Defaults are decided on the WHOLE catalogue, before any filter narrows the list.
  markDefaultVoices(candidates);
  const listed = filters.availability === 'all' ? [...usable, ...unavailable] : usable;
  return listed.filter((voice) => matches(voice, filters));
}

/**
 * Stock voices of every active TTS provider followed by the cloned voices of the workspace
 * (newest first; also the ones still processing or failed, so the UI can show their state).
 */
export async function listVoiceCatalog(
  deps: VoiceCatalogDeps,
  workspaceId: string,
  filters: VoiceFilters = {},
): Promise<Voice[]> {
  const items: Voice[] = [];
  if (filters.kind !== 'cloned') items.push(...(await listStockVoices(deps, filters)));
  if (filters.kind !== 'stock') {
    const rows = await deps.db
      .select()
      .from(voices)
      // Workspace scope: another workspace's cloned voices are never listed.
      .where(eq(voices.workspaceId, workspaceId))
      .orderBy(desc(voices.createdAt), desc(voices.id));
    for (const row of rows) {
      const dto = toClonedVoiceDto(deps.providers, row);
      if (matches(dto, filters)) items.push(dto);
    }
  }
  return items;
}

/**
 * One voice by id, or 404: a cloned voice of another workspace, a stock voice of a provider
 * that is not active on this server and an unknown provider voice all look the same.
 */
export async function getVoice(
  deps: VoiceCatalogDeps,
  workspaceId: string,
  voiceId: string,
): Promise<Voice> {
  if (isClonedVoiceId(voiceId)) {
    const [row] = await deps.db
      .select()
      .from(voices)
      .where(and(eq(voices.id, voiceId), eq(voices.workspaceId, workspaceId)));
    if (!row) throw AppError.notFound('Voice');
    return toClonedVoiceDto(deps.providers, row);
  }
  const stock = parseStockVoiceId(voiceId);
  const tts = stock ? deps.providers.tts.get(stock.provider) : null;
  if (!stock || !tts) throw AppError.notFound('Voice');
  let providerVoices: ProviderVoice[];
  try {
    providerVoices = await listProviderVoices(tts);
  } catch (err) {
    throw providerFailure(tts, err);
  }
  const voice = providerVoices.find((v) => v.providerVoiceId === stock.providerVoiceId);
  const dto = voice ? stockVoiceDto(tts, voice) : null;
  if (!dto) throw AppError.notFound('Voice');
  return dto;
}
