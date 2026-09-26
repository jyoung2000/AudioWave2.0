import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';
import type { AcousticBrainzAdapter } from '../../src/providers/adapters/acousticbrainz.js';
import type { DeezerAdapter } from '../../src/providers/adapters/deezer.js';
import type { LastFmAdapter } from '../../src/providers/adapters/lastfm.js';

describe('metadata adapters', () => {
  let hub: TestHub;
  beforeEach(async () => { hub = await createTestHub(); });
  afterEach(async () => { await hub.close(); });

  it('deezer: bpm by isrc, and 0 means unknown', async () => {
    const deezer = hub.ctx.providers.get('deezer') as DeezerAdapter;
    hub.fetch.on('api.deezer.com/track/isrc:USUM71703861', () => ({ body: { id: 1, bpm: 98.2, duration: 200 } }));
    expect(await deezer.bpmByIsrc('USUM71703861')).toEqual({ bpm: 98, durationMs: 200_000 });
    hub.fetch.on('api.deezer.com/track/isrc:ZERO', () => ({ body: { id: 2, bpm: 0, duration: 180 } }));
    expect(await deezer.bpmByIsrc('ZERO')).toBeNull();
  });

  it('deezer: search is gated on duration', async () => {
    const deezer = hub.ctx.providers.get('deezer') as DeezerAdapter;
    hub.fetch.on('api.deezer.com/search', () => ({ body: { data: [{ id: 7, duration: 240, title: 'Song', artist: { name: 'Artist' } }] } }));
    hub.fetch.on('api.deezer.com/track/7', () => ({ body: { id: 7, bpm: 120 } }));
    expect(await deezer.bpmBySearch('Artist', 'Song', 200_000)).toBeNull();
    expect(await deezer.bpmBySearch('Artist', 'Song', 241_000)).toEqual({ bpm: 120 });
  });

  it('acousticbrainz: reads rhythm.bpm and treats 404 as unknown', async () => {
    const ab = hub.ctx.providers.get('acousticbrainz') as AcousticBrainzAdapter;
    hub.fetch.on('acousticbrainz.org/api/v1/aaaaaaaa-0000-4000-8000-000000000001/low-level', () => ({ body: { rhythm: { bpm: 174.3 } } }));
    expect(await ab.bpmByMbid('aaaaaaaa-0000-4000-8000-000000000001')).toBe(174);
    hub.fetch.on('acousticbrainz.org/api/v1/aaaaaaaa-0000-4000-8000-000000000002/low-level', () => ({ status: 404, body: {} }));
    expect(await ab.bpmByMbid('aaaaaaaa-0000-4000-8000-000000000002')).toBeNull();
  });

  it('lastfm: no key means no tags and no request', async () => {
    const lastfm = hub.ctx.providers.get('lastfm') as LastFmAdapter;
    expect(await lastfm.topTags('Artist', 'Song')).toEqual([]);
    expect(hub.fetch.calls.filter((c) => c.url.includes('audioscrobbler'))).toHaveLength(0);
  });

  it('lastfm: with a key, track tags first, artist tags as the fallback', async () => {
    const lastfm = hub.ctx.providers.get('lastfm') as LastFmAdapter;
    lastfm.configure({ ...lastfm.currentConfig(), apiKey: 'k' });
    hub.fetch.on('method=track.gettoptags', () => ({ body: { toptags: { tag: [] } } }));
    hub.fetch.on('method=artist.gettoptags', () => ({ body: { toptags: { tag: [{ name: 'hip-hop', count: 100 }, { name: 'seen live', count: 5 }] } } }));
    expect(await lastfm.topTags('Artist', 'Song')).toEqual([{ name: 'hip-hop', count: 100 }, { name: 'seen live', count: 5 }]);
  });

  it('the three are metadata-only and never claim audio', () => {
    for (const id of ['deezer', 'acousticbrainz', 'lastfm']) {
      const a = hub.ctx.providers.get(id);
      expect(a.descriptor().role).toBe('metadata-only');
      expect(a.capabilities().playback).toBe('unsupported');
      expect(a.capabilities().creatorDownload).toBe('unsupported');
    }
  });
});
