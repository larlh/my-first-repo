import type {
  ModerationFlag,
  ModerationProvider,
  ModerationRequest,
  ModerationResult,
  ProviderRef,
} from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { BLOCKLIST, CONTEXT_CATEGORIES, MINOR_ALLOWED_PHRASES, REASONS } from './lists';
import type { BlockCategory } from './lists';
import { compileTerms, matchesAny, normalizedVariants } from './normalize';
import { describesRealPerson, statesMinorAge } from './people';

const INFO: ProviderRef = {
  id: 'local',
  name: 'Lista de bloqueo (local)',
  quality: 'basic',
  local: true,
};

/** Longest text scanned in one call; longer inputs are checked in overlapping windows. */
const WINDOW_CHARS = 20_000;
const WINDOW_OVERLAP = 200;

const MATCHERS = new Map<BlockCategory, RegExp | null>(
  (Object.keys(BLOCKLIST) as BlockCategory[]).map((category) => [
    category,
    compileTerms(BLOCKLIST[category] ?? []),
  ]),
);

const MINOR_ALLOWED = compileTerms(MINOR_ALLOWED_PHRASES);

/** Split MODERATION_EXTRA_BLOCKLIST ("term one, term2, prefix*") into terms. */
export function parseExtraBlocklist(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((term) => term.trim())
    .filter((term) => term.replace(/\*+$/, '').trim().length >= 2);
}

function reasonLanguage(language: string | undefined): 'es' | 'en' {
  // Spanish is the product default; any other explicit language gets English.
  return language === undefined || language.toLowerCase().startsWith('es') ? 'es' : 'en';
}

function withoutAllowedMinorPhrases(variants: readonly string[]): string[] {
  if (!MINOR_ALLOWED) return [...variants];
  const global = new RegExp(MINOR_ALLOWED.source, 'gu');
  return variants.map((variant) => variant.replace(global, ' ').replace(/\s+/g, ' ').trim());
}

function* windows(text: string): Generator<string> {
  if (text.length <= WINDOW_CHARS) {
    yield text;
    return;
  }
  for (let start = 0; start < text.length; start += WINDOW_CHARS - WINDOW_OVERLAP) {
    yield text.slice(start, start + WINDOW_CHARS);
  }
}

function categoriesIn(
  text: string,
  context: ModerationRequest['context'],
  extra: RegExp | null,
): Set<BlockCategory> {
  const found = new Set<BlockCategory>();
  const variants = normalizedVariants(text);
  if (variants.length === 0) return found;
  for (const category of CONTEXT_CATEGORIES[context]) {
    const haystack = category === 'minor' ? withoutAllowedMinorPhrases(variants) : variants;
    if (matchesAny(haystack, MATCHERS.get(category) ?? null)) found.add(category);
  }
  if (matchesAny(variants, extra)) found.add('custom');
  if (context === 'avatar_prompt') {
    if (statesMinorAge(variants)) found.add('minor');
    if (describesRealPerson(text, variants)) found.add('real_person');
  }
  return found;
}

/**
 * Local moderation: a blocklist per context (see ./lists.ts) over normalised text, plus the
 * `avatar_prompt` rules against real, identifiable people and minors (./people.ts). It never
 * throws for user content and never echoes the offending text. It is a BASIC filter
 * (`quality: 'basic'`): whole-word matching on a short list, no understanding of context.
 */
export function createLocalModerationProvider(
  env: Pick<ProviderEnv, 'MODERATION_EXTRA_BLOCKLIST'>,
): ModerationProvider {
  const extra = compileTerms(parseExtraBlocklist(env.MODERATION_EXTRA_BLOCKLIST));
  return {
    info: INFO,
    async check(request: ModerationRequest): Promise<ModerationResult> {
      const found = new Set<BlockCategory>();
      for (const chunk of windows(request.text)) {
        for (const category of categoriesIn(chunk, request.context, extra)) found.add(category);
      }
      const language = reasonLanguage(request.language);
      const flags: ModerationFlag[] = [...found].map((category) => ({
        category,
        reason: REASONS[category][language],
      }));
      return { allowed: flags.length === 0, flags, provider: INFO };
    },
  };
}
