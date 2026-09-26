import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';
import type { MusicBrainzAdapter } from '../../src/providers/adapters/musicbrainz.js';

const RECORDING = {
  id: 'aaaaaaaa-0000-4000-8000-000000000010',
  title: 'Song',
  length: 200_000,
  isrcs: ['USUM71703861'],
  'artist-credit': [
    { name: 'Artist', joinphrase: ' feat. ', artist: { id: 'x', name: 'Artist' } },
    { name: 'Guest', joinphrase: '', artist: { id: 'y', name: 'Guest' } },
  ],
  releases: [{ id: 'r1', title: 'Album', date: '2017-05-12', status: 'Official', 'release-group': { id: 'rg1', title: 'Album', 'primary-type': 'Album' } }],
  genres: [{ name: 'hip hop', count: 12 }],
  tags: [{ name: 'summer', count: 3 }],
};

describe('musicbrainz recordings', () => {
  let hub: TestHub;
  let mb: MusicBrainzAdapter;
  beforeEach(async () => {
    hub = await createTestHub();
    mb = hub.ctx.providers.get('musicbrainz') as MusicBrainzAdapter;
  });
  afterEach(async () => { await hub.close(); });

  it('finds a recording by isrc with credits, album, year, genres and tags', async () => {
    hub.fetch.on('musicbrainz.org/ws/2/recording?query=isrc', () => ({ body: { recordings: [RECORDING] } }));
    const [r] = await mb.recordingsByIsrc('USUM71703861');
    expect(r).toMatchObject({ id: RECORDING.id, artistName: 'Artist', featuredArtists: ['Guest'], albumName: 'Album', releaseYear: 2017, releaseGroupId: 'rg1', lengthMs: 200_000 });
    expect(r!.genres[0]).toEqual({ name: 'hip hop', count: 12 });
    expect(r!.isrcs).toEqual(['USUM71703861']);
  });

  it('searches by title and artist, asking for credits, releases, genres and tags', async () => {
    hub.fetch.on('musicbrainz.org/ws/2/recording?query=recording', () => ({ body: { recordings: [RECORDING] } }));
    const hits = await mb.searchRecordings('Song', 'Artist');
    expect(hits.map((h) => h.id)).toEqual([RECORDING.id]);
    expect(hub.fetch.calls.at(-1)!.url).toContain('inc=');
  });

  it('looks a recording up by id', async () => {
    hub.fetch.on('musicbrainz.org/ws/2/recording/aaaaaaaa-0000-4000-8000-000000000010', () => ({ body: RECORDING }));
    expect((await mb.recordingDetail('aaaaaaaa-0000-4000-8000-000000000010'))?.albumName).toBe('Album');
    hub.fetch.on('musicbrainz.org/ws/2/recording/aaaaaaaa-0000-4000-8000-000000000099', () => ({ status: 404, body: { error: 'Not Found' } }));
    expect(await mb.recordingDetail('aaaaaaaa-0000-4000-8000-000000000099')).toBeNull();
  });

  it('resolves cover art to the front-250 url when the archive has it', async () => {
    hub.fetch.on('coverartarchive.org/release-group/rg1', () => ({ body: { images: [{ front: true, thumbnails: { '250': 'https://archive.org/x-250.jpg' } }] } }));
    expect(await mb.coverArtUrl('rg1')).toBe('https://coverartarchive.org/release-group/rg1/front-250');
    hub.fetch.on('coverartarchive.org/release-group/none', () => ({ status: 404, body: { error: 'No cover art found.' } }));
    expect(await mb.coverArtUrl('none')).toBeNull();
  });

  it('M3: the album is the earliest official release, never a compilation', async () => {
    const releases = [
      { id: 'r9', title: 'Now 67', date: '2019-01-01', status: 'Official', 'release-group': { id: 'rg9', title: 'Now 67', 'primary-type': 'Album', 'secondary-types': ['Compilation'] } },
      { id: 'r1', title: 'Album', date: '2017-05-12', status: 'Official', 'release-group': { id: 'rg1', title: 'Album', 'primary-type': 'Album' } },
    ];
    hub.fetch.on('query=isrc', () => ({ body: { recordings: [{ ...RECORDING, releases }] } }));
    const [r] = await mb.recordingsByIsrc('USUM71703861');
    expect(r!.albumName).toBe('Album');
    expect(r!.releaseYear).toBe(2017);
    expect(r!.releaseGroupId).toBe('rg1');
  });
});
