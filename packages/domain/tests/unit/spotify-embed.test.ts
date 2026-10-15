import { describe, expect, it } from 'vitest';
import { readSpotifyEmbed } from '@now-playing/domain/catalog';

function page(entity: Record<string, unknown>): string {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;
}

describe('Spotify public embed pages', () => {
  it('reads public album tracks in order without treating preview clips as download sources', () => {
    const url = 'https://open.spotify.com/album/6eUW0wxWtzkFdaEFsTJto6';
    const read = readSpotifyEmbed(page({
      type: 'album',
      id: '6eUW0wxWtzkFdaEFsTJto6',
      title: 'Whenever You Need Somebody',
      subtitle: 'Rick Astley',
      coverArt: { sources: [{ url: 'https://i.scdn.co/image/cover' }] },
      trackList: [
        { uri: 'spotify:track:4PTG3Z6ehGkBFwjybzWkR8', title: 'Never Gonna Give You Up', subtitle: 'Rick Astley', duration: 213573, isExplicit: false, audioPreview: { url: 'https://p.scdn.co/preview' } },
        { uri: 'spotify:track:3X4r1d2VDYjgPYjAEjbEM7', title: 'Whenever You Need Somebody', subtitle: 'Rick Astley', duration: 233666, isExplicit: false },
      ],
    }), url);

    expect(read).toMatchObject({
      kind: 'collection',
      url,
      title: 'Whenever You Need Somebody',
      owner: 'Rick Astley',
      artworkUrl: 'https://i.scdn.co/image/cover',
      total: 2,
      capped: false,
      entries: [
        { url: 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8', title: 'Never Gonna Give You Up', artist: 'Rick Astley', durationSec: 213.573, trackNumber: 1, artworkUrl: 'https://i.scdn.co/image/cover' },
        { url: 'https://open.spotify.com/track/3X4r1d2VDYjgPYjAEjbEM7', title: 'Whenever You Need Somebody', trackNumber: 2 },
      ],
    });
    expect(JSON.stringify(read)).not.toContain('p.scdn.co');
  });

  it('reads a Spotify track with its artwork and release date', () => {
    const url = 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8';
    const read = readSpotifyEmbed(page({
      type: 'track',
      id: '4PTG3Z6ehGkBFwjybzWkR8',
      title: 'Never Gonna Give You Up',
      artists: [{ name: 'Rick Astley' }],
      releaseDate: { isoString: '1987-11-16T00:00:00Z' },
      duration: 213573,
      isExplicit: false,
      visualIdentity: { image: [{ url: 'https://i.scdn.co/image/small', maxWidth: 64 }, { url: 'https://i.scdn.co/image/large', maxWidth: 640 }] },
      audioPreview: { url: 'https://p.scdn.co/preview' },
    }), url);

    expect(read).toMatchObject({ kind: 'track', url, track: { title: 'Never Gonna Give You Up', artist: 'Rick Astley', date: '1987-11-16', durationSec: 213.573, artworkUrl: 'https://i.scdn.co/image/large', explicit: false, trackNumber: null } });
    expect(JSON.stringify(read)).not.toContain('p.scdn.co');
  });

  it('reports the embed page limit instead of claiming a 100-track playlist is complete', () => {
    const id = '37i9dQZF1DXcBWIGoYBM5M';
    const trackList = Array.from({ length: 100 }, (_, index) => ({ uri: `spotify:track:${String(index).padStart(22, 'A')}`, title: `Song ${index + 1}`, subtitle: 'Artist' }));
    const read = readSpotifyEmbed(page({ type: 'playlist', id, title: 'Long list', trackList }), `https://open.spotify.com/playlist/${id}`);
    expect(read).toMatchObject({ kind: 'collection', total: null, capped: true });
    expect(read?.kind === 'collection' ? read.entries : []).toHaveLength(100);
    expect(read?.kind === 'collection' ? read.entries[0]?.trackNumber : 1).toBeNull();
  });

  it('does not guess when the page has no entity or belongs to a different Spotify id', () => {
    expect(readSpotifyEmbed('<html>not a Spotify embed</html>', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBeNull();
    expect(readSpotifyEmbed(page({ type: 'playlist', id: 'wrong-id', title: 'Wrong', trackList: [] }), 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBeNull();
  });
});
