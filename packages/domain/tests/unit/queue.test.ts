import { describe, expect, it } from 'vitest';
import type { TrackRef } from '@now-playing/contracts';
import { applyQueueCommand, createQueue, currentItem, fairOrder, queueFingerprint, type QueueActor } from '../../src/queue.js';

const NOW = '2026-09-03T12:00:00.000Z';
function ref(n: number, extra: Partial<TrackRef> = {}): TrackRef {
  return { trackId: `0192b1f0-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`, title: `Track ${n}`, artistName: 'Artist', albumName: null, durationMs: 180_000, artworkId: null, identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} }, locators: [], provider: 'local', genre: null, year: null, ...extra };
}
const alice = { id: 'alice', kind: 'device' as const, displayName: 'Alice' };
const bob = { id: 'bob', kind: 'device' as const, displayName: 'Bob' };
const ctx = (actor: QueueActor = alice, extra: Record<string, unknown> = {}) => ({ now: NOW, actor, ...extra });

describe('queue reducer', () => {
  it('appends and auto-plays in group mode', () => {
    const q = createQueue({ mode: 'group', now: NOW });
    const r = applyQueueCommand(q, { type: 'append', items: [ref(1), ref(2)] }, ctx());
    expect(r.accepted).toBe(true);
    expect(r.queue.revision).toBe(1);
    expect(r.queue.currentIndex).toBe(0);
    expect(r.effects[0]).toMatchObject({ type: 'play' });
  });
  it('does not auto-play in solo mode', () => {
    const q = createQueue({ mode: 'solo', now: NOW });
    const r = applyQueueCommand(q, { type: 'append', items: [ref(1)] }, ctx());
    expect(r.queue.currentIndex).toBe(-1);
    expect(r.effects).toHaveLength(0);
  });
  it('enforces limits, duplicates, cooldown and duration', () => {
    let q = createQueue({ mode: 'group', now: NOW });
    q = applyQueueCommand(q, { type: 'append', items: [ref(1)] }, ctx()).queue;
    const dup = applyQueueCommand(q, { type: 'append', items: [ref(1)] }, ctx(alice, { limits: { duplicatePolicy: 'reject-in-queue' } }));
    expect(dup.rejection?.code).toBe('duplicate');
    const limit = applyQueueCommand(q, { type: 'append', items: [ref(2), ref(3)] }, ctx(alice, { limits: { maxQueuePerUser: 1 } }));
    expect(limit.rejection?.code).toBe('limit');
    const cool = applyQueueCommand(q, { type: 'append', items: [ref(2)] }, ctx({ ...alice, lastRequestAt: NOW }, { limits: { cooldownSeconds: 30 } }));
    expect(cool.rejection?.code).toBe('cooldown');
    const long = applyQueueCommand(q, { type: 'append', items: [ref(2, { durationMs: 99_999_999 })] }, ctx(alice, { limits: { maxTrackDurationMs: 1000 } }));
    expect(long.rejection?.code).toBe('limit');
  });
  it('reorders and keeps the current index pointing at the same item', () => {
    let q = createQueue({ mode: 'group', now: NOW });
    q = applyQueueCommand(q, { type: 'append', items: [ref(1), ref(2), ref(3)] }, ctx()).queue;
    const current = currentItem(q)!;
    const third = q.items[2]!;
    q = applyQueueCommand(q, { type: 'reorder', itemId: third.id, toIndex: 0 }, ctx()).queue;
    expect(q.items[0]!.id).toBe(third.id);
    expect(currentItem(q)!.id).toBe(current.id);
    expect(q.currentIndex).toBe(1);
  });
  it('skip advances, repeat all wraps, ended without repeat', () => {
    let q = createQueue({ mode: 'group', now: NOW });
    q = applyQueueCommand(q, { type: 'append', items: [ref(1), ref(2)] }, ctx()).queue;
    q = applyQueueCommand(q, { type: 'skip' }, ctx()).queue;
    expect(q.currentIndex).toBe(1);
    const ended = applyQueueCommand(q, { type: 'advance', reason: 'ended' }, ctx());
    expect(ended.queue.currentIndex).toBe(-1);
    expect(ended.effects[0]).toMatchObject({ type: 'ended' });
    q = applyQueueCommand(q, { type: 'setRepeat', repeat: 'all' }, ctx()).queue;
    const wrapped = applyQueueCommand(q, { type: 'advance', reason: 'ended' }, ctx());
    expect(wrapped.queue.currentIndex).toBe(0);
    q = applyQueueCommand(q, { type: 'setRepeat', repeat: 'one' }, ctx()).queue;
    const one = applyQueueCommand(q, { type: 'advance', reason: 'ended' }, ctx());
    expect(one.queue.currentIndex).toBe(q.currentIndex);
  });
  it('vote skip reaches threshold', () => {
    let q = createQueue({ mode: 'group', now: NOW });
    q = applyQueueCommand(q, { type: 'append', items: [ref(1), ref(2)] }, ctx()).queue;
    const v1 = applyQueueCommand(q, { type: 'voteSkip' }, ctx(alice, { listenerCount: 4, voteSkipThreshold: 0.5 }));
    expect(v1.effects[0]).toMatchObject({ type: 'voteRecorded', votes: 1, needed: 2 });
    const again = applyQueueCommand(v1.queue, { type: 'voteSkip' }, ctx(alice, { listenerCount: 4, voteSkipThreshold: 0.5 }));
    expect(again.rejection?.code).toBe('duplicate');
    const v2 = applyQueueCommand(v1.queue, { type: 'voteSkip' }, ctx(bob, { listenerCount: 4, voteSkipThreshold: 0.5 }));
    expect(v2.effects[0]).toMatchObject({ type: 'skipped', reason: 'vote' });
    expect(v2.queue.currentIndex).toBe(1);
  });
  it('fair queue round-robins requesters without destroying per-requester order', () => {
    let q = createQueue({ mode: 'group', now: NOW });
    q = applyQueueCommand(q, { type: 'append', items: [ref(1), ref(2), ref(3)] }, ctx(alice)).queue;
    q = applyQueueCommand(q, { type: 'append', items: [ref(4), ref(5)] }, ctx(bob)).queue;
    const ordered = fairOrder(q.items, 1);
    expect(ordered.map((i) => i.track.title)).toEqual(['Track 1', 'Track 2', 'Track 4', 'Track 3', 'Track 5']);
    const enabled = applyQueueCommand(q, { type: 'setFairQueue', enabled: true }, ctx()).queue;
    expect(enabled.items.map((i) => i.track.title)).toEqual(['Track 1', 'Track 2', 'Track 4', 'Track 3', 'Track 5']);
  });
  it('remove of current item plays the next; shuffle is seeded and stable', () => {
    let q = createQueue({ mode: 'group', now: NOW });
    q = applyQueueCommand(q, { type: 'append', items: [ref(1), ref(2), ref(3)] }, ctx()).queue;
    const r = applyQueueCommand(q, { type: 'remove', itemId: q.items[0]!.id }, ctx());
    expect(r.effects[0]).toMatchObject({ type: 'play' });
    expect(r.queue.items).toHaveLength(2);
    const s1 = applyQueueCommand(q, { type: 'shuffle', seed: 7 }, ctx()).queue;
    const s2 = applyQueueCommand(q, { type: 'shuffle', seed: 7 }, ctx()).queue;
    expect(queueFingerprint(s1)).toBe(queueFingerprint(s2));
    expect(s1.items[0]!.id).toBe(q.items[0]!.id);
  });
  it('previous restarts after 3s, otherwise steps back', () => {
    let q = createQueue({ mode: 'solo', now: NOW });
    q = applyQueueCommand(q, { type: 'append', items: [ref(1), ref(2)] }, ctx()).queue;
    q = applyQueueCommand(q, { type: 'jump', itemId: q.items[1]!.id }, ctx()).queue;
    q = applyQueueCommand(q, { type: 'seek', positionMs: 10_000 }, ctx()).queue;
    const restart = applyQueueCommand(q, { type: 'previous' }, ctx());
    expect(restart.queue.currentIndex).toBe(1);
    expect(restart.queue.positionMs).toBe(0);
    const back = applyQueueCommand(restart.queue, { type: 'previous' }, ctx());
    expect(back.queue.currentIndex).toBe(0);
  });
});
