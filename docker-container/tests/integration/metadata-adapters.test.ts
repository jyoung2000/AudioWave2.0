import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';
import type { AcousticBrainzAdapter } from '../../src/providers/adapters/acousticbrainz.js';
import type { DeezerAdapter } from '../../src/providers/adapters/deezer.js';
import type { LastFmAdapter } from '../../src/providers/adapters/lastfm.js';
import type { MusicBrainzAdapter } from '../../src/providers/adapters/musicbrainz.js';
import type { SoundCloudAdapter } from '../../src/providers/adapters/soundcloud.js';

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

  /**
   * SoundCloud is the one searchable platform that states what a track is: a genre, and a
   * `tag_list` of the uploader's own words. The recommender keeps a whole `tags` dimension for
   * exactly this, and `CanonicalTrack` has a `tags` column -- but `SearchResult` had nowhere to put
   * them and the adapter never read `tag_list`, so every tag SoundCloud published was dropped at
   * the door and the tags dimension stayed empty on a hub whose only tag source was SoundCloud.
   *
   * Quoted phrases in a `tag_list` are one tag ("deep house" is not "deep" and "house").
   */
  it('soundcloud: keeps the tags the uploader stated, quoted phrases included', async () => {
    const sc = hub.ctx.providers.get('soundcloud') as SoundCloudAdapter;
    hub.fetch.on('secure.soundcloud.com/oauth/token', () => ({ body: { access_token: 'sc-token', expires_in: 3600 } }));
    hub.fetch.on('api.soundcloud.com/tracks', () => ({
      body: { collection: [{
        id: 77_001,
        title: 'Pelican Coast',
        duration: 212_000,
        genre: 'Electronic',
        tag_list: 'nu-disco "deep house" cover',
        permalink_url: 'https://soundcloud.com/x/77001',
        streamable: true,
        access: 'playable',
        user: { username: 'Harbour Glass' },
      }] },
    }));

    const { results } = await sc.search('pelican coast', { scope: 'songs', limit: 5 }, null);
    expect(results).toHaveLength(1);
    expect(results[0]!.genre).toBe('Electronic');
    expect(results[0]!.tags).toEqual(['nu-disco', 'deep house', 'cover']);
  });

  /** A track with no tags states none -- not an empty string turned into a tag. */
  it('soundcloud: states no tags when the uploader gave none', async () => {
    const sc = hub.ctx.providers.get('soundcloud') as SoundCloudAdapter;
    hub.fetch.on('secure.soundcloud.com/oauth/token', () => ({ body: { access_token: 'sc-token', expires_in: 3600 } }));
    hub.fetch.on('api.soundcloud.com/tracks', () => ({
      body: { collection: [{ id: 77_002, title: 'Quiet One', duration: 100_000, tag_list: '   ', permalink_url: 'https://soundcloud.com/x/77002', streamable: true, access: 'playable', user: { username: 'Harbour Glass' } }] },
    }));
    const { results } = await sc.search('quiet one', { scope: 'songs', limit: 5 }, null);
    expect(results[0]!.tags).toEqual([]);
  });

  /**
   * The tags have to survive the trip into the taste profile, which is the only reason to read
   * them: the recommender's tag factor scores what the listener played against this dimension.
   */
  it('soundcloud: stated tags reach the canonical track the recommender reads', async () => {
    const sc = hub.ctx.providers.get('soundcloud') as SoundCloudAdapter;
    hub.fetch.on('secure.soundcloud.com/oauth/token', () => ({ body: { access_token: 'sc-token', expires_in: 3600 } }));
    hub.fetch.on('api.soundcloud.com/tracks', () => ({
      body: { collection: [{ id: 77_003, title: 'Tideline', duration: 180_000, genre: 'Indie', tag_list: 'shoegaze "slow core"', permalink_url: 'https://soundcloud.com/x/77003', streamable: true, access: 'playable', user: { username: 'Harbour Glass' } }] },
    }));

    const { results } = await sc.search('tideline', { scope: 'songs', limit: 5 }, null);
    const [result] = results;
    const canonical = hub.ctx.recommendations.canonicaliseSearchResult(result!);
    expect(canonical.genres).toContain('indie');
    expect(canonical.tags).toEqual(['shoegaze', 'slow core']);
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

  it('I5: MusicBrainz is asked at one request per second, even in parallel', async () => {
    const mb = hub.ctx.providers.get('musicbrainz') as MusicBrainzAdapter;
    hub.fetch.on('musicbrainz.org/ws/2/recording?query=recording', () => ({ body: { recordings: [] } }));
    const t0 = Date.now();
    await Promise.all([mb.searchRecordings('One', 'Artist'), mb.searchRecordings('Two', 'Artist')]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });
});
