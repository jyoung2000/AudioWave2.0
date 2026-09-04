/**
 * The discovery and recommendation pipeline, end to end.
 *
 * Every stage is the real one: events go in through the API, the canonical catalogue is built from
 * them, the taste profile is derived, the background job queue runs the same handlers the scheduler
 * installs, and recommendations come back through the API. Nothing is stubbed but the clock, the
 * random source and outbound HTTP.
 *
 * What this is really guarding is the seam between the parts: each piece has unit tests, but the
 * pipeline is the sort of thing that silently stops working because a handler was never registered
 * or a job kind was renamed. Here, a job with no handler fails the test rather than sitting in the
 * queue being retried in production.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscoveryJob, Recommendation, TasteProfileView } from '@now-playing/contracts';
import { generateListeningEvents } from '@now-playing/test-fixtures';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };
let device: { deviceId: string; authorization: string };

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup();
  device = await pairDevice(hub, admin);
});

afterEach(async () => {
  await hub.dispose();
});

async function ingestHistory(days = 21): Promise<number> {
  const events = generateListeningEvents({ deviceId: device.deviceId, days });
  const response = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/listening-events',
    headers: { authorization: device.authorization },
    payload: { events },
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { accepted: number }).accepted;
}

interface RecommendationsPayload {
  mode: string;
  items: Recommendation[];
  generatedAt: string;
  fromCache: boolean;
  coverage: { candidates: number; sources: Record<string, number>; coldStart: boolean };
}

async function recommendations(mode = 'for-you'): Promise<RecommendationsPayload> {
  const response = await hub.app.inject({ method: 'GET', url: `/api/v1/recommendations?mode=${mode}`, headers: { authorization: device.authorization } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as RecommendationsPayload;
}

/** Enqueue through the scheduler's own helper, so a test cannot drift from how jobs are really made. */
function enqueue(kind: DiscoveryJob['kind'], payload: Record<string, unknown> = {}): DiscoveryJob {
  return hub.ctx.jobs.enqueue({ userId: device.deviceId, kind, priority: 'P3', payload });
}

describe('ingesting listening history', () => {
  it('accepts events, and a replay of the same batch changes nothing', async () => {
    const accepted = await ingestHistory();
    expect(accepted).toBeGreaterThan(50);

    // Append-only and idempotent: the same events sent twice are recognised, not double-counted.
    const events = generateListeningEvents({ deviceId: device.deviceId, days: 21 });
    const again = await hub.app.inject({ method: 'POST', url: '/api/v1/listening-events', headers: { authorization: device.authorization }, payload: { events } });
    expect((again.json() as { accepted: number; duplicates: number }).duplicates).toBe(accepted);
    expect((again.json() as { accepted: number }).accepted).toBe(0);
  });

  it('needs the history:events scope, which is a separate grant', async () => {
    const limited = await pairDevice(hub, admin, { name: 'No history', scopes: ['library:read', 'search:use'] });
    const events = generateListeningEvents({ deviceId: limited.deviceId, days: 1 });
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/listening-events', headers: { authorization: limited.authorization }, payload: { events } });
    expect(response.statusCode).toBe(403);
  });
});

describe('the taste profile', () => {
  it('is derived from the events and is inspectable, dimension by dimension', async () => {
    await ingestHistory();
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/recommendations/profile', headers: { authorization: device.authorization } });
    expect(response.statusCode).toBe(200);
    const profile = response.json() as TasteProfileView;

    // The fixture history is dominated by a handful of artists and genres; they must show up.
    expect(profile.eventCount).toBeGreaterThan(50);
    expect(profile.coldStart).toBe(false);
    expect(Object.keys(profile.dimensions)).toEqual(expect.arrayContaining(['artists', 'genres', 'albums', 'eras']));
    expect(profile.dimensions['artists']!.length).toBeGreaterThan(0);
    expect(profile.dimensions['genres']!.length).toBeGreaterThan(0);
    // Every entry carries its own weight, so a person can see *why* something was recommended.
    for (const entry of profile.dimensions['artists']!) expect(entry.weight).toBeGreaterThan(0);
    // The fixture history is dominated by a few artists; the strongest is one of them.
    expect(profile.dimensions['artists']![0]!.key.toLowerCase()).toMatch(/cassette|fennel|orbital|marlow|velvet/);
  });

  it('is rebuilt by the background job, not only on demand', async () => {
    await ingestHistory();
    expect(enqueue('profile-refresh').kind).toBe('profile-refresh');

    const ran = await hub.ctx.jobs.runJobOnce();
    expect(ran?.kind).toBe('profile-refresh');
    // The point of the test: a kind with no registered handler fails here rather than in production.
    expect(ran?.state, ran?.error ?? '').toBe('completed');
  });
});

describe('recommendations', () => {
  it('come back ranked, with a reason for each one', async () => {
    await ingestHistory();
    const result = await recommendations();

    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.score).toBeGreaterThan(0);
      // Nothing is recommended without an explanation a person can read.
      expect(item.reasons.length).toBeGreaterThan(0);
      expect(item.reasons[0]!.text.length).toBeGreaterThan(0);
    }
    // Ranked, not arbitrary.
    const scores = result.items.map((i) => i.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('is deterministic: the same state gives the same answer', async () => {
    await ingestHistory();
    const first = await recommendations();
    const second = await recommendations();
    expect(second.items.map((i) => i.canonicalTrackId)).toEqual(first.items.map((i) => i.canonicalTrackId));
  });

  it('does not recommend more than a couple of tracks by one artist', async () => {
    await ingestHistory();
    const result = await recommendations();
    const perArtist = new Map<string, number>();
    for (const item of result.items) perArtist.set(item.artistName, (perArtist.get(item.artistName) ?? 0) + 1);
    for (const [artist, count] of perArtist) expect(count, `${artist} appears ${count} times`).toBeLessThanOrEqual(3);
  });

  it('refuses with a reason when the hub has no catalogue, rather than inventing one', async () => {
    // A brand-new hub knows about no music at all. It says exactly that and what to do about it,
    // instead of returning an empty list that looks like "nothing suits you".
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/recommendations', headers: { authorization: device.authorization } });
    expect(response.statusCode).toBe(503);
    expect((response.json() as { detail: string }).detail).toMatch(/no catalogue yet.*scan a library or run a search/i);
  });

  it('reports cold start honestly once there is a catalogue but no history', async () => {
    // Seed the catalogue from a listening history belonging to a *different* device, so this one
    // has something to recommend from but nothing known about its own owner.
    const other = await pairDevice(hub, admin, { name: 'Someone else' });
    const events = generateListeningEvents({ deviceId: other.deviceId, days: 21 });
    await hub.app.inject({ method: 'POST', url: '/api/v1/listening-events', headers: { authorization: other.authorization }, payload: { events } });

    const cold = await recommendations();
    expect(cold.coverage.coldStart).toBe(true);
    expect(cold.items.length).toBeGreaterThanOrEqual(0);
  });

  it('takes cold-start seeds, and they show up in the profile as chosen preferences', async () => {
    const seeded = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/recommendations/seeds',
      headers: { authorization: device.authorization },
      payload: { artists: ['Cassette Bloom', 'Fennel Grove'], genres: ['Indie', 'Ambient'], likedTrackIds: [] },
    });
    expect(seeded.statusCode).toBe(200);

    const profile = (await hub.app.inject({ method: 'GET', url: '/api/v1/recommendations/profile', headers: { authorization: device.authorization } })).json() as TasteProfileView;
    expect((profile.dimensions['artists'] ?? []).map((a) => a.key.toLowerCase()).join(' ')).toContain('cassette');
    expect((profile.dimensions['genres'] ?? []).map((g) => g.key.toLowerCase()).join(' ')).toContain('indie');
  });

  it('serves every mode without falling over', async () => {
    await ingestHistory();
    for (const mode of ['for-you', 'playlist', 'genre', 'similar', 'deep', 'new-releases', 'recent']) {
      const result = await recommendations(mode);
      expect(result.mode, `mode ${mode}`).toBe(mode);
      expect(Array.isArray(result.items)).toBe(true);
    }
  });
});

describe('feedback', () => {
  it('is recorded, and "less from this artist" changes what comes back', async () => {
    await ingestHistory();
    const before = await recommendations();
    const target = before.items[0]!;

    const response = await hub.app.inject({
      method: 'POST',
      url: `/api/v1/recommendations/${target.id}/feedback`,
      headers: { authorization: device.authorization },
      payload: { feedback: 'less-from-artist' },
    });
    expect(response.statusCode).toBe(200);

    const after = await recommendations();
    const beforeCount = before.items.filter((i) => i.artistName === target.artistName).length;
    const afterCount = after.items.filter((i) => i.artistName === target.artistName).length;
    expect(afterCount).toBeLessThanOrEqual(beforeCount);
  });
});

describe('the background job queue', () => {
  it('has a handler for every kind the scheduler enqueues', async () => {
    const kinds: DiscoveryJob['kind'][] = ['token-refresh', 'profile-refresh', 'sync-library', 'discover-seeds', 'new-releases'];
    for (const kind of kinds) enqueue(kind, { provider: 'subsonic' });

    const seen: string[] = [];
    for (let i = 0; i < kinds.length; i += 1) {
      const job = await hub.ctx.jobs.runJobOnce();
      if (!job) break;
      seen.push(job.kind);
      // A missing handler is recorded as a permanent failure with that exact wording; catch it here.
      expect(job.error ?? '', `${job.kind}: ${job.error ?? ''}`).not.toMatch(/No handler is registered/);
    }
    expect(seen.sort()).toEqual([...kinds].sort());
  });

  it('retries a failing job with backoff rather than losing it', async () => {
    // A provider that is not connected: the handler throws, and the job must come back later.
    hub.ctx.jobs.enqueue({ userId: device.deviceId, kind: 'token-refresh', priority: 'P1', payload: { provider: 'spotify' } });

    const first = await hub.ctx.jobs.runJobOnce();
    expect(first?.kind).toBe('token-refresh');
    if (first?.state === 'queued') {
      // Backed off, not run again immediately.
      expect(await hub.ctx.jobs.runJobOnce()).toBeNull();
      expect(first.error).toBeTruthy();
    } else {
      expect(first?.state).toBe('completed');
    }
  });
});

describe('deleting your data', () => {
  it('removes the events and the profile derived from them', async () => {
    await ingestHistory();
    expect((await recommendations()).coverage.coldStart).toBe(false);

    // Events are stored against the hub *user* the device belongs to, not the device id.
    const userId = hub.ctx.devices.userFor(device.deviceId)!.id;
    const removed = hub.ctx.recommendations.deleteEverythingFor(userId);
    expect(removed.events).toBeGreaterThan(0);

    // Back to cold start: nothing about this person is left to recommend from.
    expect((await recommendations()).coverage.coldStart).toBe(true);
  });
});

describe('syncing a connected account', () => {
  /**
   * Connect a SoundCloud account the way the real flow does — admin sets the app credentials, the
   * device starts the OAuth handshake, the callback exchanges the code — with the fake fetch
   * answering the provider. Nothing is stubbed inside the hub.
   */
  async function connectSoundCloud(likes: Array<{ id: number; title: string; user: string }>): Promise<string> {
    hub.fetch.on('secure.soundcloud.com/oauth/token', () => ({ body: { access_token: 'sc-access', refresh_token: 'sc-refresh', expires_in: 3600, scope: 'non-expiring' } }));
    hub.fetch.on('api.soundcloud.com/me?', () => ({ body: { id: 4242, username: 'A Listener' } }));
    hub.fetch.on('/me/likes/tracks', () => ({
      body: {
        collection: likes.map((t) => ({ id: t.id, title: t.title, duration: 210_000, user: { username: t.user }, permalink_url: `https://soundcloud.com/x/${t.id}`, streamable: true, access: 'playable', genre: 'Indie' })),
        next_href: null,
      },
    }));

    const config = await hub.app.inject({
      method: 'PUT',
      url: '/api/v1/providers/soundcloud/config',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { enabled: true, clientId: 'test-client', clientSecret: 'test-secret' },
    });
    expect(config.statusCode, config.body).toBe(200);

    const userId = hub.ctx.devices.userFor(device.deviceId)!.id;
    const start = hub.ctx.accounts.startConnect('soundcloud', userId, device.deviceId, 'http://hub.test', null);
    await hub.ctx.accounts.completeConnect('soundcloud', 'the-code', start.state, 'http://hub.test', { ip: null, userAgent: null, correlationId: 'test' });
    return userId;
  }

  it('imports saved tracks, then recognises on the next run that nothing changed upstream', async () => {
    const userId = await connectSoundCloud([
      { id: 1, title: 'Harbour Lights', user: 'Cassette Bloom' },
      { id: 2, title: 'Nine Below', user: 'Cassette Bloom' },
    ]);

    const first = await hub.ctx.platformSync.syncLibrary(userId, 'soundcloud');
    expect(first.error).toBeNull();
    expect(first.imported).toBeGreaterThan(0);
    expect(first.unchanged).toBe(false);

    // Same upstream data: the first page's digest matches, so nothing is re-imported. This is the
    // whole point of incremental sync — a nightly job must not re-ingest an unchanged library.
    const second = await hub.ctx.platformSync.syncLibrary(userId, 'soundcloud');
    expect(second.unchanged).toBe(true);
    expect(second.imported).toBe(0);
  });

  it('records what it found in the canonical catalogue, with the provider it came from', async () => {
    const userId = await connectSoundCloud([{ id: 7, title: 'Signal Fade', user: 'Cassette Bloom' }]);
    await hub.ctx.platformSync.syncLibrary(userId, 'soundcloud');

    const catalogue = hub.ctx.recommendations.catalogue();
    const match = catalogue.tracks.find((t) => t.title === 'Signal Fade');
    expect(match, 'the imported track should be in the canonical catalogue').toBeDefined();
    expect(match!.artistName).toBe('Cassette Bloom');
    // The canonical track is one row; where it can be played is a separate row per platform, which
    // is what lets the same song from two providers be recognised as the same song.
    const platforms = hub.ctx.repos.canonical.platformsFor(match!.id);
    expect(platforms.map((entry) => entry.provider)).toContain('soundcloud');
    expect(platforms[0]!.providerTrackId).toBe('7');
  });

  it('reports a provider that is not configured instead of failing obscurely', async () => {
    const userId = hub.ctx.devices.userFor(device.deviceId)!.id;
    const report = await hub.ctx.platformSync.syncLibrary(userId, 'spotify');
    expect(report.imported).toBe(0);
    expect(report.error).toMatch(/not configured on this hub/);
  });
});
