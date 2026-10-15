import { describe, expect, it } from 'vitest';
import { SavedCatalogItem, SavedCatalogItemList, SavedCollection, SavedTrack } from '../src/api/catalog.js';

const collection = SavedCollection.parse({
  ref: { platform: 'deezer', kind: 'album', id: '7', url: 'https://www.deezer.com/album/7', title: 'Tide', owner: null },
  savedAt: '2026-10-14T10:00:00.000Z',
});
const song = {
  kind: 'track',
  identityKey: 'isrc:GBAAA1900001',
  savedAt: '2026-10-14T10:01:00.000Z',
  track: {
    id: 'deezer:42',
    title: 'Harbour Lights',
    artist: 'North Quay',
    sources: [{ platform: 'deezer', id: '42', url: 'https://www.deezer.com/track/42', previewUrl: null }],
    absolutePath: 'C:/Music/private.mp3',
    audioBytes: 'not allowed',
  },
};

describe('shared saved catalog contract', () => {
  it('accepts song snapshots and strips file locators and audio bytes', () => {
    const parsed = SavedCatalogItem.parse(song);
    expect(parsed).toMatchObject({ kind: 'track', identityKey: 'isrc:GBAAA1900001' });
    expect(JSON.stringify(parsed)).not.toContain('private.mp3');
    expect(JSON.stringify(parsed)).not.toContain('audioBytes');
  });

  it('accepts a hash-identified local song without transmitting a file locator or media bytes', () => {
    const local = SavedTrack.parse({
      kind: 'track',
      identityKey: `sha256:${'a'.repeat(64)}`,
      savedAt: '2026-10-14T10:02:00.000Z',
      track: { id: 'local:1', title: 'Quiet Harbour', artist: 'North Quay', contentHash: 'a'.repeat(64), sources: [], absolutePath: 'D:/Music/private.flac', audioBytes: 'hidden' },
    });
    expect(local.track).toMatchObject({ title: 'Quiet Harbour', contentHash: 'a'.repeat(64) });
    expect(JSON.stringify(local)).not.toContain('private.flac');
    expect(JSON.stringify(local)).not.toContain('audioBytes');
  });

  it('rejects filesystem URLs and oversized provider-ID arrays from shared metadata', () => {
    expect(() => SavedCollection.parse({ ...collection, ref: { ...collection.ref, url: 'file:///C:/Music/private.m3u8' } })).toThrow();
    expect(() => SavedCollection.parse({ ...collection, covers: ['file:///C:/Music/private.jpg'] })).toThrow();
    expect(() => SavedTrack.parse({
      ...song,
      track: { ...song.track, sources: [{ platform: 'deezer', id: '42', url: 'file:///C:/Music/private.flac', previewUrl: null }] },
    })).toThrow();
    expect(() => SavedTrack.parse({
      ...song,
      track: { ...song.track, providerIds: { deezer: Array.from({ length: 21 }, (_, i) => String(i)) } },
    })).toThrow();
  });

  it('keeps existing saved albums and playlists readable in the shared list', () => {
    const list = SavedCatalogItemList.parse({ items: [collection, song], tombstones: [] });
    expect(list.items.map((item) => 'kind' in item ? item.kind : item.ref.kind)).toEqual(['album', 'track']);
  });
});
