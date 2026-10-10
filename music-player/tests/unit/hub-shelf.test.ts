/**
 * The hub's shelf, the pure parts (NP-FIND-008, NP-FIND-013): how this player's starred lists merge
 * with its own copy on the hub, and what a song is when it is filed into a hub playlist.
 */
import { describe, expect, it } from 'vitest';
import type { SavedCollection } from '@now-playing/contracts';
import { mergeSaved, NO_LINK_WHY, savedKey, shelfTrack, type Tombstone } from '../../src/shell/search/hub-shelf.js';

const s = (id: string, savedAt: string, title = id.toUpperCase(), platform: SavedCollection['ref']['platform'] = 'deezer'): SavedCollection => ({
  ref: { platform, kind: 'playlist', id, url: `https://www.deezer.com/playlist/${id}`, title, owner: null },
  savedAt,
  artworkUrl: null,
  covers: [],
  trackCount: 3,
});
const t = (id: string, at: string): Tombstone => ({ platform: 'deezer', kind: 'playlist', id, at });
const ids = (l: readonly SavedCollection[]): string[] => l.map((x) => x.ref.id);

describe('merging starred lists with the hub (NP-FIND-008)', () => {
  it('is a union by platform, kind and id: this player’s own first, then what only the hub had, oldest first', () => {
    const m = mergeSaved([s('a', '2026-10-09T09:00:00Z')], [s('c', '2026-10-09T11:00:00Z'), s('b', '2026-10-09T10:00:00Z')], []);
    expect(ids(m.items)).toEqual(['a', 'b', 'c']);
    expect(ids(m.put)).toEqual(['a']);
    expect(m.del).toEqual([]);
    expect(m.tombstones).toEqual([]);
  });

  it('keeps the later copy of a list both hold, and sends this player’s when it is the newer', () => {
    const newerHere = mergeSaved([s('a', '2026-10-09T12:00:00Z', 'A renamed')], [s('a', '2026-10-09T09:00:00Z')], []);
    expect(newerHere.items[0]!.ref.title).toBe('A renamed');
    expect(ids(newerHere.put)).toEqual(['a']);
    const newerThere = mergeSaved([s('a', '2026-10-09T09:00:00Z')], [s('a', '2026-10-09T12:00:00Z', 'A from the hub')], []);
    expect(newerThere.items[0]!.ref.title).toBe('A from the hub');
    expect(newerThere.put).toEqual([]);
  });

  it('lets an un-star made here (offline) win over the hub’s older copy, and owes the hub a DELETE until it has heard it', () => {
    const m = mergeSaved([], [s('b', '2026-10-09T10:00:00Z')], [t('b', '2026-10-09T11:00:00Z')]);
    expect(m.items).toEqual([]);
    expect(m.del).toEqual([t('b', '2026-10-09T11:00:00Z')]);
    expect(m.tombstones).toEqual([t('b', '2026-10-09T11:00:00Z')]);
  });

  it('lets a star made after the un-star win, and drops the tombstone', () => {
    const m = mergeSaved([], [s('b', '2026-10-09T12:00:00Z')], [t('b', '2026-10-09T11:00:00Z')]);
    expect(ids(m.items)).toEqual(['b']);
    expect(m.del).toEqual([]);
    expect(m.tombstones).toEqual([]);
  });

  it('settles a tombstone the hub no longer has, and keeps the newest of two for one list', () => {
    expect(mergeSaved([], [], [t('x', '2026-10-09T11:00:00Z')]).tombstones).toEqual([]);
    const m = mergeSaved([], [s('b', '2026-10-09T10:30:00Z')], [t('b', '2026-10-09T10:00:00Z'), t('b', '2026-10-09T11:00:00Z')]);
    expect(m.items).toEqual([]);
    expect(m.del).toEqual([t('b', '2026-10-09T11:00:00Z')]);
  });

  it('tells lists apart by platform and kind as well as by id', () => {
    const m = mergeSaved([s('1', '2026-10-09T09:00:00Z', 'Deezer 1')], [s('1', '2026-10-09T09:00:00Z', 'Apple 1', 'apple-music')], []);
    expect(m.items.map((x) => x.ref.title)).toEqual(['Deezer 1', 'Apple 1']);
    expect(savedKey(s('1', 'x').ref)).not.toBe(savedKey(s('1', 'x', '1', 'apple-music').ref));
  });

  it('never repeats a list this player holds twice', () => {
    const m = mergeSaved([s('a', '2026-10-09T09:00:00Z'), s('a', '2026-10-09T09:00:00Z')], [], []);
    expect(ids(m.items)).toEqual(['a']);
  });
});

describe('a song filed into a hub playlist (NP-FIND-013)', () => {
  it('sends a catalog song as it is', () => {
    const cat = { id: 'deezer:1', title: 'One', sources: [{ platform: 'deezer', id: '1', url: 'https://www.deezer.com/track/1', previewUrl: null, matchedBy: 'search' }] } as never;
    expect(shelfTrack({ title: 'One', artist: 'X', cat })).toEqual({ track: cat });
  });

  it('sends a library song by its source link, with its ISRC', () => {
    const r = shelfTrack({ title: 'Quay', artist: 'Alder Quartet', album: 'First Light', duration: 201, isrc: 'gbaaa1900001', link: 'https://www.youtube.com/watch?v=abc' });
    expect('track' in r && r.track).toMatchObject({ title: 'Quay', artist: 'Alder Quartet', album: 'First Light', durationMs: 201_000, isrc: 'GBAAA1900001', sources: [{ platform: 'youtube', url: 'https://www.youtube.com/watch?v=abc', matchedBy: 'link' }] });
  });

  it('sends a library song with only an ISRC as its MusicBrainz ISRC page, so the hub can match it by ISRC', () => {
    const r = shelfTrack({ title: 'Quay', artist: 'Alder Quartet', isrc: 'GBAAA1900001' });
    expect('track' in r && r.track).toMatchObject({ id: 'musicbrainz:isrc:GBAAA1900001', isrc: 'GBAAA1900001', sources: [{ platform: 'musicbrainz', url: 'https://musicbrainz.org/isrc/GBAAA1900001', matchedBy: 'isrc' }] });
  });

  it('says why a song with neither a link nor an ISRC cannot go to the hub (the contract keeps every entry’s link)', () => {
    expect(shelfTrack({ title: 'Quay', artist: 'Alder Quartet', isrc: 'not-an-isrc', url: null })).toEqual({ why: NO_LINK_WHY });
    expect(shelfTrack({ title: 'Quay', artist: 'Alder Quartet', url: 'https://example.com/quay' })).toEqual({ why: NO_LINK_WHY });
  });
});
