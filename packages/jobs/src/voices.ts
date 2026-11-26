import { and, eq, voices } from '@parlante/db';
import { AppError, isClonedVoiceId, parseStockVoiceId } from '@parlante/shared';
import type { Providers, TTSProvider, VoiceProfile } from '@parlante/shared';
import type { DbOrTx } from '@parlante/db';

export interface ResolvedVoice {
  voiceId: string;
  kind: 'stock' | 'cloned';
  /** Provider that speaks with this voice. */
  tts: TTSProvider;
  providerVoiceId: string;
  /** Local cloned voices: parameters applied on top of the request speed / pitch. */
  profile: VoiceProfile | null;
  /** Language of a cloned voice (stock voices: ask the provider's `listVoices`). */
  language: string | null;
}

/**
 * THE way to turn a `voiceId` of a composition / request into something a TTS provider can
 * speak with. Shared by `POST /api/tts/synthesize`, the render job, translation dubbing and
 * the interactive avatar, so all of them accept and reject the same ids:
 *  - stock `<provider>:<id>`  → the provider must be active (PROVIDER_NOT_CONFIGURED if not)
 *  - cloned `vcl_…`           → must belong to `workspaceId` (NOT_FOUND otherwise — never
 *                               leak another workspace's voice) and be `ready` (INVALID_STATE)
 */
export async function resolveVoice(
  db: DbOrTx,
  providers: Pick<Providers, 'tts'>,
  workspaceId: string,
  voiceId: string,
): Promise<ResolvedVoice> {
  if (isClonedVoiceId(voiceId)) {
    const [row] = await db
      .select()
      .from(voices)
      .where(and(eq(voices.id, voiceId), eq(voices.workspaceId, workspaceId)));
    if (!row) throw new AppError('NOT_FOUND', 'Voice not found', { voiceId });
    if (row.status !== 'ready' || !row.ttsProviderId || !row.providerVoiceId) {
      throw new AppError('INVALID_STATE', 'This cloned voice is not ready yet', {
        voiceId,
        status: row.status,
      });
    }
    return {
      voiceId,
      kind: 'cloned',
      tts: requireTts(providers, row.ttsProviderId, voiceId),
      providerVoiceId: row.providerVoiceId,
      profile: row.profile ?? null,
      language: row.language,
    };
  }
  const stock = parseStockVoiceId(voiceId);
  if (!stock) throw new AppError('NOT_FOUND', 'Voice not found', { voiceId });
  return {
    voiceId,
    kind: 'stock',
    tts: requireTts(providers, stock.provider, voiceId),
    providerVoiceId: stock.providerVoiceId,
    profile: null,
    language: null,
  };
}

function requireTts(
  providers: Pick<Providers, 'tts'>,
  providerId: string,
  voiceId: string,
): TTSProvider {
  const tts = providers.tts.get(providerId);
  if (!tts) {
    throw new AppError(
      'PROVIDER_NOT_CONFIGURED',
      `The voice provider "${providerId}" is not active on this server`,
      { voiceId, providerId },
    );
  }
  return tts;
}
