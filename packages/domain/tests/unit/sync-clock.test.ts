import { describe, expect, it } from 'vitest';
import type { SyncChange } from '@now-playing/contracts';
import { changesSince, collectionsNeedingSync, mergeChange, summarize, tombstonesToCompact } from '../../src/sync.js';
import { decideDriftCorrection, estimateClock, expectedPosition, reconnectDelayMs, sampleOffset } from '../../src/clock.js';

const change = (over: Partial<SyncChange>): SyncChange => ({ collection: 'playlists', id: '0192b1f0-0000-7000-8000-000000000001', updatedAt: '2026-09-03T12:00:00.000Z', deleted: false, body: { name: 'x' }, changeId: '0192b1f0-0000-7000-8000-00000000c001', ...over });

describe('sync merge rules', () => {
  it('applies new, skips duplicates, LWW, tombstone-wins', () => {
    const c = change({});
    expect(mergeChange(undefined, c, new Set()).action).toBe('apply');
    expect(mergeChange(undefined, c, new Set([c.changeId])).action).toBe('skip');
    const local = { id: c.id, updatedAt: '2026-09-03T13:00:00.000Z', deletedAt: null, name: 'newer' };
    expect(mergeChange(local, c, new Set())).toMatchObject({ action: 'conflict', conflict: { resolution: 'kept-local' } });
    const remoteDelete = change({ deleted: true, body: null, updatedAt: '2026-09-03T14:00:00.000Z' });
    expect(mergeChange(local, remoteDelete, new Set())).toMatchObject({ action: 'apply', record: { deletedAt: '2026-09-03T14:00:00.000Z' } });
    const olderDelete = change({ deleted: true, body: null, updatedAt: '2026-09-03T12:30:00.000Z' });
    expect(mergeChange(local, olderDelete, new Set())).toMatchObject({ action: 'conflict', conflict: { resolution: 'kept-local' } });
    const tomb = { id: c.id, updatedAt: '2026-09-03T15:00:00.000Z', deletedAt: '2026-09-03T15:00:00.000Z' };
    expect(mergeChange(tomb, c, new Set())).toMatchObject({ action: 'conflict', conflict: { resolution: 'tombstone-wins' } });
  });
  it('summaries, digests, deltas and compaction', async () => {
    const records = [{ id: '0192b1f0-0000-7000-8000-000000000001', updatedAt: '2026-09-01T00:00:00.000Z', deletedAt: null, name: 'a' }, { id: '0192b1f0-0000-7000-8000-000000000002', updatedAt: '2026-09-02T00:00:00.000Z', deletedAt: '2026-09-02T00:00:00.000Z' }];
    const s1 = await summarize('playlists', records);
    const s2 = await summarize('playlists', [...records].reverse());
    expect(s1.digest).toBe(s2.digest);
    expect(collectionsNeedingSync([s1], [{ ...s1, digest: 'x'.repeat(64) }])).toEqual(['playlists']);
    const delta = changesSince('playlists', records, '2026-09-01T12:00:00.000Z', 10, (r) => `${r.id}:${r.updatedAt}`);
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]!.deleted).toBe(true);
    const compact = tombstonesToCompact(records, ['2026-09-10T00:00:00.000Z'], 1, Date.parse('2026-09-20T00:00:00.000Z'));
    expect(compact).toEqual(['0192b1f0-0000-7000-8000-000000000002']);
    expect(tombstonesToCompact(records, [null], 1, Date.parse('2026-09-20T00:00:00.000Z'))).toEqual([]);
  });
});

describe('clock', () => {
  it('estimates offset with NTP formula and median of best samples', () => {
    expect(sampleOffset({ t0: 0, t1: 105, t2: 106, t3: 12 })).toEqual({ offsetMs: 99.5, rttMs: 11 });
    const est = estimateClock([{ t0: 0, t1: 105, t2: 106, t3: 12 }, { t0: 100, t1: 300, t2: 301, t3: 400 }, { t0: 200, t1: 305, t2: 306, t3: 212 }]);
    expect(est!.offsetMs).toBeCloseTo(99.5, 1);
    expect(est!.rttMs).toBe(11);
  });
  it('drift policy', () => {
    expect(decideDriftCorrection(20, 1000, { softMs: 60, hardMs: 400 })).toEqual({ kind: 'none' });
    expect(decideDriftCorrection(200, 1000, { softMs: 60, hardMs: 400 })).toMatchObject({ kind: 'nudge', playbackRate: 0.97 });
    expect(decideDriftCorrection(-500, 1000, { softMs: 60, hardMs: 400 })).toEqual({ kind: 'seek', toPositionMs: 1000 });
    expect(expectedPosition(1000, 5000, null, 100)).toBe(3900);
    expect(expectedPosition(1000, 5000, { at: 3000, positionMs: 1500 })).toBe(1500);
    expect(reconnectDelayMs(0, 500, 30000, () => 0)).toBe(250);
    expect(reconnectDelayMs(20, 500, 30000, () => 1)).toBe(30000);
  });
});
