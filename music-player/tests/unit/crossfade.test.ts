import { describe, expect, it } from 'vitest';
import type { TrackRef } from '@now-playing/contracts';
import { DEFAULT_CROSSFADE, crossfadeMsBetween, normalizeCrossfade, sameAlbum } from '../../src/lib/crossfade.js';

function track(id: string, artistName: string, albumName: string | null): TrackRef {
  return { trackId: id, title: id, artistName, albumName, durationMs: 200_000, artworkId: null, identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} }, locators: [], provider: 'local', genre: null, year: null };
}

const A1 = track('0192a7c1-2b3d-7e4f-8a9b-000000000001', 'Marlow & the Tidewater', 'Quiet Arithmetic');
const A2 = track('0192a7c1-2b3d-7e4f-8a9b-000000000002', 'marlow & the tidewater ', 'quiet arithmetic');
const B1 = track('0192a7c1-2b3d-7e4f-8a9b-000000000003', 'Fennel Grove', 'Long Wave Sessions, Vol. 2');
const SINGLE = track('0192a7c1-2b3d-7e4f-8a9b-000000000004', 'Marlow & the Tidewater', null);

describe('crossfade settings', () => {
  it('is off by default, with the slider parked at five seconds and the album rule on', () => {
    expect(DEFAULT_CROSSFADE).toEqual({ enabled: false, seconds: 5, sameAlbumGapless: true });
  });

  it('repairs whatever was stored: clamps the seconds to 1–12 and rounds them, defaults the rest', () => {
    expect(normalizeCrossfade(null)).toEqual(DEFAULT_CROSSFADE);
    expect(normalizeCrossfade({ enabled: true, seconds: 40 })).toEqual({ enabled: true, seconds: 12, sameAlbumGapless: true });
    expect(normalizeCrossfade({ enabled: true, seconds: 0 })).toEqual({ enabled: true, seconds: 1, sameAlbumGapless: true });
    expect(normalizeCrossfade({ enabled: 'yes', seconds: 2.6, sameAlbumGapless: false })).toEqual({ enabled: false, seconds: 3, sameAlbumGapless: false });
    expect(normalizeCrossfade({ seconds: Number.NaN })).toEqual(DEFAULT_CROSSFADE);
  });
});

describe('the handover between two tracks', () => {
  const on = { enabled: true, seconds: 6, sameAlbumGapless: true };

  it('is a cut while crossfading is off, and when nothing was playing', () => {
    expect(crossfadeMsBetween({ ...on, enabled: false }, A1, B1)).toBe(0);
    expect(crossfadeMsBetween(on, null, B1)).toBe(0);
  });

  it('overlaps by the configured seconds between different albums', () => {
    expect(crossfadeMsBetween(on, A1, B1)).toBe(6000);
    expect(crossfadeMsBetween({ ...on, seconds: 1 }, B1, A1)).toBe(1000);
  });

  it('keeps an album gapless, matching artist and album case-insensitively, unless told not to', () => {
    expect(sameAlbum(A1, A2)).toBe(true);
    expect(crossfadeMsBetween(on, A1, A2)).toBe(0);
    expect(crossfadeMsBetween({ ...on, sameAlbumGapless: false }, A1, A2)).toBe(6000);
  });

  it('never treats two singles as one album', () => {
    expect(sameAlbum(SINGLE, SINGLE)).toBe(false);
    expect(crossfadeMsBetween(on, SINGLE, A1)).toBe(6000);
  });

  it('lets a song fade into itself on repeat one', () => {
    expect(crossfadeMsBetween(on, A1, A1)).toBe(6000);
  });
});
