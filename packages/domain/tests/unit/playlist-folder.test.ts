/**
 * The playlist folder's format and store (DEC-041; UX-PL-002, UX-PL-003, UX-PL-004, CMP-PL-002).
 * Each test makes its own folder under the system's temp directory and removes it afterwards.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlaylistSidecar, type CatalogTrack } from '@now-playing/contracts';
import { PlaylistFolderStore, handMadeId, isInsideRoot, oneLine, parsePlaylistM3u, playlistFileBase, reconcile, serializePlaylistM3u, writeFileAtomic } from '@now-playing/domain/playlist-folder';

function track(over: Partial<CatalogTrack> & { id: string; title: string; artist: string }): CatalogTrack {
  return {
    artists: [over.artist],
    album: null,
    albumArtist: null,
    durationMs: 215_000,
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
    sources: [{ platform: 'deezer', id: over.id.split(':')[1] ?? '1', url: `https://www.deezer.com/track/${over.id.split(':')[1] ?? '1'}`, previewUrl: null, matchedBy: 'search' }],
    rank: 0,
    ...over,
  };
}

const DIGITAL_LOVE = track({ id: 'deezer:3135553', title: 'Digital Love', artist: 'Daft Punk', album: 'Discovery', isrc: 'GBDUW0000059', artworkUrl: 'https://cdn-images.dzcdn.net/images/cover/a/250x250.jpg' });
const EPLE = track({ id: 'deezer:3135556', title: 'Eple', artist: 'Röyksopp', album: 'Melody A.M.', durationMs: 220_000, artworkUrl: 'https://cdn-images.dzcdn.net/images/cover/b/250x250.jpg' });

describe('the M3U8 format', () => {
  it('writes #EXTM3U, #PLAYLIST and #EXTINF:<secs>,<artist> - <title> before each location', () => {
    const text = serializePlaylistM3u('Road Trip', [
      { location: '../library/music/Daft Punk/Discovery/03 Digital Love.flac', durationSec: 215, artist: 'Daft Punk', title: 'Digital Love' },
      { location: 'https://www.deezer.com/track/3135556', durationSec: null, artist: 'Röyksopp', title: 'Eple' },
    ]);
    expect(text).toBe('#EXTM3U\n#PLAYLIST:Road Trip\n#EXTINF:215,Daft Punk - Digital Love\n../library/music/Daft Punk/Discovery/03 Digital Love.flac\n#EXTINF:-1,Röyksopp - Eple\nhttps://www.deezer.com/track/3135556\n');
  });

  it('round-trips what it writes', () => {
    const items = [
      { location: 'a/b.mp3', durationSec: 61, artist: 'A', title: 'B - C' },
      { location: 'https://soundcloud.com/x/y', durationSec: 5, artist: 'Ünïcødé', title: '日本語' },
    ];
    const parsed = parsePlaylistM3u(serializePlaylistM3u('Ödd “name”', items));
    expect(parsed.name).toBe('Ödd “name”');
    expect(parsed.items).toEqual([
      { location: 'a/b.mp3', durationSec: 61, display: 'A - B - C' },
      { location: 'https://soundcloud.com/x/y', durationSec: 5, display: 'Ünïcødé - 日本語' },
    ]);
  });

  it('cannot be made to write an extra line: names, artists and titles lose their line breaks', () => {
    const text = serializePlaylistM3u('Evil\n/etc/passwd', [{ location: 'ok.mp3\n../../secret', durationSec: 1, artist: 'A\r\n#EXTINF', title: 'T\u2028x' }]);
    expect(text.split('\n')).toEqual(['#EXTM3U', '#PLAYLIST:Evil /etc/passwd', '#EXTINF:1,A #EXTINF - T x', 'ok.mp3 ../../secret', '']);
    expect(oneLine('a\u0000b\u007fc')).toBe('a b c');
  });

  it('reads a hand-made list: a BOM, CRLF, blank lines, no #EXTINF, comments', () => {
    const parsed = parsePlaylistM3u('\ufeff#EXTM3U\r\n\r\n# a comment\r\n#EXTINF:12.6 tvg-id="x",Artist - Song\r\nMusic\\Song.mp3\r\nloose%20file.flac\r\n');
    expect(parsed.name).toBeNull();
    expect(parsed.items).toEqual([
      { location: 'Music\\Song.mp3', durationSec: 13, display: 'Artist - Song' },
      { location: 'loose%20file.flac', durationSec: null, display: null },
    ]);
  });

  it('stops at the cap and says so', () => {
    const text = Array.from({ length: 12 }, (_, i) => `song${i}.mp3`).join('\n');
    const parsed = parsePlaylistM3u(text, 10);
    expect(parsed.items).toHaveLength(10);
    expect(parsed.capped).toBe(true);
  });

  it('matches the sidecar back by location after the list was reordered and trimmed elsewhere', () => {
    const sidecar = PlaylistSidecar.parse({
      format: 'airwave-playlist',
      version: 1,
      id: 'p1',
      name: 'X',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      entries: [
        { id: 'a', location: 'a.mp3', title: 'A', artist: 'One', isrc: 'GBAAA0000001' },
        { id: 'b', location: 'b.mp3', title: 'B', artist: 'Two' },
      ],
    });
    const entries = reconcile(parsePlaylistM3u('#EXTINF:3,Three - C\nc.mp3\nb.mp3\n'), sidecar);
    expect(entries.map((e) => [e.id.startsWith('e0-') ? 'new' : e.id, e.title, e.artist])).toEqual([
      ['new', 'C', 'Three'],
      ['b', 'B', 'Two'],
    ]);
  });

  it('makes file names safe for Windows and Linux', () => {
    expect(playlistFileBase('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(playlistFileBase('CON')).toBe('_CON');
    expect(playlistFileBase('..')).toBe('Playlist');
    expect(playlistFileBase('  .hidden.  ')).toBe('hidden');
    expect(playlistFileBase('x'.repeat(400)).length).toBeLessThanOrEqual(120);
  });
});

describe('the playlist folder store', () => {
  let root: string;
  let dir: string;
  let library: string;
  let clock: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'airwave-pl-'));
    dir = join(root, 'playlists');
    library = join(root, 'library');
    mkdirSync(join(library, 'music', 'Daft Punk'), { recursive: true });
    writeFileSync(join(library, 'music', 'Daft Punk', 'Digital Love.flac'), 'not really audio');
    clock = Date.parse('2026-10-10T12:00:00.000Z');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function store(extra: Partial<ConstructorParameters<typeof PlaylistFolderStore>[0]> = {}): PlaylistFolderStore {
    let n = 0;
    return new PlaylistFolderStore({
      dir: () => dir,
      allowedRoots: () => [library],
      locate: (t) => (t.isrc === DIGITAL_LOVE.isrc ? join(library, 'music', 'Daft Punk', 'Digital Love.flac') : null),
      trackIdForPath: (p) => (p.endsWith('Digital Love.flac') ? 'track-1' : null),
      now: () => (clock += 1000),
      newId: () => `id-${++n}`,
      ...extra,
    });
  }

  it('creates a playlist as an .m3u8 and a sidecar: a library song as a relative path, another by its source URL', async () => {
    const s = store();
    const made = await s.create({ name: 'Road Trip', tracks: [DIGITAL_LOVE, EPLE] }, 'admin');
    expect(made).toMatchObject({ name: 'Road Trip', fileName: 'Road Trip.m3u8', entryCount: 2, origin: 'airwave', readOnly: false, createdBy: 'admin', durationSec: 435 });
    expect(made.covers).toHaveLength(2);
    expect(readFileSync(join(dir, 'Road Trip.m3u8'), 'utf8')).toBe('#EXTM3U\n#PLAYLIST:Road Trip\n#EXTINF:215,Daft Punk - Digital Love\n../library/music/Daft Punk/Digital Love.flac\n#EXTINF:220,Röyksopp - Eple\nhttps://www.deezer.com/track/3135556\n');
    const sidecar = PlaylistSidecar.parse(JSON.parse(readFileSync(join(dir, 'Road Trip.airwave.json'), 'utf8')));
    expect(sidecar.entries[0]).toMatchObject({ catalogId: 'deezer:3135553', isrc: 'GBDUW0000059', album: 'Discovery', platforms: ['deezer'], addedBy: 'admin' });
    const page = await s.page(made.id, 0, 50);
    expect(page.items.map((e) => [e.locationKind, e.trackId])).toEqual([
      ['library', 'track-1'],
      ['url', null],
    ]);
  });

  it('round-trips through a fresh store (nothing kept in memory)', async () => {
    const made = await store().create({ name: 'Round', tracks: [EPLE, DIGITAL_LOVE] }, 'companion');
    const again = await store().page(made.id, 0, 10);
    expect(again.playlist).toMatchObject({ id: made.id, name: 'Round', entryCount: 2, createdBy: 'companion' });
    expect(again.items.map((e) => e.title)).toEqual(['Eple', 'Digital Love']);
  });

  it('keeps names unique and safe, and never writes outside the folder', async () => {
    const s = store();
    const a = await s.create({ name: '../../escape' }, null);
    const b = await s.create({ name: '../../escape' }, null);
    expect(a.fileName).toBe('escape.m3u8');
    expect(b.fileName).toBe('escape (2).m3u8');
    const c = await s.create({ name: 'CON' }, null);
    expect(c.fileName).toBe('_CON.m3u8');
    expect(readdirSync(root).sort()).toEqual(['library', 'playlists']);
  });

  it('adds, skips a song already there, removes, moves and renames', async () => {
    const s = store();
    const made = await s.create({ name: 'Mix' }, 'admin');
    const first = await s.add(made.id, [DIGITAL_LOVE, EPLE], {}, 'device-1');
    expect([first.added, first.skipped]).toEqual([2, 0]);
    const again = await s.add(made.id, [DIGITAL_LOVE], {}, 'device-1');
    expect([again.added, again.skipped]).toEqual([0, 1]);
    const listed = await s.list({ catalogId: EPLE.id });
    expect(listed.items[0]!.hasTrack).toBe(true);
    const page = await s.page(made.id, 0, 10);
    await s.move(made.id, page.items[1]!.id, 0);
    expect((await s.page(made.id, 0, 10)).items.map((e) => e.title)).toEqual(['Eple', 'Digital Love']);
    await s.removeEntries(made.id, [page.items[0]!.id]);
    expect((await s.page(made.id, 0, 10)).items.map((e) => e.title)).toEqual(['Eple']);
    const renamed = await s.update(made.id, { name: 'Better Mix' });
    expect(renamed.fileName).toBe('Better Mix.m3u8');
    expect(readdirSync(dir).sort()).toEqual(['Better Mix.airwave.json', 'Better Mix.m3u8']);
    await s.delete(made.id);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('enforces the caps: songs per playlist and playlists per folder', async () => {
    const s = store({ entryCap: 2, playlistCap: 2 });
    const made = await s.create({ name: 'Small' }, null);
    await s.add(made.id, [DIGITAL_LOVE, EPLE], {}, null);
    await expect(s.add(made.id, [track({ id: 'deezer:9', title: 'Nine', artist: 'N' })], {}, null)).rejects.toThrow(/at most 2 songs/);
    await s.create({ name: 'Second' }, null);
    await expect(s.create({ name: 'Third' }, null)).rejects.toThrow(/already holds 2 playlists/);
  });

  it('shows a hand-made .m3u read-only, adopts it on the first change, and keeps its id', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Old Favourites.m3u'), '#EXTM3U\n#EXTINF:100,Someone - Something\nhttps://example.com/a.mp3\nC:\\Users\\Example\\Music\\x.mp3\n../../../outside.mp3\n');
    const s = store();
    const { items } = await s.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: handMadeId('Old Favourites.m3u'), origin: 'hand-made', readOnly: true, entryCount: 3 });
    const page = await s.page(items[0]!.id, 0, 10);
    // An absolute path is neither shown nor followed; a path out of the allowed roots is missing.
    expect(page.items.map((e) => [e.locationKind, e.location])).toEqual([
      ['url', 'https://example.com/a.mp3'],
      ['missing', null],
      ['missing', '../../../outside.mp3'],
    ]);
    expect(page.items[0]).toMatchObject({ artist: 'Someone', title: 'Something', durationSec: 100 });
    await s.add(items[0]!.id, [EPLE], {}, 'admin');
    const after = await s.list();
    expect(after.items[0]).toMatchObject({ id: items[0]!.id, origin: 'airwave', readOnly: false, entryCount: 4, fileName: 'Old Favourites.m3u8' });
    expect(readdirSync(dir).sort()).toEqual(['Old Favourites.airwave.json', 'Old Favourites.m3u8']);
    // The person's own lines are kept as they wrote them.
    expect(readFileSync(join(dir, 'Old Favourites.m3u8'), 'utf8')).toContain('C:\\Users\\Example\\Music\\x.mp3');
  });

  it('picks up a list edited outside Airwave the next time it is read', async () => {
    const s = store();
    const made = await s.create({ name: 'Edited', tracks: [DIGITAL_LOVE, EPLE] }, null);
    expect((await s.list()).items[0]!.entryCount).toBe(2);
    // Another player keeps only the second song.
    writeFileSync(join(dir, 'Edited.m3u8'), '#EXTM3U\n#EXTINF:220,Röyksopp - Eple\nhttps://www.deezer.com/track/3135556\n# edited elsewhere, a few bytes longer\n');
    const page = await s.page(made.id, 0, 10);
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ title: 'Eple', catalogId: EPLE.id, album: 'Melody A.M.' });
  });

  it('does not follow a symbolic link in the folder', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'secret.m3u'), 'secret-line\n');
    try {
      symlinkSync(join(root, 'secret.m3u'), join(dir, 'linked.m3u'));
    } catch {
      return; // Creating symbolic links needs a privilege Windows does not always grant; nothing to test then.
    }
    expect((await store().list()).items).toEqual([]);
  });

  it('moves every playlist to a new folder, working the relative paths out again', async () => {
    const s = store();
    await s.create({ name: 'Moving', tracks: [DIGITAL_LOVE] }, null);
    const target = join(library, 'Playlists');
    const result = await s.moveAllTo(target);
    expect(result).toEqual({ moved: 1, failed: [] });
    expect(readdirSync(dir)).toEqual([]);
    expect(readFileSync(join(target, 'Moving.m3u8'), 'utf8')).toContain('\n../music/Daft Punk/Digital Love.flac\n');
    dir = target;
    const page = await store().page((await store().list()).items[0]!.id, 0, 10);
    expect(page.items[0]!.locationKind).toBe('library');
  });

  it('writes atomically: a temporary file renamed over the old one, nothing left behind', async () => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'old');
    await writeFileAtomic(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['a.txt']);
    // A write that fails leaves the old file and no temporary one.
    await expect(writeFileAtomic(join(dir, 'missing-folder', 'b.txt'), 'x')).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['a.txt']);
  });

  it('tells inside from outside by whole segments', () => {
    expect(isInsideRoot('/data/playlists', '/data/playlists/x.m3u8')).toBe(true);
    expect(isInsideRoot('/data/playlists', '/data/playlists-evil/x.m3u8')).toBe(false);
    expect(isInsideRoot('/data/playlists', '/data/library/x')).toBe(false);
  });
});
