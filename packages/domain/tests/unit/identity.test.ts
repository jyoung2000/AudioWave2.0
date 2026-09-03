import { describe, expect, it } from 'vitest';
import { artistSortName, dedupeTracks, matchTracks, normalizeText, splitTitleVariants } from '../../src/identity.js';

describe('identity', () => {
  it('normalizes text', () => {
    expect(normalizeText('Björk — “Jóga” (feat. X)')).toBe('bjork joga feat x');
    expect(artistSortName('The Beatles')).toBe('Beatles, The');
  });
  it('splits variants', () => {
    expect(splitTitleVariants('Song Title (Remastered 2011)')).toEqual({ base: 'song title', variants: ['remastered 2011'] });
    expect(splitTitleVariants('Song - Radio Edit')).toEqual({ base: 'song', variants: ['radio edit'] });
    expect(splitTitleVariants('(Just a title)').base).toBe('just a title');
  });
  it('matches by identity before metadata', () => {
    const a = { title: 'A', artistName: 'X', durationMs: 1000, identity: { contentHash: null, quickHash: null, isrc: 'USABC1234567', musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} } };
    const b = { title: 'Totally different', artistName: 'Y', durationMs: 999_000, identity: { ...a.identity } };
    expect(matchTracks(a, b).reason).toBe('isrc');
    const c = { title: 'Blue Train (2019 Remaster)', artistName: 'The Coltranes', durationMs: 640_000 };
    const d = { title: 'Blue Train', artistName: 'Coltranes', durationMs: 641_000 };
    const m = matchTracks(c, d);
    expect(m.reason).toBe('metadata-strong');
    expect(m.sameVariant).toBe(false);
    expect(matchTracks({ title: 'A', artistName: 'B', durationMs: 1000 }, { title: 'C', artistName: 'B', durationMs: 1000 }).confidence).toBe(0);
  });
  it('dedupes confidently matched tracks and keeps different ones', () => {
    const groups = dedupeTracks([
      { title: 'Same', artistName: 'Artist', durationMs: 200_000 },
      { title: 'Same', artistName: 'artist', durationMs: 201_000 },
      { title: 'Other', artistName: 'Artist', durationMs: 200_000 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(2);
  });
});
