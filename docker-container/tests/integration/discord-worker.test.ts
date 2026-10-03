/**
 * The Discord worker is a second process over the hub's database. These tests build both on one
 * data directory — two connections, like the two containers — and check what crosses between them:
 * queue changes reach the hub's realtime clients, the admin GUI sees the worker, and its buttons
 * reach it.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscordStatus, Envelope } from '@now-playing/contracts';
import { buildApp, type HubApp } from '../../src/app.js';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

const FIXTURES = fileURLToPath(new URL('../../../packages/test-fixtures/generated/audio', import.meta.url));
const META = { ip: null, userAgent: null, correlationId: null };
const ADMIN = { id: 'admin', displayName: 'Admin' };

let hub: TestHub;
let worker: HubApp;
let groupId: string;

beforeEach(async () => {
  hub = await createTestHub({ config: { publicDomainDir: FIXTURES } });
  const admin = await hub.completeSetup();
  await hub.ctx.library.scanAll();
  const device = await pairDevice(hub, admin);
  const group = await hub.app.inject({ method: 'POST', url: '/api/v1/groups', headers: { authorization: device.authorization }, payload: { name: 'Voice' } });
  groupId = (group.json() as { id: string }).id;
  hub.ctx.discord.updateConfiguration({ defaultGroupId: groupId, djRoleIds: ['dj'] }, ADMIN, META);
  worker = await buildApp({ ...hub.ctx.deps, processRole: 'discord-worker' });
});

afterEach(async () => {
  await worker.close();
  await hub.dispose();
});

const play = (query: string) => worker.ctx.discord.runCommand({ command: 'play', args: query, guildId: '111', channelId: '222', userId: '333', roleIds: [], transport: 'slash' });
const stop = () => worker.ctx.discord.runCommand({ command: 'stop', args: '', guildId: '111', channelId: '222', userId: '333', roleIds: ['dj'], transport: 'slash' });

describe('discord worker alongside the hub', () => {
  it('relays queue changes the worker makes to the hub’s realtime clients', async () => {
    const seen: Envelope[] = [];
    hub.ctx.realtime.subscribe((envelope) => seen.push(envelope));
    hub.ctx.groups.startExternalRelay(60_000);
    hub.ctx.groups.relayExternalEvents();

    const result = await play('Signal Fade');
    expect(result).toMatchObject({ ok: true, templateKey: 'queued' });
    expect(seen).toHaveLength(0);

    expect(hub.ctx.groups.relayExternalEvents()).toBeGreaterThan(0);
    expect(seen.map((e) => e.type)).toContain('group.queue.updated');
    // Relayed once, not again on the next tick.
    expect(hub.ctx.groups.relayExternalEvents()).toBe(0);
  });

  it('does not relay events the hub published itself', async () => {
    const seen: Envelope[] = [];
    hub.ctx.realtime.subscribe((envelope) => seen.push(envelope));
    hub.ctx.groups.startExternalRelay(60_000);
    hub.ctx.groups.relayExternalEvents();
    await hub.ctx.discord.runCommand({ command: 'play', args: 'Signal Fade', guildId: '111', channelId: '222', userId: '333', roleIds: [], transport: 'slash' });
    const direct = seen.length;
    expect(direct).toBeGreaterThan(0);
    expect(hub.ctx.groups.relayExternalEvents()).toBe(0);
    expect(seen).toHaveLength(direct);
  });

  it('starts the new track when something is requested after stop', async () => {
    await play('Signal Fade');
    expect(await stop()).toMatchObject({ ok: true, templateKey: 'stopped' });
    expect(worker.ctx.groups.state(groupId).playback.status).toBe('idle');

    await play('Harbour Lights');
    const { queue, playback } = worker.ctx.groups.state(groupId);
    const current = queue.items.find((i) => i.id === playback.currentItemId);
    expect(playback.status).toBe('preparing');
    expect(current?.track.title).toBe('Harbour Lights');
  });

  it('plays a request made after the queue ran out, not the first track again', async () => {
    await play('Signal Fade');
    const { queue } = worker.ctx.groups.state(groupId);
    worker.ctx.groups.applyCommand(groupId, { id: 'system', kind: 'system', displayName: 'Hub', isHubAdmin: true }, { idempotencyKey: 'end', baseRevision: queue.revision, command: { type: 'advance', reason: 'ended' } });
    expect(worker.ctx.groups.state(groupId).playback.status).toBe('ended');

    await play('Harbour Lights');
    const after = worker.ctx.groups.state(groupId);
    expect(after.queue.items.find((i) => i.id === after.playback.currentItemId)?.track.title).toBe('Harbour Lights');
  });

  it('shows the worker’s live status in the hub', () => {
    expect(hub.ctx.discord.status().warnings.join(' ')).toContain('Discord service isn’t running');
    const live: DiscordStatus = { ...hub.ctx.discord.status(), gateway: 'connected', voice: 'playing', currentVoiceChannelId: '222', currentTrackTitle: 'Signal Fade', warnings: [] };
    worker.ctx.discord.publishWorkerStatus(live);
    const seen = hub.ctx.discord.status();
    expect(seen).toMatchObject({ gateway: 'connected', voice: 'playing', currentTrackTitle: 'Signal Fade' });
    expect(seen.warnings.join(' ')).not.toContain('Discord service isn’t running');

    hub.clock.advance(60_000);
    expect(hub.ctx.discord.status().gateway).toBe('stopped');
  });

  it('hands admin actions to the worker and reports its answer', async () => {
    hub.ctx.repos.settings.set('discord.token', hub.ctx.sealer.seal('x'.repeat(59), 'discord:token'), new Date().toISOString());
    await expect(hub.ctx.discord.act('stop', ADMIN, META)).rejects.toThrow(/Discord service isn’t running/);

    worker.ctx.discord.publishWorkerStatus(hub.ctx.discord.status());
    const pending = hub.ctx.discord.act('stop', ADMIN, META);
    let request = null;
    for (let i = 0; i < 40 && !request; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      request = worker.ctx.discord.pendingControlRequest(null, 0);
    }
    expect(request?.action).toBe('stop');
    worker.ctx.discord.completeControlRequest(request!.id, null);
    await expect(pending).resolves.toMatchObject({ configured: true });
    expect(worker.ctx.discord.pendingControlRequest(request!.id, 0)).toBeNull();

    const failing = hub.ctx.discord.act('register-commands', ADMIN, META);
    let second = null;
    for (let i = 0; i < 40 && !second; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      second = worker.ctx.discord.pendingControlRequest(request!.id, 0);
    }
    worker.ctx.discord.completeControlRequest(second!.id, 'Discord said no');
    await expect(failing).rejects.toThrow('Discord said no');
  });
});
