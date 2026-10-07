/**
 * The helper reads a whole list for the catalog (no 200-song cap; DEC-039, owner requirement
 * 2026-10-06): yt-dlp lists one past CATALOG_COLLECTION_CAP so a longer list is reported, a page of
 * a SoundCloud set's bare ids is described in full by position, and spotDL's save keeps every song.
 * The paste route (`/helper/v1/resolve`) keeps its own HELPER_RESOLVE_CAP.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG_COLLECTION_CAP, HELPER_RESOLVE_CAP } from '@now-playing/contracts';
import { fromSpotdl, fromYtDlp, ytDlpResolveArgs } from '../../src/resolve.js';

describe('reading a whole list', () => {
  it('yt-dlp: flat to the cap it is given; positions in full when asked; the URL always last, behind --', () => {
    expect(ytDlpResolveArgs('https://www.youtube.com/playlist?list=PLx')).toContain(String(HELPER_RESOLVE_CAP));
    const all = ytDlpResolveArgs('https://www.youtube.com/playlist?list=PLx', { cap: CATALOG_COLLECTION_CAP + 1 });
    expect(all[all.indexOf('--playlist-end') + 1]).toBe(String(CATALOG_COLLECTION_CAP + 1));
    expect(all).toContain('--flat-playlist');
    const page = ytDlpResolveArgs('https://soundcloud.com/band/sets/long', { items: [251, 252, 253] });
    expect(page[page.indexOf('--playlist-items') + 1]).toBe('251,252,253');
    expect(page).not.toContain('--flat-playlist');
    expect(page.slice(-2)).toEqual(['--', 'https://soundcloud.com/band/sets/long']);
  });

  it('keeps 1,500 entries of a playlist and 3,000 songs of a Spotify playlist when the cap allows', () => {
    const entries = Array.from({ length: 1500 }, (_, i) => ({ url: `https://www.youtube.com/watch?v=v${i}`, title: `Song ${i}` }));
    const yt = fromYtDlp({ _type: 'playlist', title: 'Long', playlist_count: 1500, entries }, new URL('https://www.youtube.com/playlist?list=PLx'), new Date(), CATALOG_COLLECTION_CAP);
    expect(yt.collection).toMatchObject({ total: 1500, capped: false });
    expect(yt.collection!.entries).toHaveLength(1500);
    const songs = Array.from({ length: 3000 }, (_, i) => ({ name: `Song ${i}`, artists: ['Band'], url: `https://open.spotify.com/track/${i}`, list_name: 'Long', list_length: 3000 }));
    const sp = fromSpotdl(songs, new URL('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), new Date(), CATALOG_COLLECTION_CAP);
    expect(sp.collection).toMatchObject({ total: 3000, capped: false });
    expect(sp.collection!.entries).toHaveLength(3000);
    // The paste route's own answer is still held to its cap, and says so.
    expect(fromSpotdl(songs, new URL('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).collection).toMatchObject({ capped: true });
  });
});
