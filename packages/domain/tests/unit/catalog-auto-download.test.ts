import { describe, expect, it, vi } from 'vitest';
import { queueResolvedCatalogBatch } from '../../src/catalog/auto-download.js';

type Song = { id: string; title: string };
const songs: Song[] = [
  { id: 'one', title: 'One' },
  { id: 'two', title: 'Two' },
  { id: 'three', title: 'Three' },
];

describe('authorized catalog batch downloads', () => {
  it('resolves every page and preflights every source before queuing any track', async () => {
    const offsets: number[] = [];
    const queued: string[] = [];
    const result = await queueResolvedCatalogBatch(
      async (offset) => {
        offsets.push(offset);
        return offset === 0
          ? { tracks: songs.slice(0, 2), hasMore: true, capped: false }
          : { tracks: songs.slice(2), hasMore: false, capped: false };
      },
      async (song) => `source:${song.id}`,
      async (song, source) => queued.push(`${song.id}:${source}`),
    );

    expect(offsets).toEqual([0, 2]);
    expect(queued).toEqual(['one:source:one', 'two:source:two', 'three:source:three']);
    expect(result.queued).toBe(3);
  });

  it('checks every source against the declared rights basis before queuing any track', async () => {
    const queued: string[] = [];
    const checked: string[] = [];
    await expect(
      queueResolvedCatalogBatch(
        async () => ({ tracks: songs, hasMore: false, capped: false }),
        async (song) => `source:${song.id}`,
        async (song) => { queued.push(song.id); },
        async (items) => {
          checked.push(...items.map(({ track, source }) => `${track.id}:${source}`));
          throw new Error('Three has no source authorized by this rights basis.');
        },
      ),
    ).rejects.toMatchObject({ message: 'Three has no source authorized by this rights basis.', queued: 0 });
    expect(checked).toEqual(['one:source:one', 'two:source:two', 'three:source:three']);
    expect(queued).toEqual([]);
  });

  it('queues nothing when any track has no downloadable source', async () => {
    const queued: string[] = [];
    await expect(
      queueResolvedCatalogBatch(
        async () => ({ tracks: songs, hasMore: false, capped: false }),
        async (song) => song.id === 'two' ? null : `source:${song.id}`,
        async (song) => { queued.push(song.id); },
      ),
    ).rejects.toThrow(/Two.*downloadable source/i);
    expect(queued).toEqual([]);
  });

  it('queues nothing if a later page cannot be resolved or the list is capped', async () => {
    const queue = vi.fn();
    await expect(
      queueResolvedCatalogBatch(
        async (offset) => {
          if (offset === 0) return { tracks: songs.slice(0, 1), hasMore: true, capped: false };
          throw new Error('catalog unavailable');
        },
        async (song) => song.id,
        queue,
      ),
    ).rejects.toThrow('catalog unavailable');
    expect(queue).not.toHaveBeenCalled();

    await expect(
      queueResolvedCatalogBatch(
        async () => ({ tracks: songs, hasMore: false, capped: true }),
        async (song) => song.id,
        queue,
      ),
    ).rejects.toThrow(/too large to download as a complete batch/i);
    expect(queue).not.toHaveBeenCalled();
  });
});
