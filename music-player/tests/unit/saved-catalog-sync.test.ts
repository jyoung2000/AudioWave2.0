import { describe, expect, it } from 'vitest';
import { SavedCatalogItemList, Track as TrackSchema } from '@now-playing/contracts';
import type { SavedCatalogItem, SavedCatalogTombstone } from '@now-playing/contracts';
import type { HubClient } from '../../src/lib/hub-client.js';
import { SavedCatalogSync } from '../../src/lib/saved-catalog-sync.js';
import type { PlayerDatabase } from '../../src/lib/db.js';

function harness() {
  const settings = new Map<string, unknown>();
  const writes: SavedCatalogItem[] = [];
  let items: SavedCatalogItem[] = [];
  let tombstones: SavedCatalogTombstone[] = [];
  const db = {
    async get(_store: string, key: string) { return settings.get(key); },
    async put(_store: string, row: { key: string; value: unknown }) { settings.set(row.key, row); },
  } as unknown as PlayerDatabase;
  const hub = {
    hasScope: (scope: string) => scope === 'library:sync',
    getStatus: () => ({ connected: true, endpoint: 'https://hub.test', hubName: 'Hub', reason: null, identity: null, scopes: ['library:sync'] }),
    subscribe: () => () => undefined,
    savedCatalog: async () => SavedCatalogItemList.parse({ items, tombstones, shared: [] }),
    saveCatalogItem: async (item: SavedCatalogItem) => {
      writes.push(item);
      items = [...items.filter((saved) => !('kind' in saved && 'identityKey' in saved && 'identityKey' in item && saved.identityKey === item.identityKey)), item];
      return SavedCatalogItemList.parse({ items, tombstones, shared: [] });
    },
    deleteCatalogItem: async (ref: { kind: 'track'; identityKey: string }, at?: string) => {
      items = items.filter((saved) => !('kind' in saved && saved.kind === 'track' && saved.identityKey === ref.identityKey));
      tombstones = [{ key: `track:${ref.identityKey}`, at: at ?? new Date().toISOString() }];
      return SavedCatalogItemList.parse({ items, tombstones, shared: [] });
    },
  } as unknown as HubClient;
  return { db, hub, writes, get items() { return items; }, sync: new SavedCatalogSync(db, hub, () => []) };
}

const likedTrack = (liked: boolean) => TrackSchema.parse({
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Harbor Light',
  artistName: 'Ada Moss',
  albumName: 'North',
  liked,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:00:00.000Z',
  identity: { isrc: 'GBAAA1900001', musicbrainzRecordingId: null, contentHash: null, providerIds: {} },
  locators: [{ kind: 'windows-file', deviceId: '00000000-0000-4000-8000-000000000002', fileId: 'C:/Users/test/Music/track.flac' }],
});

describe('PWA local song likes join the shared star set', () => {
  it('sends only the metadata snapshot on a like, and a shared delete on unlike', async () => {
    const h = harness();
    await h.sync.localLikeChanged(likedTrack(true));

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ kind: 'track', identityKey: 'isrc:GBAAA1900001', track: { title: 'Harbor Light', artist: 'Ada Moss' } });
    expect(JSON.stringify(h.writes[0])).not.toContain('C:/Users/test/Music/track.flac');
    expect(JSON.stringify(h.writes[0])).not.toContain('locators');

    await h.sync.localLikeChanged(likedTrack(false));
    expect(h.items).toEqual([]);
  });

  it('keeps a local like available when the device lacks the library:sync permission', async () => {
    const h = harness();
    (h.hub as unknown as { hasScope: (scope: string) => boolean }).hasScope = () => false;
    await h.sync.localLikeChanged(likedTrack(true));
    expect(h.writes).toEqual([]);
  });
});
