/**
 * Group events are fanned out only after the command's transaction commits. A rolled-back command
 * must broadcast nothing, and the seq numbers it briefly used must not stop the cross-process relay
 * from forwarding another process's event that ends up with the same seq.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import type { GroupActor } from '../../src/group/service.js';
import { createTestHub, type TestHub } from '../helpers/hub.js';

const admin: GroupActor = { id: 'admin', kind: 'admin', displayName: 'Admin', isHubAdmin: true };

let hub: TestHub;
let events: Envelope[];
let groupId: string;

beforeEach(async () => {
  hub = await createTestHub();
  events = [];
  hub.ctx.groups.attachSink({ broadcast: (_groupId, envelope) => events.push(envelope) });
  groupId = hub.ctx.groups.create(admin, { name: 'Commit test' }, { ip: null, correlationId: null }).group.id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await hub.dispose();
});

const setFair = (enabled: boolean, key: string) => hub.ctx.groups.applyCommand(groupId, admin, { idempotencyKey: key, baseRevision: hub.ctx.groups.state(groupId).queue.revision, command: { type: 'setFairQueue', enabled } });

describe('group broadcasts', () => {
  it('broadcasts an accepted command after it commits', () => {
    const outcome = setFair(true, 'ok-1');
    expect(outcome.accepted).toBe(true);
    const updates = events.filter((e) => e.type === 'group.queue.updated');
    expect(updates).toHaveLength(1);
    // What was broadcast is what is stored in the replay ring.
    expect(hub.ctx.groups.eventsAfter(groupId, 0)?.map((e) => e.seq)).toContain(updates[0]!.seq);
  });

  it('broadcasts nothing when the transaction rolls back', () => {
    const revision = hub.ctx.groups.state(groupId).queue.revision;
    vi.spyOn(hub.ctx.repos.groups, 'recordRevision').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => setFair(true, 'fail-1')).toThrow('disk full');
    expect(events).toEqual([]);
    expect(hub.ctx.groups.state(groupId).queue.revision).toBe(revision);
    expect(hub.ctx.groups.eventsAfter(groupId, 0)).toEqual([]);
  });

  it('still relays another process event that reuses a rolled-back seq', () => {
    hub.ctx.groups.startExternalRelay(60 * 60_000);
    // Prime the relay cursor.
    hub.ctx.groups.relayExternalEvents();

    const spy = vi.spyOn(hub.ctx.repos.groups, 'recordRevision').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => setFair(true, 'fail-2')).toThrow('disk full');
    spy.mockRestore();
    expect(events).toEqual([]);

    // The Discord worker writes the next event; it gets the seq the rolled-back publish had used.
    const repo = hub.ctx.repos.groups;
    const seq = repo.nextSeq(groupId);
    repo.appendEvent({ group_id: groupId, seq, event_id: uuidv7(hub.clock.now()), type: 'presence', occurred_at: new Date(hub.clock.now()).toISOString(), actor_id: 'worker', payload: JSON.stringify({ groupId }) }, 500);
    expect(hub.ctx.groups.relayExternalEvents()).toBe(1);
    expect(events.map((e) => e.seq)).toEqual([seq]);

    // Our own committed events are broadcast once, directly, and not relayed a second time.
    events.length = 0;
    expect(setFair(false, 'ok-2').accepted).toBe(true);
    const direct = events.length;
    expect(direct).toBeGreaterThan(0);
    expect(hub.ctx.groups.relayExternalEvents()).toBe(0);
    expect(events).toHaveLength(direct);
  });
});
