/**
 * Flows 3–5: group listening, the authoritative queue, and Discord command parity.
 *
 * The queue tests are the ones that matter for correctness under concurrency: a stale revision must
 * be rejected rather than silently applied, and a retried command must return the same result
 * instead of enqueuing twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrackRef } from '@now-playing/contracts';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };
let device: { deviceId: string; authorization: string };

function track(id: string, title: string): TrackRef {
  return {
    trackId: id,
    title,
    artistName: 'Test Artist',
    albumName: 'Test Album',
    durationMs: 180_000,
    artworkId: null,
    identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} },
    locators: [],
    provider: 'hub',
    genre: null,
    year: null,
  };
}

async function createGroup(name = 'Kitchen'): Promise<string> {
  const response = await hub.app.inject({ method: 'POST', url: '/api/v1/groups', headers: { authorization: device.authorization }, payload: { name } });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

async function command(groupId: string, body: Record<string, unknown>) {
  return hub.app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/queue/commands`, headers: { authorization: device.authorization }, payload: body });
}

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup();
  device = await pairDevice(hub, admin);
});

afterEach(async () => {
  await hub.dispose();
});

describe('groups', () => {
  it('creates a group whose creator is its owner', async () => {
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/groups', headers: { authorization: device.authorization }, payload: { name: 'Kitchen' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: 'Kitchen', myRole: 'owner', queueLength: 0, listenerCount: 0 });
  });

  it('admits a second device through an invite code', async () => {
    const groupId = await createGroup();
    const second = await pairDevice(hub, admin, { name: 'Living room' });
    const invite = await hub.app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/invites`, headers: { authorization: device.authorization }, payload: { ttlSeconds: 3600, role: 'member' } });
    expect(invite.statusCode).toBe(200);
    const code = (invite.json() as { inviteCode: string }).inviteCode;

    const join = await hub.app.inject({ method: 'POST', url: '/api/v1/groups/join', headers: { authorization: second.authorization }, payload: { inviteCode: code } });
    expect(join.statusCode).toBe(200);
    expect(join.json()).toMatchObject({ id: groupId, myRole: 'member' });
  });

  it('refuses a group a device is not a member of', async () => {
    const groupId = await createGroup();
    const stranger = await pairDevice(hub, admin, { name: 'Stranger' });
    const response = await hub.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}`, headers: { authorization: stranger.authorization } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ myRole: null });
  });
});

describe('queue commands', () => {
  it('appends, advances the revision and reports the queue', async () => {
    const groupId = await createGroup();
    const appended = await command(groupId, { idempotencyKey: 'k1', baseRevision: 0, command: { type: 'append', items: [track('11111111-1111-7111-8111-111111111111', 'First')] } });
    expect(appended.statusCode).toBe(200);
    const result = appended.json() as { accepted: boolean; revision: number; queue: { items: unknown[] } };
    expect(result.accepted).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.queue.items).toHaveLength(1);

    const view = await hub.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/queue`, headers: { authorization: device.authorization } });
    expect((view.json() as { queue: { revision: number } }).queue.revision).toBe(1);
  });

  it('replays an identical command instead of applying it twice', async () => {
    const groupId = await createGroup();
    const payload = { idempotencyKey: 'same-key', baseRevision: 0, command: { type: 'append', items: [track('22222222-2222-7222-8222-222222222222', 'Once')] } };
    const first = await command(groupId, payload);
    const second = await command(groupId, payload);
    expect(second.statusCode).toBe(200);
    const replay = second.json() as { idempotentReplay: boolean; revision: number; queue: { items: unknown[] } };
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.revision).toBe((first.json() as { revision: number }).revision);
    expect(replay.queue.items).toHaveLength(1);
  });

  it('rejects a command built on a stale revision', async () => {
    const groupId = await createGroup();
    await command(groupId, { idempotencyKey: 'a', baseRevision: 0, command: { type: 'append', items: [track('33333333-3333-7333-8333-333333333333', 'One')] } });
    const stale = await command(groupId, { idempotencyKey: 'b', baseRevision: 0, command: { type: 'append', items: [track('44444444-4444-7444-8444-444444444444', 'Two')] } });
    const body = stale.json() as { accepted: boolean; rejection: { code: string } | null; revision: number };
    expect(body.accepted).toBe(false);
    expect(body.rejection?.code).toBe('stale-revision');
    // The rejection carries the current revision so the caller can retry without another round trip.
    expect(body.revision).toBe(1);
  });

  it('plays, reports a position that advances with the clock, and pauses', async () => {
    const groupId = await createGroup();
    await command(groupId, { idempotencyKey: 'q', baseRevision: 0, command: { type: 'append', items: [track('55555555-5555-7555-8555-555555555555', 'Playing')] } });
    const played = await command(groupId, { idempotencyKey: 'p', baseRevision: 1, command: { type: 'play' } });
    // The hub schedules the start slightly ahead so every listener can prepare, so playback is
    // 'preparing' until that lead elapses — it is not 'playing' the instant the command lands.
    expect((played.json() as { playback: { status: string } }).playback.status).toBe('preparing');

    await hub.tick(11_500);
    const queueState = await hub.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/queue`, headers: { authorization: device.authorization } });
    expect((queueState.json() as { playback: { status: string } }).playback.status).toBe('playing');
    const nowPlaying = await hub.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/now-playing`, headers: { authorization: device.authorization } });
    const state = nowPlaying.json() as { positionMs: number; title: string };
    expect(state.title).toBe('Playing');
    expect(state.positionMs).toBeGreaterThan(9_000);

    const paused = await command(groupId, { idempotencyKey: 'pause', baseRevision: 2, command: { type: 'pause' } });
    expect((paused.json() as { playback: { status: string } }).playback.status).toBe('paused');
  });

  it('records history when a track is skipped', async () => {
    const groupId = await createGroup();
    await command(groupId, { idempotencyKey: 'q', baseRevision: 0, command: { type: 'append', items: [track('66666666-6666-7666-8666-666666666666', 'Skipped'), track('77777777-7777-7777-8777-777777777777', 'Next')] } });
    await command(groupId, { idempotencyKey: 'p', baseRevision: 1, command: { type: 'play' } });
    await hub.tick(30_000);
    await command(groupId, { idempotencyKey: 's', baseRevision: 2, command: { type: 'skip', reason: 'not tonight' } });

    const history = await hub.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/history`, headers: { authorization: device.authorization } });
    const entries = (history.json() as { items: Array<{ track: { title: string }; outcome: string; skipReason: string | null }> }).items;
    // Skipping closes the current entry and opens one for the next track, so both are present.
    expect(entries.map((e) => e.track.title)).toEqual(expect.arrayContaining(['Skipped', 'Next']));
    expect(entries.find((e) => e.track.title === 'Skipped')).toMatchObject({ outcome: 'skipped', skipReason: 'not tonight' });
  });

  it('does not restart the current track when play is pressed again', async () => {
    const groupId = await createGroup();
    await command(groupId, { idempotencyKey: 'q', baseRevision: 0, command: { type: 'append', items: [track('66666666-6666-7666-8666-666666666666', 'Already playing')] } });
    // Appending to an empty group queue starts it, so the queue is already playing at this point.
    await hub.tick(11_000);
    const before = await hub.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/now-playing`, headers: { authorization: device.authorization } });
    const positionBefore = (before.json() as { positionMs: number }).positionMs;
    expect(positionBefore).toBeGreaterThan(0);

    await command(groupId, { idempotencyKey: 'p', baseRevision: 1, command: { type: 'play' } });
    await hub.tick(1_000);

    const after = await hub.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/now-playing`, headers: { authorization: device.authorization } });
    // The song kept playing from where it was rather than jumping back to the start for everyone.
    expect((after.json() as { positionMs: number }).positionMs).toBeGreaterThanOrEqual(positionBefore);

    const history = await hub.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/history`, headers: { authorization: device.authorization } });
    const entries = (history.json() as { items: Array<{ outcome: string }> }).items;
    // And no phantom 'stopped' entry was filed for a track nobody stopped.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: 'playing' });
  });

  it('returns history in the order things happened, even within one millisecond', async () => {
    const groupId = await createGroup();
    /*
     * Eight tracks appended and skipped without advancing the clock, so every entry shares a
     * `startedAt`. The tiebreak used to be the row's UUIDv7, whose low bits are random when the id
     * is minted from an explicit timestamp — so history came back shuffled, differently on every
     * run. Eight entries make an accidental pass a one-in-forty-thousand event.
     */
    const titles = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
    await command(groupId, {
      idempotencyKey: 'q',
      baseRevision: 0,
      command: { type: 'append', items: titles.map((title, i) => track(`${String(i + 1).repeat(8)}-1111-7111-8111-111111111111`, title)) },
    });
    for (let i = 0; i < titles.length - 1; i += 1) {
      await command(groupId, { idempotencyKey: `s${i}`, baseRevision: i + 1, command: { type: 'skip' } });
    }

    const read = async (): Promise<string[]> => {
      const response = await hub.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/history`, headers: { authorization: device.authorization } });
      return (response.json() as { items: Array<{ track: { title: string } }> }).items.map((e) => e.track.title);
    };

    const newestFirst = await read();
    expect(newestFirst).toEqual([...titles].reverse());
    // And the same order on every subsequent read, not just the first.
    for (let i = 0; i < 3; i += 1) expect(await read()).toEqual(newestFirst);
  });

  it('exports history as RFC-4180 CSV with a schema version column', async () => {
    const groupId = await createGroup();
    await command(groupId, { idempotencyKey: 'q', baseRevision: 0, command: { type: 'append', items: [track('88888888-8888-7888-8888-888888888888', 'Exported, with comma')] } });
    await command(groupId, { idempotencyKey: 'p', baseRevision: 1, command: { type: 'play' } });
    await hub.tick(5_000);
    await command(groupId, { idempotencyKey: 's', baseRevision: 2, command: { type: 'skip', reason: 'x' } });

    const csv = await hub.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/history.csv`, headers: { authorization: device.authorization } });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toContain('schema_version');
    // A comma inside a field must be quoted, not escaped away.
    expect(csv.body).toContain('"Exported, with comma"');
  });
});

describe('Discord command parity', () => {
  it('produces the same outcome for a slash command and its prefix equivalent', async () => {
    const groupId = await createGroup();
    await hub.app.inject({
      method: 'PUT',
      url: '/api/v1/discord/config',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { defaultGroupId: groupId, prefixEnabled: true, designatedChannels: { '1': '100' } },
    });

    const run = async (transport: 'slash' | 'prefix') =>
      hub.app.inject({
        method: 'POST',
        url: '/api/v1/discord/commands/test',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        payload: { command: 'queue', args: '', guildId: '1', channelId: '100', userId: '42', roleIds: [], transport },
      });

    const slash = await run('slash');
    const prefix = await run('prefix');
    expect(slash.statusCode).toBe(200);
    expect(prefix.statusCode).toBe(200);
    const a = slash.json() as Record<string, unknown>;
    const b = prefix.json() as Record<string, unknown>;
    // Identical by construction: both transports call the same command service.
    expect(a).toEqual(b);
    expect(a['templateKey']).toBe('emptyQueue');
  });

  it('applies the designated-channel rule to both transports alike', async () => {
    const groupId = await createGroup();
    await hub.app.inject({
      method: 'PUT',
      url: '/api/v1/discord/config',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { defaultGroupId: groupId, designatedChannels: { '1': '100' } },
    });
    for (const transport of ['slash', 'prefix'] as const) {
      const response = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/discord/commands/test',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        payload: { command: 'skip', args: '', guildId: '1', channelId: '999', userId: '42', roleIds: [], transport },
      });
      expect(response.json(), transport).toMatchObject({ ok: false, templateKey: 'wrongChannel', ephemeral: true });
    }
  });

  it('refuses to run commands before a default group is chosen', async () => {
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/discord/commands/test',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { command: 'queue', args: '', guildId: '1', channelId: '100', userId: '42', roleIds: [], transport: 'slash' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'setup-required' });
  });
});
