import { describe, expect, it } from 'vitest';
import type { SavedCatalogItem, SavedCatalogTombstone } from '@now-playing/contracts';
import { mergeSavedCatalog, savedCatalogKey } from '@now-playing/domain/catalog';

const song = (savedAt: string, title = 'Harbour Lights'): SavedCatalogItem => ({
  kind: 'track',
  identityKey: 'isrc:GBAAA1900001',
  savedAt,
  track: { id: 'deezer:42', title, artist: 'North Quay', sources: [{ platform: 'deezer', id: '42', url: 'https://www.deezer.com/track/42', previewUrl: null }] },
} as SavedCatalogItem);
const tomb = (item: SavedCatalogItem, at: string): SavedCatalogTombstone => ({ key: savedCatalogKey(item), at });

describe('shared star sync conflict resolution', () => {
  it('unions the shared set and lets the newest snapshot win', () => {
    const old = song('2026-10-14T10:00:00.000Z');
    const fresh = song('2026-10-14T11:00:00.000Z', 'Harbour Lights (Remaster)');
    const other: SavedCatalogItem = { ref: { platform: 'deezer', kind: 'album', id: '9', url: 'https://www.deezer.com/album/9', title: 'Tide', owner: null }, savedAt: '2026-10-14T09:00:00.000Z', artworkUrl: null, covers: [], trackCount: 8 };
    const merged = mergeSavedCatalog([old, other], [fresh], [], []);
    expect(merged.items.map((item) => 'kind' in item ? item.track.title : item.ref.title)).toEqual(['Harbour Lights (Remaster)', 'Tide']);
    expect(merged.put).toEqual([other]);
  });

  it('keeps an offline un-star as a tombstone until the hub has applied it', () => {
    const item = song('2026-10-14T10:00:00.000Z');
    const marker = tomb(item, '2026-10-14T11:00:00.000Z');
    const merged = mergeSavedCatalog([], [item], [marker], []);
    expect(merged.items).toEqual([]);
    expect(merged.del).toEqual([marker]);
    expect(merged.tombstones).toEqual([marker]);
  });

  it('sends an offline un-star tombstone even when the hub has not seen the star', () => {
    const item = song('2026-10-14T10:00:00.000Z');
    const marker = tomb(item, '2026-10-14T11:00:00.000Z');
    const merged = mergeSavedCatalog([], [], [marker], []);
    expect(merged.items).toEqual([]);
    expect(merged.del).toEqual([marker]);
    expect(merged.tombstones).toEqual([marker]);
  });

  it('does not resurrect a local copy older than a Hub tombstone, but allows a later star', () => {
    const item = song('2026-10-14T10:00:00.000Z');
    const marker = tomb(item, '2026-10-14T11:00:00.000Z');
    expect(mergeSavedCatalog([item], [], [], [marker]).items).toEqual([]);
    const fresh = song('2026-10-14T12:00:00.000Z');
    expect(mergeSavedCatalog([fresh], [], [], [marker]).items).toEqual([fresh]);
    expect(mergeSavedCatalog([fresh], [], [], [marker]).put).toEqual([fresh]);
  });

  it('settles an old local tombstone when the remote star is newer', () => {
    const item = song('2026-10-14T12:00:00.000Z');
    const marker = tomb(item, '2026-10-14T11:00:00.000Z');
    const merged = mergeSavedCatalog([], [item], [marker], []);
    expect(merged.items).toEqual([item]);
    expect(merged.del).toEqual([]);
    expect(merged.tombstones).toEqual([]);
  });
});
