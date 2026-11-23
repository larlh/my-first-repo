import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublicShareSchema, api, newId } from '@parlante/shared';
import { eq, renderJobs, shareLinks, videos } from '@parlante/db';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import videosModule from '../videos/index';
import {
  TEST_PHOTOREAL_AVATAR,
  completeRender,
  fetchUrl,
  installFakeProviders,
  talkingComposition,
} from '../videos/test-support';
import type { FakeProviders } from '../videos/test-support';
import shareModule from './index';

let t: TestApp;
let fakes: FakeProviders;

beforeAll(async () => {
  t = await createTestApp({ modules: [videosModule, shareModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  fakes = installFakeProviders(t);
});

/** A rendered video, made through the API like a user would. */
async function completedVideo(actor: TestActor, body: Record<string, unknown> = {}) {
  const created = await t.call(api.videos.create, {
    as: actor,
    body: { title: 'Demo pública', composition: talkingComposition(), ...body },
  });
  const params = { videoId: created.body.id };
  const started = await t.call(api.videos.render, { as: actor, params, body: {} });
  if (started.status !== 202) throw new Error(`Render failed: ${JSON.stringify(started.body)}`);
  await completeRender(t, created.body, { durationMs: 5300 });
  return params;
}

const publicShare = (token: string) => t.call(api.share.public, { params: { token } });

describe('share link', () => {
  it('creates, reads, updates and deletes the link of a completed video', async () => {
    const alice = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const params = await completedVideo(alice);

    expect((await t.call(api.share.get, { as: alice, params })).body).toEqual({ share: null });

    const created = await t.call(api.share.upsert, { as: alice, params, body: {} });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      videoId: params.videoId,
      enabled: true,
      allowDownload: true,
      viewCount: 0,
      expiresAt: null,
    });
    expect(created.body.token).toMatch(/^[a-z0-9]{24}$/);
    expect(created.body.url).toBe(`${t.config.PUBLIC_WEB_URL}/s/${created.body.token}`);
    expect((await t.call(api.share.get, { as: viewer, params })).body.share).toEqual(created.body);

    // Updating keeps the token (links already handed out keep working).
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const updated = await t.call(api.share.upsert, {
      as: alice,
      params,
      body: { allowDownload: false, expiresAt },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: created.body.id,
      token: created.body.token,
      enabled: true,
      allowDownload: false,
      expiresAt,
    });
    expect(await t.db.$count(shareLinks)).toBe(1);

    const removed = await t.call(api.share.remove, { as: alice, params });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true });
    expect((await t.call(api.share.get, { as: alice, params })).body).toEqual({ share: null });
    expect((await publicShare(created.body.token)).status).toBe(404);
    // Deleting revokes the token for good: a new link gets a new one.
    const recreated = await t.call(api.share.upsert, { as: alice, params, body: {} });
    expect(recreated.body.token).not.toBe(created.body.token);
    expect((await t.call(api.share.remove, { as: alice, params })).status).toBe(200);
    expect((await t.call(api.share.remove, { as: alice, params })).status).toBe(200);
  });

  it('gives every link its own unguessable token', async () => {
    const alice = await t.signUp({ plan: 'team' });
    const tokens = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const params = await completedVideo(alice);
      const res = await t.call(api.share.upsert, { as: alice, params, body: {} });
      tokens.add(res.body.token);
    }
    expect(tokens.size).toBe(4);
    for (const token of tokens) {
      // 24 characters from a 36-symbol alphabet: ~124 bits.
      expect(token).toMatch(/^[a-z0-9]{24}$/);
      expect(new Set(token).size).toBeGreaterThan(6);
    }
  });

  it('only shares completed videos and validates the request', async () => {
    // A plan that renders two videos at once (one stays queued during the test).
    const alice = await t.signUp({ plan: 'team' });
    const draft = await t.call(api.videos.create, {
      as: alice,
      body: { composition: talkingComposition() },
    });
    const params = { videoId: draft.body.id };
    const notReady = await t.call(api.share.upsert, { as: alice, params, body: {} });
    expect(notReady.status).toBe(409);
    expect(notReady.error.code).toBe('INVALID_STATE');
    await t.call(api.videos.render, { as: alice, params, body: {} });
    expect((await t.call(api.share.upsert, { as: alice, params, body: {} })).status).toBe(409);
    expect(await t.db.$count(shareLinks)).toBe(0);

    const done = await completedVideo(alice);
    const past = await t.call(api.share.upsert, {
      as: alice,
      params: done,
      body: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    expect(past.status).toBe(400);
    expect(past.error.code).toBe('VALIDATION_ERROR');
    expect(
      (await t.call(api.share.upsert, { as: alice, params: done, body: { expiresAt: 'mañana' } }))
        .status,
    ).toBe(400);
    expect(
      (await t.call(api.share.upsert, { as: alice, params: done, body: { enabled: 'yes' } }))
        .status,
    ).toBe(400);
    expect((await t.call(api.share.get, { as: alice, params: { videoId: 'nope' } })).status).toBe(
      400,
    );
    expect(await t.db.$count(shareLinks)).toBe(0);
  });

  it('enforces roles and hides videos of other workspaces', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const editor = await t.addMember(alice.workspace, 'editor');
    const params = await completedVideo(alice);
    const created = await t.call(api.share.upsert, { as: editor, params, body: {} });
    expect(created.status).toBe(200);

    expect((await t.call(api.share.get, { params })).status).toBe(401);
    expect((await t.call(api.share.upsert, { params, body: {} })).status).toBe(401);
    expect((await t.call(api.share.remove, { params })).status).toBe(401);
    expect((await t.call(api.share.upsert, { as: viewer, params, body: {} })).status).toBe(403);
    expect((await t.call(api.share.remove, { as: viewer, params })).status).toBe(403);
    expect((await t.call(api.share.get, { as: bob, params })).status).toBe(404);
    expect(
      (await t.call(api.share.upsert, { as: bob, params, body: { enabled: false } })).status,
    ).toBe(404);
    expect((await t.call(api.share.remove, { as: bob, params })).status).toBe(404);
    expect(
      (await t.call(api.share.get, { as: alice, params: { videoId: newId('video') } })).status,
    ).toBe(404);
    // Nothing Bob tried changed Alice's link.
    expect((await t.call(api.share.get, { as: alice, params })).body.share).toEqual(created.body);
    expect((await publicShare(created.body.token)).status).toBe(200);
  });
});

describe('public page', () => {
  it('serves only what the page needs, without a session, and counts views', async () => {
    const alice = await t.signUp();
    const params = await completedVideo(alice);
    const link = await t.call(api.share.upsert, { as: alice, params, body: {} });

    const res = await publicShare(link.body.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: 'Demo pública',
      aspect: '16:9',
      durationMs: 5300,
      workspaceName: alice.workspace.name,
      aiGenerated: false,
      providers: { tts: { id: 'espeak', name: 'eSpeak NG (local)', quality: 'basic' } },
    });
    // Exactly the public fields: no ids, no composition, no workspace internals.
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(PublicShareSchema.shape).sort());
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(alice.user.email);
    expect(serialized).not.toContain('"composition"');

    // The files play and download without credentials, through signed URLs.
    const play = await fetchUrl(t, res.body.videoUrl);
    expect(play.statusCode).toBe(200);
    expect(play.headers['content-type']).toBe('video/mp4');
    expect(play.headers['content-disposition']).toBeUndefined();
    const download = await fetchUrl(t, res.body.downloadUrl ?? '');
    expect(download.headers['content-disposition']).toBe('attachment; filename="Demo publica.mp4"');
    expect((await fetchUrl(t, res.body.vttUrl ?? '')).body).toContain('WEBVTT');
    expect((await fetchUrl(t, res.body.thumbnailUrl ?? '')).statusCode).toBe(200);

    await publicShare(link.body.token);
    await Promise.all([publicShare(link.body.token), publicShare(link.body.token)]);
    const after = await t.call(api.share.get, { as: alice, params });
    expect(after.body.share?.viewCount).toBe(4);
  });

  it('hides the download when it is not allowed', async () => {
    const alice = await t.signUp();
    const params = await completedVideo(alice);
    const link = await t.call(api.share.upsert, {
      as: alice,
      params,
      body: { allowDownload: false },
    });
    const res = await publicShare(link.body.token);
    expect(res.status).toBe(200);
    expect(res.body.downloadUrl).toBeNull();
    expect(res.body.videoUrl).toContain('/api/files/');
  });

  it('answers the same 404 for unknown, paused and expired links', async () => {
    const alice = await t.signUp();
    const params = await completedVideo(alice);
    const link = await t.call(api.share.upsert, { as: alice, params, body: {} });
    const token = link.body.token;

    const unknown = await publicShare('z'.repeat(24));
    expect(unknown.status).toBe(404);

    await t.call(api.share.upsert, { as: alice, params, body: { enabled: false } });
    const paused = await publicShare(token);
    expect(paused.status).toBe(404);
    expect(paused.body).toEqual(unknown.body);

    // Re-enabled with an expiry: works until the date passes.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await t.call(api.share.upsert, { as: alice, params, body: { enabled: true, expiresAt } });
    expect((await publicShare(token)).status).toBe(200);
    await t.db
      .update(shareLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(shareLinks.token, token));
    const expired = await publicShare(token);
    expect(expired.status).toBe(404);
    expect(expired.body).toEqual(unknown.body);

    // Views of links that were not served are not counted.
    const [row] = await t.db.select().from(shareLinks).where(eq(shareLinks.token, token));
    expect(row?.viewCount).toBe(1);

    expect((await publicShare('short')).status).toBe(400);
    expect((await publicShare('x'.repeat(65))).status).toBe(400);
  });

  it('stops working when the video is deleted and survives a re-render', async () => {
    const alice = await t.signUp({ credits: 20 });
    const params = await completedVideo(alice);
    const link = await t.call(api.share.upsert, { as: alice, params, body: {} });
    const first = await publicShare(link.body.token);

    // While a new render is queued the page keeps showing the current output.
    await t.call(api.videos.update, { as: alice, params, body: { title: 'Versión 2' } });
    await t.call(api.videos.render, { as: alice, params, body: {} });
    const during = await publicShare(link.body.token);
    expect(during.status).toBe(200);
    expect(during.body.videoUrl).toBe(first.body.videoUrl);
    expect(during.body.title).toBe('Versión 2');

    // …and the link can still be paused and resumed meanwhile.
    const paused = await t.call(api.share.upsert, { as: alice, params, body: { enabled: false } });
    expect(paused.status).toBe(200);
    expect((await publicShare(link.body.token)).status).toBe(404);
    await t.call(api.share.upsert, { as: alice, params, body: { enabled: true } });
    expect((await publicShare(link.body.token)).status).toBe(200);

    await t.call(api.videos.remove, { as: alice, params });
    expect((await publicShare(link.body.token)).status).toBe(404);
    expect(await t.db.$count(shareLinks)).toBe(0);
    expect((await fetchUrl(t, first.body.videoUrl)).statusCode).toBe(404);
  });

  it('labels videos rendered with photorealistic avatars as AI-generated', async () => {
    const alice = await t.signUp({ credits: 20 });
    fakes.engine = {
      available: true,
      reason: null,
      device: 'cpu',
      secondsPerVideoSecond: 20,
      operations: { generate: true, prepare: true, animate: true },
    };
    const params = await completedVideo(alice, {
      composition: talkingComposition({ avatarId: TEST_PHOTOREAL_AVATAR }),
    });
    const link = await t.call(api.share.upsert, { as: alice, params, body: {} });
    expect((await publicShare(link.body.token)).body.aiGenerated).toBe(true);

    // The label describes the file being shown: editing the draft afterwards (without
    // rendering again) does not remove it.
    await t.call(api.videos.update, {
      as: alice,
      params,
      body: { composition: talkingComposition() },
    });
    expect(await t.db.$count(renderJobs, eq(renderJobs.videoId, params.videoId))).toBe(1);
    const [video] = await t.db.select().from(videos).where(eq(videos.id, params.videoId));
    expect(video?.revision).toBe(2);
    expect((await publicShare(link.body.token)).body.aiGenerated).toBe(true);
  });
});
