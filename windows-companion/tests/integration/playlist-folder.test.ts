/**
 * The companion's playlist folder against a real store and real files (DEC-041; CMP-PL-001…CMP-PL-003):
 * the default folder, a song the library has filed as a path relative to the folder (and streamed by
 * the library's id), a song it has not filed by its source, a hand-made list, moving the folder, an
 * outside edit noticed by the watcher, and every answer parsed by its IPC contract.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogTrack } from '@now-playing/contracts';
import { makeToneWav } from '@now-playing/test-fixtures';
import { scanFolder } from '../../src/main/library.js';
import { CompanionPlaylists } from '../../src/main/playlists.js';
import { CompanionStore, openCompanionDb } from '../../src/main/store.js';
import { IPC } from '../../src/shared/ipc.js';

let root: string;
let store: CompanionStore;
let chosen: string | null;
let playlists: CompanionPlaylists;

function song(id: string, title: string, artist: string, extra: Partial<CatalogTrack> = {}): CatalogTrack {
  return {
    id: `deezer:${id}`,
    title,
    artist,
    artists: [artist],
    album: null,
    albumArtist: null,
    durationMs: null,
    isrc: null,
    artworkUrl: null,
    releaseDate: null,
    year: null,
    trackNumber: null,
    discNumber: null,
    bpm: null,
    explicit: null,
    genre: null,
    label: null,
    sources: [{ platform: 'deezer', id, url: `https://www.deezer.com/track/${id}`, previewUrl: null, matchedBy: 'search' }],
    rank: 0,
    ...extra,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'np-playlists-'));
  store = new CompanionStore(openCompanionDb(':memory:'));
  chosen = null;
  // The music folder: one song the scanner indexes.
  const music = join(root, 'Music', 'Library');
  await mkdir(join(music, 'Fixture Artist'), { recursive: true });
  await writeFile(join(music, 'Fixture Artist', 'Harbour Lights.wav'), Buffer.from(makeToneWav({ seconds: 0.3, notes: [[440, 0.3]] }, { title: 'Harbour Lights', artist: 'Fixture Artist', album: 'Fixture Album' })));
  store.addFolder({ id: '0192f0c0-0000-7000-8000-0000000000f1', path: music, displayName: 'Library', kind: 'music', now: '2026-10-10T12:00:00.000Z' });
  await scanFolder(store, { id: '0192f0c0-0000-7000-8000-0000000000f1', path: music });
  playlists = new CompanionPlaylists({ store, chosenDir: () => chosen, defaultDir: join(root, 'Music', 'Airwave Playlists') });
});

afterEach(async () => {
  playlists.stop();
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe('the companion’s playlist folder', () => {
  it('starts at Music\\Airwave Playlists, the default, and answers by the IPC contract', async () => {
    const folder = IPC['playlists:folder'].response.parse(await playlists.folder());
    expect(folder).toMatchObject({ path: join(root, 'Music', 'Airwave Playlists'), isDefault: true, available: true, playlistCount: 0 });
    expect(IPC['playlists:list'].response.parse(await playlists.list({})).items).toEqual([]);
  });

  it('files a library song as a relative path the library resolves, and any other song by its source', async () => {
    const made = IPC['playlists:create'].response.parse(await playlists.create({ name: 'Mix', tracks: [song('1', 'Harbour Lights', 'Fixture Artist'), song('2', 'Elsewhere', 'Someone')] }));
    expect(made.reason).toBeNull();
    const text = await readFile(join(root, 'Music', 'Airwave Playlists', 'Mix.m3u8'), 'utf8');
    expect(text).toBe('#EXTM3U\n#PLAYLIST:Mix\n#EXTINF:-1,Fixture Artist - Harbour Lights\n../Library/Fixture Artist/Harbour Lights.wav\n#EXTINF:-1,Someone - Elsewhere\nhttps://www.deezer.com/track/2\n');
    const page = IPC['playlists:get'].response.parse(await playlists.page(made.result!.id, 0, 50));
    const [local, remote] = page.result!.items;
    expect(local).toMatchObject({ locationKind: 'library', location: '../Library/Fixture Artist/Harbour Lights.wav' });
    expect(local!.trackId).toBe(store.searchTracks({ query: 'Harbour', limit: 5, offset: 0 }).items[0]!.id);
    expect(remote).toMatchObject({ locationKind: 'url', location: 'https://www.deezer.com/track/2' });
    // Ticks for Add to Playlist ▸.
    expect((await playlists.list({ catalogId: 'deezer:2' })).items[0]!.hasTrack).toBe(true);
  });

  it('answers a failure with its reason instead of throwing', async () => {
    const answer = IPC['playlists:get'].response.parse(await playlists.page('not-there', 0, 10));
    expect(answer).toEqual({ result: null, reason: 'That playlist isn’t in the playlist folder any more.' });
    expect(await playlists.delete('not-there')).toEqual({ ok: false, reason: 'That playlist isn’t in the playlist folder any more.' });
  });

  it('shows a hand-made list, adopts it on the first change, exports it, and moves everything to a newly chosen folder', async () => {
    const dir = join(root, 'Music', 'Airwave Playlists');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'Old.m3u'), '#EXTM3U\n#EXTINF:120,Someone - Old Song\nhttps://example.com/old.mp3\nC:\\Users\\Example\\Music\\gone.mp3\n');
    const [old] = (await playlists.list({})).items;
    expect(old).toMatchObject({ origin: 'hand-made', readOnly: true, entryCount: 2 });
    const added = IPC['playlists:add'].response.parse(await playlists.add(old!.id, { tracks: [song('3', 'New', 'Someone')], allowDuplicates: false }));
    expect(added.result).toMatchObject({ added: 1, playlist: { id: old!.id, origin: 'airwave', fileName: 'Old.m3u8' } });
    const exported = join(root, 'exported.m3u8');
    expect(await playlists.exportTo(old!.id, exported)).toEqual({ path: exported, reason: null });
    expect(await readFile(exported, 'utf8')).toContain('#PLAYLIST:Old');

    const target = join(root, 'Music', 'Library', 'Playlists');
    expect(await playlists.moveTo(target)).toEqual({ moved: 1, failed: [], reason: null });
    chosen = target;
    expect(await readdir(dir)).toEqual([]);
    expect((await readdir(target)).sort()).toEqual(['Old.airwave.json', 'Old.m3u8']);
    expect((await playlists.folder()).isDefault).toBe(false);
  });

  it('notices a list changed on disk by another player', async () => {
    let told = 0;
    const watched = new CompanionPlaylists({ store, chosenDir: () => null, defaultDir: join(root, 'Music', 'Airwave Playlists'), onChange: () => (told += 1) });
    await watched.list({});
    await writeFile(join(root, 'Music', 'Airwave Playlists', 'Dropped.m3u8'), '#EXTM3U\nhttps://example.com/x.mp3\n');
    await expect.poll(() => told, { timeout: 5_000 }).toBeGreaterThan(0);
    expect((await watched.list({})).items.map((p) => p.name)).toEqual(['Dropped']);
    watched.stop();
  });
});
