import { describe, expect, it } from 'vitest';
import type { ListeningEvent, SearchResult } from '@now-playing/contracts';
import { buildAggregateProfile, compareAggregates, computeListeningMetrics, isMeaningfulListen, mergeAggregates } from '../../src/metrics.js';
import { LocalSearchIndex, mergeSearchResults } from '../../src/search.js';
import { actionsFor } from '../../src/capabilities.js';
import { parseM3u } from '../../src/playlist-formats.js';

const DEV = '0192b1f0-0000-7000-8000-00000000d001';
const SES = '0192b1f0-0000-7000-8000-00000000e001';
let n = 0;
function ev(type: ListeningEvent['type'], at: string, track: { title: string; artistName: string; genre?: string | null; year?: number | null; provider?: string }, extra: Partial<ListeningEvent> = {}): ListeningEvent {
  n += 1;
  return { id: `0192b1f0-0000-7000-8000-${String(n).padStart(12, '0')}`, schemaVersion: 1, type, occurredAt: at, sessionId: SES, deviceId: DEV, mode: 'solo', groupId: null, trackId: null, track: { title: track.title, artistName: track.artistName, artistId: null, albumName: 'Album', albumId: null, genre: track.genre ?? null, tags: [], year: track.year ?? null, durationMs: 200_000, provider: track.provider ?? 'local', popularity: null }, positionMs: null, secondsPlayed: null, completionPercent: null, reason: null, playlistId: null, presetId: null, recommendationId: null, contextKind: null, contextId: null, mood: null, activity: null, ...extra };
}

describe('metrics', () => {
  it('meaningful listen thresholds', () => {
    expect(isMeaningfulListen(31, 200_000)).toBe(true);
    expect(isMeaningfulListen(10, 15_000)).toBe(true);
    expect(isMeaningfulListen(5, 200_000)).toBe(false);
  });
  it('derives plays, completion, skips, sessions, streaks, discovery and top lists', () => {
    const a = { title: 'One', artistName: 'Alpha', genre: 'Jazz', year: 1994 };
    const b = { title: 'Two', artistName: 'Beta', genre: null, year: 2020 };
    const events = [
      ev('started', '2026-09-01T10:00:00.000Z', a), ev('completed', '2026-09-01T10:03:20.000Z', a, { secondsPlayed: 200 }),
      ev('started', '2026-09-01T10:04:00.000Z', b), ev('skipped', '2026-09-01T10:04:05.000Z', b, { secondsPlayed: 5 }),
      ev('started', '2026-09-02T22:00:00.000Z', a), ev('completed', '2026-09-02T22:03:20.000Z', a, { secondsPlayed: 200 }),
      ev('recommendation-shown', '2026-09-02T22:04:00.000Z', a), ev('recommendation-accepted', '2026-09-02T22:04:10.000Z', a),
    ];
    const m = computeListeningMetrics(events);
    expect(m.plays).toBe(3);
    expect(m.completions).toBe(2);
    expect(m.skips).toBe(1);
    expect(m.earlySkips).toBe(1);
    expect(m.completionRate).toBeCloseTo(2 / 3);
    expect(m.totalMinutes).toBeCloseTo(405 / 60);
    expect(m.topArtists[0]!.label).toBe('Alpha');
    expect(m.topGenres[0]!.label).toBe('Jazz');
    expect(m.sessions).toHaveLength(2);
    expect(m.longestStreakDays).toBe(2);
    expect(m.discoveryRate).toBeCloseTo(2 / 3);
    expect(m.unknownGenrePercent).toBeCloseTo(100 / 3);
    expect(m.recommendations.acceptanceRate).toBe(1);
    expect(m.byDay.map((d) => d.key)).toEqual(['2026-09-01', '2026-09-02']);
    expect(computeListeningMetrics(events)).toEqual(m);
  });
  it('aggregates hide titles and compare with thresholds', () => {
    const a = { title: 'One', artistName: 'Alpha', genre: 'Jazz', year: 1994 };
    const events = Array.from({ length: 25 }, (_, i) => [ev('started', `2026-09-0${(i % 7) + 1}T10:0${i % 6}:00.000Z`, a), ev('meaningful', `2026-09-0${(i % 7) + 1}T10:0${i % 6}:35.000Z`, a), ev('completed', `2026-09-0${(i % 7) + 1}T10:0${i % 6}:40.000Z`, a, { secondsPlayed: 200 })]).flat();
    const now = '2026-09-10T00:00:00.000Z';
    const mine = buildAggregateProfile(events, { id: '0192b1f0-0000-7000-8000-0000000000a1', ownerId: DEV, windowDays: 30, now });
    expect(mine.minSampleMet).toBe(true);
    expect(JSON.stringify(mine)).not.toContain('One');
    expect(mine.eras[0]!.key).toBe('1990s');
    const other = { ...mine, id: '0192b1f0-0000-7000-8000-0000000000a2', ownerId: '0192b1f0-0000-7000-8000-00000000d002', artists: [{ key: 'gamma', weight: 1 }], genres: [{ key: 'jazz', weight: 1 }] };
    const cmp = compareAggregates(mine, other);
    expect(cmp.overlapPercent.artists).toBe(0);
    expect(cmp.overlapPercent.genres).toBe(100);
    expect(cmp.newToMe[0]).toMatchObject({ key: 'gamma', kind: 'artist' });
    expect(mergeAggregates([mine], { id: 'x', ownerId: 'g', now, minCohort: 2 })).toBeNull();
    expect(mergeAggregates([mine, other], { id: '0192b1f0-0000-7000-8000-0000000000a3', ownerId: 'g', now, minCohort: 2 })!.artists.length).toBeGreaterThan(0);
  });
});

describe('local search', () => {
  it('searches deterministically with scopes and prefixes', () => {
    const idx = new LocalSearchIndex([
      { id: '1', title: 'Blue Train', artistName: 'John Coltrane', albumName: 'Blue Train', genre: 'Jazz', playlistNames: ['Late Night'] },
      { id: '2', title: 'Blue in Green', artistName: 'Miles Davis', albumName: 'Kind of Blue', genre: 'Jazz' },
      { id: '3', title: 'Green Onions', artistName: 'Booker T', albumName: 'Green Onions', genre: 'Soul' },
    ]);
    expect(idx.search('blue').map((r) => r.item.id)).toEqual(['1', '2']);
    expect(idx.search('blue', { scope: 'songs' }).map((r) => r.item.id)).toEqual(['2', '1']);
    expect(idx.search('kind', { scope: 'albums' }).map((r) => r.item.id)).toEqual(['2']);
    expect(idx.search('colt').map((r) => r.item.id)).toEqual(['1']);
    expect(idx.search('late night', { scope: 'playlists' }).map((r) => r.item.id)).toEqual(['1']);
    expect(idx.search('blue onions')).toEqual([]);
    expect(idx.search('')).toEqual([]);
  });
  it('merges cross-provider results into variants and keeps actions capability-driven', () => {
    const caps = { metadata: 'available', search: 'available', preview: 'available', playback: 'available', importLikes: 'unsupported', importPlaylists: 'unsupported', creatorDownload: 'unsupported', userOwnedDownload: 'unsupported', groupSync: 'best_effort', eq: 'unsupported' } as const;
    const base = (provider: string, id: string, extra: Partial<SearchResult> = {}): SearchResult => ({ id: `${provider}:track:${id}`, kind: 'track', provider, providerId: id, title: 'Same Song', artistName: 'Same Artist', albumName: null, durationMs: 200_000, artworkUrl: null, canonicalUrl: null, year: null, genre: null, capabilities: { ...caps }, identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} }, attribution: null, cachedAt: null, stale: false, accessState: 'available', previewUrl: null, trackId: null, variants: [], ...extra });
    const merged = mergeSearchResults([[base('youtube', 'y1')], [base('local', 'l1')], [base('soundcloud', 's1', { title: 'Different' })]]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.provider).toBe('local');
    expect(merged[0]!.variants.map((v) => v.provider)).toEqual(['youtube']);
    const actions = actionsFor({ ...caps, playback: 'requires_auth' }, { hasCanonicalUrl: false, hubConnected: false, inGroup: false });
    expect(actions.find((a) => a.action === 'play')!.enabled).toBe(false);
    expect(actions.find((a) => a.action === 'download')!.enabled).toBe(false);
    expect(actions.find((a) => a.action === 'add-to-group-queue')!.why).toContain('hub');
  });
  it('m3u parsing rejects traversal', () => {
    const r = parseM3u('#EXTM3U\n#EXTINF:123,Artist - Title\nmusic/a.mp3\n../../etc/passwd\nhttps://example.com/x.mp3\nhttp://insecure/x.mp3\n');
    expect(r.entries.map((e) => e.path)).toEqual(['music/a.mp3', 'https://example.com/x.mp3']);
    expect(r.entries[0]!.durationSeconds).toBe(123);
    expect(r.rejected).toHaveLength(2);
  });
});
