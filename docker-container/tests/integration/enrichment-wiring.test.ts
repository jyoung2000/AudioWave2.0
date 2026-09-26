import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeArtist, normalizeText } from '@now-playing/domain';
import { createTestHub, type TestHub } from '../helpers/hub.js';

const meta = { ip: null, userAgent: null, correlationId: null };
const actor = { id: 'admin', displayName: 'Admin' };

describe('enrichment on the request paths', () => {
  let hub: TestHub;
  let musicDir: string;
  beforeEach(async () => {
    hub = await createTestHub();
    musicDir = join(hub.dataDir, 'library', 'music');
    mkdirSync(musicDir, { recursive: true });
    writeFileSync(join(musicDir, 'first.mp3'), 'first track bytes');
    writeFileSync(join(musicDir, 'second.mp3'), 'second track bytes');
  });
  afterEach(async () => { await hub.close(); });

  it('a scanned library track without a MusicBrainz id is queued once, not once per scan', async () => {
    const root = hub.ctx.library.addRoot('music', 'Music', meta, actor);
    await hub.ctx.library.scanRoot(root.id);
    expect(hub.ctx.repos.canonical.jobCounts()['queued']).toBe(2);
    await hub.ctx.library.scanRoot(root.id);
    expect(hub.ctx.repos.canonical.jobCounts()['queued']).toBe(2);
  });

  it('a search answers from the enrichment cache, and a queued TrackRef carries bpm and genres', async () => {
    const root = hub.ctx.library.addRoot('music', 'Music', meta, actor);
    await hub.ctx.library.scanRoot(root.id);
    const first = hub.ctx.library.tracksForRoot(root.id).find((t) => t.relativePath.endsWith('first.mp3'))!.track;
    const now = '2026-09-26T00:00:00.000Z';
    hub.ctx.repos.canonical.upsertTrack({
      id: '0190f9a0-0000-7000-8000-00000000bb01', musicbrainzRecordingId: null, isrc: null, title: first.title, normalizedTitle: normalizeText(first.title),
      artistId: null, artistName: first.artistName, normalizedArtist: normalizeArtist(first.artistName), albumId: null, albumName: 'Album', releaseYear: 2017,
      durationMs: first.durationMs, genres: ['house'], tags: [], popularity: null, createdAt: now, updatedAt: now,
      featuredArtists: [], genreProfile: { house: 0.7, electronic: 0.3 }, bpm: 120, bpmSource: 'deezer', artworkUrl: null, matchConfidence: 0.95, enrichedAt: now,
    });

    const response = await hub.ctx.search.search({ query: first.title, providers: ['hub'], actorId: 'admin' });
    const hit = response.results.find((r) => r.title === first.title);
    expect(hit, 'the hub library answers the search').toBeDefined();
    expect(hit!.bpm).toBe(120);
    expect(hit!.bpmSource).toBe('deezer');
    expect(hit!.albumName).toBe('Album');
    expect(hit!.genreProfile).toEqual({ house: 0.7, electronic: 0.3 });
    expect(hit!.identity.matchConfidence).toBe(0.95);

    const ref = hub.ctx.search.toTrackRef(hit!);
    expect(ref.bpm).toBe(120);
    expect(ref.genres).toEqual(['house']);
    expect(ref.genre).toBe('house');
  });

  it('a track the cache has never seen goes back as it came and is queued', async () => {
    const root = hub.ctx.library.addRoot('music', 'Music', meta, actor);
    await hub.ctx.library.scanRoot(root.id);
    const before = hub.ctx.repos.canonical.jobCounts()['queued'] ?? 0;
    const response = await hub.ctx.search.search({ query: 'second', providers: ['hub'], actorId: 'admin' });
    const hit = response.results.find((r) => r.title.toLowerCase().includes('second'));
    expect(hit).toBeDefined();
    expect(hit!.bpm).toBeNull();
    expect(hub.ctx.repos.canonical.jobCounts()['queued'] ?? 0).toBe(before); // already queued by the scan, deduplicated
  });
});
