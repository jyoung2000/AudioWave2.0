import { describe, expect, it } from 'vitest';
import { SavedTrack, type SavedCatalogItem, type SavedCatalogItemList, type SavedCatalogItemRef } from '@now-playing/contracts';
import { CompanionCatalog, type CatalogStore } from '../../src/main/catalog.js';

const song: SavedCatalogItem = SavedTrack.parse({
  kind: 'track',
  identityKey: 'isrc:GBAAA1900001',
  savedAt: '2026-10-14T10:00:00.000Z',
  track: { id: 'local:42', title: 'Harbour Lights', artist: 'North Quay', isrc: 'GBAAA1900001', sources: [] },
});
const album: SavedCatalogItem = {
  ref: { platform: 'deezer', kind: 'album', id: '9', url: 'https://www.deezer.com/album/9', title: 'Tide', owner: null },
  savedAt: '2026-10-14T09:00:00.000Z', artworkUrl: null, covers: [], trackCount: 8,
};

class MemoryStore implements CatalogStore {
  values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T { return (this.values.get(key) as T | undefined) ?? fallback; }
  set(key: string, value: unknown): void { this.values.set(key, value); }
}

const list = (items: SavedCatalogItem[], tombstones: SavedCatalogItemList['tombstones'] = []): SavedCatalogItemList => ({ items, tombstones, shared: [] });

describe('companion shared catalog stars', () => {
  it('publishes companion stars to the paired Hub and incorporates items starred elsewhere', async () => {
    let remote = list([album]);
    const puts: SavedCatalogItem[] = [];
    const catalog = new CompanionCatalog({
      helper: () => ({ origin: null, token: null, reason: null }), store: new MemoryStore(), send: () => undefined,
      sharedCatalog: {
        list: async () => remote,
        put: async (item) => { puts.push(item); remote = list([...remote.items.filter((x) => savedKey(x) !== savedKey(item)), item]); return remote; },
        remove: async (_ref, at) => { remote = list(remote.items, [{ key: 'collection:deezer:album:9', at }]); return remote; },
      },
      now: () => new Date('2026-10-14T10:00:00.000Z'),
    });

    const answer = await catalog.save(song);
    expect(puts.map(savedKey)).toEqual([savedKey(song)]);
    expect(answer.items).toHaveLength(2);
    expect(answer.items.map(savedKey).sort()).toEqual([savedKey(album), savedKey(song)].sort());
  });

  it('retains an offline un-star tombstone and retries the Hub delete on the next successful sync', async () => {
    let online = false;
    const deleted: Array<{ ref: SavedCatalogItemRef; at: string }> = [];
    const catalog = new CompanionCatalog({
      helper: () => ({ origin: null, token: null, reason: null }), store: new MemoryStore(), send: () => undefined,
      sharedCatalog: {
        list: async () => { if (!online) throw new Error('offline'); return list([album]); },
        put: async () => list([album]),
        remove: async (ref, at) => { deleted.push({ ref, at }); return list([], [{ key: 'collection:deezer:album:9', at }]); },
      },
      now: () => new Date('2026-10-14T11:00:00.000Z'),
    });

    await catalog.unsave({ platform: 'deezer', kind: 'album', id: '9' });
    expect(deleted).toEqual([]);
    online = true;
    await catalog.saved();
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ ref: { platform: 'deezer', kind: 'album', id: '9' }, at: '2026-10-14T11:00:00.000Z' });
  });
});

function savedKey(item: SavedCatalogItem): string {
  return 'kind' in item ? `track:${item.identityKey}` : `collection:${item.ref.platform}:${item.ref.kind}:${item.ref.id}`;
}
