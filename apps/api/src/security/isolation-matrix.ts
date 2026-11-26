import { MusicTrackSchema, allRoutes, createComposition, newId } from '@parlante/shared';
import type { Composition, RouteDef, StorageProvider } from '@parlante/shared';
import {
  encryptSecret,
  generateApiKey,
  randomToken,
  sha256Hex,
  storageKeys,
} from '@parlante/shared/node';
import {
  apiKeys,
  asc,
  assets,
  avatars,
  batchItems,
  batchJobs,
  brandKits,
  consentRecords,
  eq,
  interactiveMessages,
  interactiveSessions,
  invites,
  members,
  renderJobs,
  shareLinks,
  templates,
  translationJobs,
  translationOutputs,
  users,
  videos,
  voices,
  webhookDeliveries,
  webhookEndpoints,
} from '@parlante/db';
import type { Db } from '@parlante/db';

/* -------------------------------------------------------------------------------------------
 * WORKSPACE ISOLATION MATRIX (master prompt §5: "never return or mutate resources of another
 * workspace"; a foreign resource answers 404).
 *
 * `seedVictim` gives one workspace ONE OF EVERYTHING a tenant can own. The case builders then
 * derive, from the shared route table, every request an attacker from another workspace can
 * aim at those resources:
 *
 *   - `pathCases`  every authenticated route with a path parameter, called with the victim's id
 *   - `bodyCases`  every request body / query field that names another resource
 *
 * The matrix is driven by `contractRoutes()`: a new route with a path parameter that is not mapped
 * in `PARAM_SOURCES` makes `pathCases` throw, so it cannot be added without deciding how it is
 * attacked. It is used by `isolation.test.ts` (in-process, every test run) and by
 * `scripts/live-isolation.ts` (over HTTP against a running API).
 * ----------------------------------------------------------------------------------------- */

/** 1×1 PNG: a real picture, so routes that read the file do not fail for another reason. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Marker written into every victim text field: it must never appear in an attacker response. */
export const VICTIM_MARKER = 'VICTIMA-SECRETA';
/** Marker of the attacker's own data (the attacker gets one of everything too). */
export const ATTACKER_MARKER = 'ATACANTE';

export interface VictimResources {
  workspaceId: string;
  userId: string;
  /** Second member of the victim workspace (role editor). */
  memberId: string;
  memberUserId: string;
  inviteId: string;
  inviteToken: string;
  imageAssetId: string;
  audioAssetId: string;
  videoAssetId: string;
  consentId: string;
  /** Consents that have not been used yet (kind photo_avatar / voice_clone). */
  unusedConsentId: string;
  unusedVoiceConsentId: string;
  avatarId: string;
  voiceConsentId: string;
  voiceId: string;
  videoId: string;
  draftVideoId: string;
  renderJobId: string;
  shareToken: string;
  templateId: string;
  brandKitId: string;
  batchId: string;
  translationId: string;
  apiKeyId: string;
  /** Plain API key of the victim workspace. */
  apiKey: string;
  webhookId: string;
  deliveryId: string;
  interactiveSessionId: string;
  /** Storage keys of the victim's files (they must stay untouched and unreachable). */
  fileKeys: string[];
}

const LOCAL_PROVIDER = { id: 'local', name: 'Local', quality: 'basic', local: true } as const;

function markedComposition(marker: string): Composition {
  return createComposition({
    scenes: [
      {
        name: marker,
        script: { kind: 'tts', text: `${marker} guion`, voiceId: 'espeak:es-f1', language: 'es' },
      },
    ],
  });
}

/** One row of every tenant-owned table (plus their files) for `workspaceId`. */
export async function seedVictim(
  db: Db,
  storage: StorageProvider,
  owner: { workspaceId: string; userId: string },
  appSecret: string,
  marker: string = VICTIM_MARKER,
): Promise<VictimResources> {
  const { workspaceId, userId } = owner;
  const composition = markedComposition(marker);
  const fileKeys: string[] = [];
  const put = async (key: string, contentType: string): Promise<string> => {
    await storage.put(key, TINY_PNG, { contentType });
    fileKeys.push(key);
    return key;
  };

  /* ---- people ---- */
  const memberUserId = newId('user');
  await db.insert(users).values({
    id: memberUserId,
    email: `victim-member-${randomToken(8)}@example.test`,
    name: `${marker} member`,
    passwordHash: 'scrypt$16384$8$1$AAAA$AAAA',
  });
  const memberId = newId('member');
  await db
    .insert(members)
    .values({ id: memberId, workspaceId, userId: memberUserId, role: 'editor' });
  const inviteId = newId('invite');
  const inviteToken = randomToken(40);
  await db.insert(invites).values({
    id: inviteId,
    workspaceId,
    email: `victim-guest-${randomToken(8)}@example.test`,
    role: 'admin',
    tokenHash: sha256Hex(inviteToken),
    invitedBy: userId,
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  /* ---- assets ---- */
  const asset = async (kind: 'image' | 'audio' | 'video', ext: string, mimeType: string) => {
    const id = newId('asset');
    await db.insert(assets).values({
      id,
      workspaceId,
      kind,
      name: `${marker} ${kind}`,
      mimeType,
      sizeBytes: TINY_PNG.byteLength,
      width: kind === 'audio' ? null : 1,
      height: kind === 'audio' ? null : 1,
      durationMs: kind === 'image' ? null : 12_000,
      storageKey: await put(storageKeys.asset(workspaceId, id, ext), mimeType),
      thumbnailKey:
        kind === 'audio' ? null : await put(storageKeys.assetThumb(workspaceId, id), 'image/jpeg'),
      createdBy: userId,
    });
    return id;
  };
  const imageAssetId = await asset('image', 'png', 'image/png');
  const audioAssetId = await asset('audio', 'wav', 'audio/wav');
  const videoAssetId = await asset('video', 'mp4', 'video/mp4');

  /* ---- consent, avatar, voice ---- */
  const consent = async (kind: 'photo_avatar' | 'voice_clone', resourceId: string | null) => {
    const id = newId('consent');
    await db.insert(consentRecords).values({
      id,
      workspaceId,
      userId,
      kind,
      subjectName: `${marker} persona`,
      relationship: 'self',
      statementVersion: '2026-01',
      statement: 'Declaro…',
      locale: 'es',
      ip: '203.0.113.7',
      resourceId,
      usedAt: resourceId ? new Date() : null,
    });
    return id;
  };
  const avatarId = newId('avatar');
  const consentId = await consent('photo_avatar', avatarId);
  const unusedConsentId = await consent('photo_avatar', null);
  const unusedVoiceConsentId = await consent('voice_clone', null);
  await db.insert(avatars).values({
    id: avatarId,
    workspaceId,
    name: `${marker} avatar`,
    status: 'ready',
    progress: 100,
    origin: 'photo',
    imageKey: await put(storageKeys.avatarFile(workspaceId, avatarId, 'image.png'), 'image/png'),
    maskKey: await put(storageKeys.avatarFile(workspaceId, avatarId, 'mask.png'), 'image/png'),
    cutoutKey: await put(storageKeys.avatarFile(workspaceId, avatarId, 'cutout.png'), 'image/png'),
    thumbnailKey: await put(
      storageKeys.avatarFile(workspaceId, avatarId, 'thumb.jpg'),
      'image/jpeg',
    ),
    provider: LOCAL_PROVIDER,
    consentId,
    createdBy: userId,
  });
  const voiceId = newId('voice');
  const voiceConsentId = await consent('voice_clone', voiceId);
  await db.insert(voices).values({
    id: voiceId,
    workspaceId,
    name: `${marker} voz`,
    language: 'es',
    status: 'ready',
    ttsProviderId: 'espeak',
    providerVoiceId: 'es',
    profile: null,
    provider: LOCAL_PROVIDER,
    consentId: voiceConsentId,
    createdBy: userId,
  });
  await put(storageKeys.voiceSample(workspaceId, voiceId), 'audio/wav');

  /* ---- videos, render job, share link ---- */
  const videoId = newId('video');
  const draftVideoId = newId('video');
  const renderJobId = newId('renderJob');
  const output = (file: 'video.mp4' | 'thumb.jpg' | 'subtitles.srt' | 'subtitles.vtt') =>
    storageKeys.videoOutput(workspaceId, videoId, renderJobId, file);
  await db.insert(videos).values([
    {
      id: videoId,
      workspaceId,
      title: `${marker} vídeo`,
      status: 'completed',
      progress: 100,
      composition,
      aspect: '16:9',
      resolution: '720p',
      durationMs: 4000,
      renderedRevision: 1,
      videoKey: await put(output('video.mp4'), 'video/mp4'),
      thumbnailKey: await put(output('thumb.jpg'), 'image/jpeg'),
      srtKey: await put(output('subtitles.srt'), 'application/x-subrip'),
      vttKey: await put(output('subtitles.vtt'), 'text/vtt'),
      currentRenderJobId: renderJobId,
      createdBy: userId,
      renderedAt: new Date(),
    },
    {
      id: draftVideoId,
      workspaceId,
      title: `${marker} borrador`,
      status: 'draft',
      composition,
      aspect: '16:9',
      createdBy: userId,
    },
  ]);
  await db.insert(renderJobs).values({
    id: renderJobId,
    workspaceId,
    videoId,
    status: 'completed',
    progress: 100,
    resolution: '720p',
    composition,
    revision: 1,
    creditsCharged: 1,
    createdBy: userId,
    finishedAt: new Date(),
  });
  const shareToken = randomToken(24);
  await db.insert(shareLinks).values({
    id: newId('shareLink'),
    workspaceId,
    videoId,
    token: shareToken,
    enabled: false, // a DISABLED link: nobody may read the video through it
    createdBy: userId,
  });

  /* ---- template, brand kit ---- */
  const templateId = newId('template');
  await db.insert(templates).values({
    id: templateId,
    workspaceId,
    name: `${marker} plantilla`,
    aspect: '16:9',
    composition,
    thumbnailKey: await put(storageKeys.templateThumb(workspaceId, templateId), 'image/jpeg'),
    createdBy: userId,
  });
  const brandKitId = newId('brandKit');
  await db.insert(brandKits).values({
    id: brandKitId,
    workspaceId,
    name: `${marker} marca`,
    logoAssetId: imageAssetId,
    colors: {
      primary: '#111111',
      secondary: '#222222',
      accent: '#333333',
      background: '#444444',
      text: '#555555',
    },
    fonts: { heading: 'Poppins', body: 'Inter' },
    createdBy: userId,
  });

  /* ---- batch, translation ---- */
  const batchId = newId('batchJob');
  await db.insert(batchJobs).values({
    id: batchId,
    workspaceId,
    name: `${marker} lote`,
    sourceVideoId: draftVideoId,
    composition,
    variables: ['nombre'],
    resolution: '720p',
    status: 'processing',
    total: 1,
    createdBy: userId,
  });
  await db.insert(batchItems).values({
    id: newId('batchItem'),
    workspaceId,
    batchJobId: batchId,
    index: 0,
    values: { nombre: marker },
    status: 'pending',
  });
  const translationId = newId('translationJob');
  await db.insert(translationJobs).values({
    id: translationId,
    workspaceId,
    name: `${marker} traducción`,
    sourceAssetId: videoAssetId,
    sourceDurationMs: 12_000,
    sourceLanguage: 'es',
    targetLanguages: ['en'],
    status: 'completed',
    progress: 100,
    transcriptSource: 'user',
    transcript: [{ startMs: 0, endMs: 1000, text: marker }],
    options: { originalAudioVolume: 0.08, burnSubtitles: false },
    createdBy: userId,
  });
  await db.insert(translationOutputs).values({
    id: newId('translationOutput'),
    workspaceId,
    jobId: translationId,
    language: 'en',
    voiceId: 'espeak:en-f1',
    status: 'completed',
    segments: [{ startMs: 0, endMs: 1000, text: marker }],
    videoKey: await put(
      storageKeys.translationOutput(workspaceId, translationId, 'en', 'video.mp4'),
      'video/mp4',
    ),
  });

  /* ---- API key, webhook, delivery ---- */
  const generated = generateApiKey();
  const apiKeyId = newId('apiKey');
  await db.insert(apiKeys).values({
    id: apiKeyId,
    workspaceId,
    name: `${marker} clave`,
    prefix: generated.prefix,
    keyHash: generated.hash,
    createdBy: userId,
  });
  const webhookId = newId('webhookEndpoint');
  await db.insert(webhookEndpoints).values({
    id: webhookId,
    workspaceId,
    url: 'https://hooks.example.test/victim',
    description: marker,
    events: ['video.completed'],
    secretEncrypted: encryptSecret(appSecret, `whsec_${randomToken(32)}`),
    secretPreview: 'whsec_…',
    createdBy: userId,
  });
  const deliveryId = newId('webhookDelivery');
  await db.insert(webhookDeliveries).values({
    id: deliveryId,
    workspaceId,
    endpointId: webhookId,
    eventId: newId('event'),
    eventType: 'video.completed',
    payload: {
      id: newId('event'),
      type: 'video.completed',
      createdAt: new Date().toISOString(),
      workspaceId,
      data: {},
    },
    status: 'failed',
    attempts: 5,
    error: marker,
  });

  /* ---- interactive session ---- */
  const interactiveSessionId = newId('interactiveSession');
  await db.insert(interactiveSessions).values({
    id: interactiveSessionId,
    workspaceId,
    userId,
    avatarId: 'stock_lucia',
    voiceId: 'espeak:es-f1',
    language: 'es',
    persona: { name: marker, instructions: marker, knowledge: marker },
    providers: {},
    messageCount: 1,
  });
  await db.insert(interactiveMessages).values({
    id: newId('interactiveMessage'),
    workspaceId,
    sessionId: interactiveSessionId,
    role: 'user',
    text: marker,
  });

  return {
    workspaceId,
    userId,
    memberId,
    memberUserId,
    inviteId,
    inviteToken,
    imageAssetId,
    audioAssetId,
    videoAssetId,
    consentId,
    unusedConsentId,
    unusedVoiceConsentId,
    avatarId,
    voiceConsentId,
    voiceId,
    videoId,
    draftVideoId,
    renderJobId,
    shareToken,
    templateId,
    brandKitId,
    batchId,
    translationId,
    apiKeyId,
    apiKey: generated.key,
    webhookId,
    deliveryId,
    interactiveSessionId,
    fileKeys,
  };
}

/** Everything the attacker must not be able to change: a stable fingerprint of the victim rows. */
export async function victimFingerprint(db: Db, victim: VictimResources): Promise<string> {
  const ws = victim.workspaceId;
  const tables = [
    members,
    invites,
    assets,
    consentRecords,
    avatars,
    voices,
    videos,
    renderJobs,
    shareLinks,
    templates,
    brandKits,
    batchJobs,
    batchItems,
    translationJobs,
    translationOutputs,
    apiKeys,
    webhookEndpoints,
    webhookDeliveries,
    interactiveSessions,
    interactiveMessages,
  ] as const;
  const parts: string[] = [];
  for (const table of tables) {
    const rows = await db
      .select()
      .from(table)
      .where(eq(table.workspaceId, ws))
      .orderBy(asc(table.id));
    parts.push(
      JSON.stringify(rows, (key, value: unknown) => (key === 'lastUsedAt' ? null : value)),
    );
  }
  return sha256Hex(parts.join('\n'));
}

export interface AttackCase {
  /** `METHOD /path` of the contract route. */
  id: string;
  route: RouteDef;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  /** Why this case exists (shown when it fails). */
  note?: string;
  /** Accepted answers. Default: 404 only. */
  expect?: readonly number[];
}

export const routeId = (route: RouteDef): string => `${route.method} ${route.path}`;

/** Every route of the shared contract. */
export const contractRoutes = (): RouteDef[] => allRoutes().map((entry) => entry.route);

/**
 * Which victim id fills each path parameter. Keyed by parameter name; routes that reuse a name
 * for a different resource are listed by `METHOD /path` first.
 */
const PARAM_SOURCES: Record<string, (victim: VictimResources) => string> = {
  videoId: (v) => v.videoId,
  assetId: (v) => v.imageAssetId,
  avatarId: (v) => v.avatarId,
  voiceId: (v) => v.voiceId,
  templateId: (v) => v.templateId,
  brandKitId: (v) => v.brandKitId,
  batchId: (v) => v.batchId,
  translationId: (v) => v.translationId,
  apiKeyId: (v) => v.apiKeyId,
  webhookId: (v) => v.webhookId,
  deliveryId: (v) => v.deliveryId,
  consentId: (v) => v.consentId,
  memberId: (v) => v.memberId,
  inviteId: (v) => v.inviteId,
  sessionId: (v) => v.interactiveSessionId,
};

/** A VALID body for every route with a path parameter that takes one (so validation passes). */
const PATH_ROUTE_BODIES: Record<string, (attackerBrandKitId: string) => unknown> = {
  'PATCH /api/members/:memberId': () => ({ role: 'viewer' }),
  'PATCH /api/webhooks/:webhookId': () => ({ description: 'pwned' }),
  'PATCH /api/videos/:videoId': () => ({ title: 'pwned' }),
  'POST /api/videos/:videoId/render': () => ({}),
  'POST /api/videos/:videoId/save-as-template': () => ({ name: 'pwned' }),
  'POST /api/videos/:videoId/apply-brand-kit': (brandKitId) => ({ brandKitId }),
  'PUT /api/videos/:videoId/share': () => ({ enabled: true }),
  'PATCH /api/assets/:assetId': () => ({ name: 'pwned' }),
  'POST /api/templates/:templateId/use': () => ({}),
  'PATCH /api/templates/:templateId': () => ({ name: 'pwned' }),
  'PATCH /api/brand-kits/:brandKitId': () => ({ name: 'pwned' }),
  'POST /api/interactive/sessions/:sessionId/messages': () => ({ text: 'hola' }),
  'PATCH /api/photo-avatars/:avatarId': () => ({ name: 'pwned' }),
  'PATCH /api/voice-clones/:voiceId': () => ({ name: 'pwned' }),
};

const paramNames = (path: string): string[] =>
  [...path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1] ?? '');

/**
 * One case per AUTHENTICATED route that has a path parameter: the victim's id in the path, a
 * valid body, the attacker's credentials. Each must answer 404.
 * `extra` supplies ids that only exist at run time (a worker ping job of the victim).
 */
export function pathCases(
  victim: VictimResources,
  attacker: { brandKitId: string },
  extra: { pingJobId: string },
): AttackCase[] {
  const cases: AttackCase[] = [];
  for (const route of contractRoutes()) {
    if (route.auth === 'public') continue;
    const names = paramNames(route.path);
    if (names.length === 0) continue;
    const id = routeId(route);
    const params: Record<string, string> = {};
    for (const name of names) {
      if (name === 'jobId') {
        params[name] = extra.pingJobId;
        continue;
      }
      const source = PARAM_SOURCES[name];
      if (!source) {
        throw new Error(
          `isolation-matrix: path parameter ":${name}" of ${id} has no victim id. Add it to PARAM_SOURCES (and seed the resource in seedVictim) so the route is covered.`,
        );
      }
      params[name] = source(victim);
    }
    const body = PATH_ROUTE_BODIES[id]?.(attacker.brandKitId);
    cases.push({ id, route, params, ...(body !== undefined ? { body } : {}) });
  }
  return cases;
}

/** Routes of `pathCases` that the public API also exposes: attacked with an API key. */
export const isApiKeyRoute = (route: RouteDef): boolean => route.auth === 'apiKey';

function findRoute(id: string): RouteDef {
  const route = contractRoutes().find((candidate) => routeId(candidate) === id);
  if (!route) throw new Error(`isolation-matrix: unknown route ${id}`);
  return route;
}

/**
 * Requests whose BODY or QUERY names a resource of the victim. None may succeed in a way that
 * reads or uses the victim resource: 404 (or the 400/403/422 the contract gives for a
 * reference that does not exist in the caller's workspace).
 */
export function bodyCases(
  victim: VictimResources,
  attacker: {
    videoId: string;
    imageAssetId: string;
    audioAssetId: string;
    photoConsentId: string;
    voiceConsentId: string;
  },
): AttackCase[] {
  const NOT_MINE = [400, 404, 422] as const;
  const withVictimRefs = createComposition({
    scenes: [
      {
        script: { kind: 'audio', assetId: victim.audioAssetId, transcript: 'hola' },
        background: { type: 'image', src: { source: 'asset', assetId: victim.imageAssetId } },
        layers: [
          {
            type: 'avatar',
            avatarId: victim.avatarId,
            box: { x: 0.3, y: 0.2, w: 0.4, h: 0.8 },
          },
        ],
      },
    ],
  });
  const c = (
    id: string,
    note: string,
    input: Partial<Pick<AttackCase, 'params' | 'query' | 'body' | 'expect'>>,
  ): AttackCase => ({ id, route: findRoute(id), note, ...input });

  return [
    c('POST /api/auth/switch-workspace', 'switch into the victim workspace', {
      body: { workspaceId: victim.workspaceId },
    }),
    c('POST /api/invites/accept', 'accept an invitation addressed to someone else', {
      body: { token: victim.inviteToken },
      expect: [403, 404, 409],
    }),
    c('POST /api/videos', 'draft from the victim template', {
      body: { templateId: victim.templateId },
    }),
    c('POST /api/videos/:videoId/apply-brand-kit', 'victim brand kit on my video', {
      params: { videoId: attacker.videoId },
      body: { brandKitId: victim.brandKitId },
    }),
    c('POST /api/brand-kits', 'victim asset as my logo', {
      body: { name: 'x', logoAssetId: victim.imageAssetId },
      expect: NOT_MINE,
    }),
    c('POST /api/translations', 'translate the victim asset', {
      body: {
        sourceAssetId: victim.videoAssetId,
        sourceLanguage: 'es',
        targetLanguages: ['en'],
        transcript: { format: 'text', content: 'hola' },
      },
      expect: NOT_MINE,
    }),
    c('POST /api/translations', 'translate the victim video', {
      body: {
        sourceVideoId: victim.videoId,
        sourceLanguage: 'es',
        targetLanguages: ['en'],
        transcript: { format: 'text', content: 'hola' },
      },
      expect: NOT_MINE,
    }),
    c('POST /api/batches/preview', 'batch preview of the victim video', {
      body: { sourceVideoId: victim.draftVideoId, csv: 'nombre\nAna' },
    }),
    c('POST /api/batches', 'batch from the victim video', {
      body: { name: 'x', sourceVideoId: victim.draftVideoId, csv: 'nombre\nAna' },
    }),
    c('POST /api/interactive/sessions', 'talk to the victim avatar', {
      body: { avatarId: victim.avatarId, voiceId: 'espeak:es-f1', persona: { name: 'x' } },
      expect: NOT_MINE,
    }),
    c('POST /api/interactive/sessions', 'talk with the victim cloned voice', {
      body: { avatarId: 'stock_lucia', voiceId: victim.voiceId, persona: { name: 'x' } },
      expect: NOT_MINE,
    }),
    c('POST /api/tts/synthesize', 'speak with the victim cloned voice', {
      body: { text: 'hola', voiceId: victim.voiceId, language: 'es' },
      expect: NOT_MINE,
    }),
    c('POST /api/photo-avatars', 'avatar from the victim photo (my consent)', {
      body: { name: 'x', imageAssetId: victim.imageAssetId, consentId: attacker.photoConsentId },
      // 503 = the engine check runs first when no engine is up; nothing was read or created.
      expect: [...NOT_MINE, 503],
    }),
    c('POST /api/photo-avatars', 'avatar with the victim consent (my photo)', {
      body: { name: 'x', imageAssetId: attacker.imageAssetId, consentId: victim.unusedConsentId },
      expect: [403],
    }),
    c('POST /api/voice-clones', 'clone from the victim sample (my consent)', {
      body: {
        name: 'x',
        sampleAssetId: victim.audioAssetId,
        consentId: attacker.voiceConsentId,
        language: 'es',
      },
      expect: NOT_MINE,
    }),
    c('POST /api/voice-clones', 'clone with the victim consent (my sample)', {
      body: {
        name: 'x',
        sampleAssetId: attacker.audioAssetId,
        consentId: victim.unusedVoiceConsentId,
        language: 'es',
      },
      expect: [403],
    }),
    c('POST /v1/videos', 'v1: video from the victim template', {
      body: { input: { type: 'template', templateId: victim.templateId }, render: false },
    }),
    c('POST /v1/videos', 'v1: script video with the victim avatar', {
      body: {
        input: { type: 'script', text: 'hola', avatarId: victim.avatarId, voiceId: 'espeak:es-f1' },
      },
      expect: NOT_MINE,
    }),
    c('POST /v1/videos', 'v1: script video with the victim voice', {
      body: {
        input: { type: 'script', text: 'hola', avatarId: 'stock_lucia', voiceId: victim.voiceId },
      },
      expect: NOT_MINE,
    }),
    c('POST /v1/videos', 'v1: composition that references victim avatar, audio and image', {
      body: { input: { type: 'composition', composition: withVictimRefs } },
      expect: NOT_MINE,
    }),
  ];
}

/** A composition of the ATTACKER that points at the victim's image, audio and avatar. */
export function compositionWithVictimMedia(
  victim: VictimResources,
  what: 'background' | 'narration' | 'avatar' | 'music',
): Composition {
  const base = createComposition({
    scenes: [
      {
        script:
          what === 'narration'
            ? { kind: 'audio', assetId: victim.audioAssetId, transcript: 'hola' }
            : { kind: 'tts', text: 'hola', voiceId: 'espeak:es-f1', language: 'es' },
        background:
          what === 'background'
            ? { type: 'image', src: { source: 'asset', assetId: victim.imageAssetId } }
            : { type: 'color', color: '#101322' },
        layers:
          what === 'avatar'
            ? [
                {
                  type: 'avatar',
                  avatarId: victim.avatarId,
                  box: { x: 0.3, y: 0.2, w: 0.4, h: 0.8 },
                },
              ]
            : [],
      },
    ],
  });
  if (what !== 'music') return base;
  return {
    ...base,
    music: MusicTrackSchema.parse({ src: { source: 'asset', assetId: victim.audioAssetId } }),
  };
}

/** Every string id of the victim that an attacker response must never contain. */
export function victimSecrets(victim: VictimResources): string[] {
  return [
    VICTIM_MARKER,
    victim.memberId,
    victim.inviteId,
    victim.imageAssetId,
    victim.audioAssetId,
    victim.videoAssetId,
    victim.consentId,
    victim.unusedConsentId,
    victim.unusedVoiceConsentId,
    victim.voiceConsentId,
    victim.avatarId,
    victim.voiceId,
    victim.videoId,
    victim.draftVideoId,
    victim.renderJobId,
    victim.shareToken,
    victim.templateId,
    victim.brandKitId,
    victim.batchId,
    victim.translationId,
    victim.apiKeyId,
    victim.webhookId,
    victim.deliveryId,
    victim.interactiveSessionId,
  ];
}

/** Session routes without parameters that only read: the attacker's own lists. */
export function listRoutes(): RouteDef[] {
  return contractRoutes().filter(
    (route) => route.method === 'GET' && route.auth !== 'public' && !route.path.includes(':'),
  );
}
