/**
 * Airwave, the player: the shell served as music-player/index.html (DEC-019), built by the player's
 * own Vite config and run on the e2e suites' eight tagged songs, the bundled radio shelf, and a
 * companion on this PC (its helper answered from scripts/mockups/fixtures/player.json).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, viteBuild } from '../lib/browser.mjs';
import manifest from '../../../design/manifest.json' with { type: 'json' };
import fixtures from '../fixtures/player.json' with { type: 'json' };
import { behaviourData, catalogAlbum, catalogArtist, catalogEnrich, catalogLyrics, catalogResolve, catalogSearch, deezerAnswer, itunesAnswer } from '../lib/stock-search.mjs';

const ORIGIN = 'http://127.0.0.1:47910';
const HELPER = 'http://127.0.0.1:17342';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const json = (body) => ({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** The shell's one stylesheet: the <style> make-shell.py keeps from the design. */
function shellCss() {
  const html = readFileSync(join(ROOT, 'music-player/index.html'), 'utf8').replace(/\r\n/g, '\n');
  const blocks = [...html.matchAll(/<style>\n?([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  if (blocks.length !== 1) throw new Error(`player: expected one <style> in music-player/index.html, found ${blocks.length}`);
  return blocks[0];
}

/** Two artists, two albums, four songs each — the e2e suites' seed (music-player/tests/e2e/np/_shell.ts). */
export const SEED = [
  ['01 Harbour Morning.wav', 'Harbour Morning', 'Alder Quartet', 'First Light'],
  ['02 Gantry.wav', 'Gantry', 'Alder Quartet', 'First Light'],
  ['03 Blue Hour.wav', 'Blue Hour', 'Alder Quartet', 'First Light'],
  ['04 Tideline.wav', 'Tideline', 'Alder Quartet', 'First Light'],
  ['05 Paper Harbour.wav', 'Paper Harbour', 'Birch Ensemble', 'Late Shift'],
  ['06 Closing Hour.wav', 'Closing Hour', 'Birch Ensemble', 'Late Shift'],
  ['07 Ember Line.wav', 'Ember Line', 'Birch Ensemble', 'Late Shift'],
  ['08 Slow Carousel.wav', 'Slow Carousel', 'Birch Ensemble', 'Late Shift'],
];

/** Generated in the page: 8 kHz PCM with RIFF INFO tags, indexed through the shell's own import path. */
export function addSongs(list) {
  const wav = (name, secs, tags) => {
    const rate = 8000;
    const n = secs * rate;
    const enc = (s) => {
      const b = new TextEncoder().encode(`${s} `);
      return b.length % 2 ? new Uint8Array([...b, 0]) : b;
    };
    const info = Object.entries(tags).map(([k, v]) => ({ k, e: enc(v) }));
    const listLen = 4 + info.reduce((a, x) => a + 8 + x.e.length, 0);
    const total = 44 + n * 2 + 8 + listLen;
    const buf = new ArrayBuffer(total);
    const v = new DataView(buf);
    const u = new Uint8Array(buf);
    const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    s(0, 'RIFF');
    v.setUint32(4, total - 8, true);
    s(8, 'WAVE');
    s(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    let o = 36;
    s(o, 'LIST');
    v.setUint32(o + 4, listLen, true);
    s(o + 8, 'INFO');
    o += 12;
    for (const x of info) {
      s(o, x.k);
      v.setUint32(o + 4, x.e.length, true);
      u.set(x.e, o + 8);
      o += 8 + x.e.length;
    }
    s(o, 'data');
    v.setUint32(o + 4, n * 2, true);
    o += 8;
    for (let i = 0; i < n; i += 1) v.setInt16(o + i * 2, Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 1500), true);
    // A fixed date, so "added" and "modified" read the same on every run.
    return new File([buf], name, { type: 'audio/wav', lastModified: Date.UTC(2026, 8, 12, 18, 30) });
  };
  const files = list.map(([file, title, artist, album], i) => wav(file, 180 + i * 17, { INAM: title, IART: artist, IPRD: album }));
  return window.NP_LIBRARY.addFiles(files).then((r) => r.added);
}

const MAIN = ['now-playing', 'radio', 'live-tv', 'tv', 'movies'];
const SETTINGS = ['settings-stats', 'settings-rec', 'settings-src', 'settings-player', 'settings-eq'];

/** Where a click leads in the mockup: the same place it led in the app. */
const LINKS = [
  { selector: '.tb__btn[data-view="music"]', to: 'now-playing', in: MAIN },
  { selector: '.tb__btn[data-view="music"]', to: 'library', in: ['recent', 'library-menu'] },
  ...['radio', 'live-tv', 'tv', 'movies'].map((view) => ({ selector: `.tb__btn[data-view="${view}"]`, to: view, in: [...MAIN, 'library', 'recent'] })),
  { selector: '#libMenuBtn', to: 'library-menu', in: ['library', 'recent', 'now-playing'] },
  { selector: '#libMenuBtn', to: 'tv-menu', in: ['tv'] },
  { selector: '#libraryRows tr', text: 'Gantry', to: 'now-playing', in: ['library'] },
  { selector: '#libraryRows tr', to: 'row-menu', on: 'contextmenu', in: ['now-playing'] },
  { selector: '#ctx [data-act="parent"]', to: 'row-menu-playlists', in: ['row-menu'] },
  { selector: '#ctx .ctx__sub [data-act="new-add"]', to: 'new-playlist-sheet', in: ['row-menu-playlists'] },
  { selector: '#sheetCancel, #sheetCreate', to: 'now-playing', in: ['new-playlist-sheet'] },
  { selector: '#profile', to: 'settings-stats', in: [...MAIN, 'library', 'recent'] },
  ...SETTINGS.map((id) => ({ selector: `#pt-${id.slice('settings-'.length)}`, to: id, in: [...SETTINGS, 'settings-src-hub'] })),
  { selector: '#prefsBack', to: 'now-playing', in: [...SETTINGS, 'settings-src-hub'] },
  { selector: '#hubTest', to: 'settings-src-hub', in: ['settings-src'] },
  // The search: its views lead where they led in the app (NP-FIND-003..008).
  { selector: '.srch__more', to: 'search-see-all', in: ['search', 'search-keys'] },
  { selector: '.srch__row--artist', to: 'search-artist', in: ['search', 'search-keys'] },
  { selector: '.srch__row--album', to: 'search-album', in: ['search', 'search-keys', 'search-artist'] },
  { selector: '#srchList .srch__row:not(.srch__more):not(.srch__row--artist):not(.srch__row--album) .srch__title', to: 'search-song', in: ['search', 'search-keys', 'search-album'] },
  { selector: '#srchBack', to: 'search', in: ['search-see-all', 'search-artist', 'search-album', 'search-song'] },
  { selector: '#srchFilterBtn', to: 'search-filter', in: ['search', 'search-keys', 'search-see-all'] },
  { selector: '#srchFilterCancel, #srchFilter button[type="submit"]', to: 'search', in: ['search-filter'] },
  { selector: '#qMore', to: 'search-advanced', in: ['search', 'search-keys'] },
  { selector: '#qMore', to: 'search', in: ['search-advanced'] },
  { selector: '.srch__row--coll', to: 'playlist-in-list', in: ['pasted-link'] },
  { selector: '.srch__btn[data-act="list"]', to: 'playlist-in-list', in: ['search-album'] },
  { selector: '#libColStar', to: 'playlist-kept', in: ['playlist-in-list'] },
  { selector: '#libColStar', to: 'playlist-in-list', in: ['playlist-kept'] },
];

export default {
  id: 'player',
  title: 'Airwave',
  file: 'airwave-now-playing.html',
  from: 'music-player/index.html (generated by music-player/scripts/make-shell.py) and music-player/src/shell, built by music-player/vite.config.ts.',
  // What it is made from, for its stamp: design/manifest.json, mockups.files.player.inputs.
  inputs: manifest.mockups.files.player.inputs,
  viewport: { width: 1280, height: 860 },
  locale: 'en-US',
  // Ids the shell makes as it indexes (UUIDv7: a time and random bits) are written as stable ones.
  stableIds: true,
  /** Whatever is playing is shown 0:47 in, in every state, through the engine's own seek. */
  async beforeSnap(page) {
    // Held there while the state is read: the position no longer moves with the clock, so a
    // timeupdate that lands a frame earlier or later reads the same 0:47.
    await page.evaluate(() => {
      window.__mockMediaHeld = true;
      const player = window.NP_PLAYER;
      if (player && player.playing && player.playing()) player.seek(47);
    });
    await page.clock.runFor(300);
  },
  async afterSnap(page) {
    await page.evaluate(() => {
      window.__mockMediaHeld = false;
    });
  },
  timezoneId: 'UTC',
  // Outside services the shell asks and copes without: the station directory and station logos,
  // stations' now-playing feeds, oEmbed for a pasted link, tempo and artwork lookups. (The search
  // itself is answered: the companion's catalog, from lib/stock-search.mjs.)
  unanswered: [/^GET https:\/\/(?:[a-z0-9-]+\.)*(radio-browser\.info|tritondigital\.com|iheart\.com|radio\.co|youtube\.com\/oembed|noembed\.com|deezer\.com|itunes\.apple\.com|musicbrainz\.org|coverartarchive\.org)[/?]/i, /^GET https:\/\/[^ ]+\.(png|jpe?g|ico|svg|webp)(\?|$)/i],
  expectedErrors: [],
  links: LINKS,
  /** Small readable scripts the mockup runs on its captured markup (not the app's code): search on stock songs. */
  behaviours: [
    {
      name: 'search',
      file: 'player-search.js',
      data: { template: 'search', clip: 30, ...behaviourData() },
    },
  ],

  async prepare() {
    const dist = await viteBuild({ configFile: 'music-player/vite.config.ts', root: 'music-player', label: 'player' });
    return {
      dist,
      origin: ORIGIN,
      now: fixtures.now,
      routes: async (route, url) => {
        // Search and tempo, answered from the stock songs (lib/stock-search.mjs).
        if (url.origin === 'https://itunes.apple.com' && url.pathname === '/search') {
          await route.fulfill(json(itunesAnswer(url.searchParams.get('term') || '')));
          return true;
        }
        if (url.origin === 'https://api.deezer.com') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript' }, body: deezerAnswer(url) });
          return true;
        }
        // The music catalog, through the companion on this PC (DEC-039): the search streams NDJSON.
        if (url.origin === HELPER && url.pathname === '/helper/v1/catalog/search') {
          await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/x-ndjson' }, body: catalogSearch(url) });
          return true;
        }
        const catalog = { album: catalogAlbum, artist: catalogArtist, lyrics: catalogLyrics, enrich: catalogEnrich, resolve: catalogResolve };
        const route2 = url.origin === HELPER && /^\/helper\/v1\/catalog\/(\w+)$/.exec(url.pathname);
        if (route2 && catalog[route2[1]]) {
          const body = catalog[route2[1]](url);
          await route.fulfill(body ? json(body) : { status: 404, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"error":"not_found","message":"Not in the stock catalogue"}' });
          return true;
        }
        const answer =
          url.origin === HELPER
            ? url.pathname === '/search'
              ? fixtures.search
              : fixtures.helper[url.pathname]
            : url.origin === fixtures.hubBase
              ? fixtures.hub[url.pathname]
              : undefined;
        if (!answer) return false;
        if (route.request().method() === 'OPTIONS') await route.fulfill({ status: 204, headers: CORS });
        else await route.fulfill(json(answer));
        return true;
      },
    };
  },

  stylesheets(states) {
    const sheets = [{ source: 'music-player/index.html', css: shellCss() }];
    const extra = new Map();
    for (const state of states) for (const style of state.styles) if (style.text.trim() && !sheets.some((s) => s.css.trim() === style.text.trim())) extra.set(style.text, style);
    let n = 0;
    for (const text of extra.keys()) sheets.push({ source: `runtime ${(n += 1)} (added by the shell's script)`, css: text });
    return sheets;
  },

  async run({ page, until, evaluate, click, settle, snap, origin }) {
    const hash = async (value, ms = 1200) => {
      await page.evaluate((h) => {
        location.hash = h;
      }, value);
      await settle(ms);
    };
    await page.goto(`${origin}/`);
    await until(() => Boolean(window.NP_READY), undefined, { what: 'the bridge' });
    await evaluate(() => window.NP_READY);
    const added = await evaluate(addSongs, SEED);
    if (added !== SEED.length) throw new Error(`player: the shell indexed ${added} of ${SEED.length} songs`);

    // The companion app on this PC, found the way a person finds it: Settings ▸ Sources ▸ Connect.
    await hash('#settings/src');
    await click('#cfgConnect', { ms: 1500 });
    await page.click('#prefsBack', { force: true });
    await settle(800);
    if (await page.evaluate(() => !document.getElementById('prefs').hidden)) {
      await page.click('#prefsBack', { force: true });
      await settle(800);
    }

    // ---- Music
    await snap({ id: 'recent', title: 'Recently played (first open)', group: 'Music', note: 'A new player opens on what was played recently, which is nothing yet.' });
    // The whole library is one narrowing away (the first album in the Albums drill), cleared — as the e2e suites' resetToLibrary.
    if ((await page.getAttribute('#libScopeClear', 'hidden')) !== null) {
      await click('#libMenuBtn', { ms: 300 });
      await click('#ipodMenu .ipod__item[data-i="4"]', { ms: 300 });
      await click('#ipodMenu .ipod__item[data-i="0"]', { ms: 400 });
    }
    await click('#libScopeClear', { ms: 400 });
    await snap({ id: 'library', title: 'Library', group: 'Music', note: 'The whole library on this device, nothing playing yet.' });
    await click('#libMenuBtn', { ms: 500 });
    await snap({ id: 'library-menu', title: 'Library menu', group: 'Music', note: 'The library button: browse by playlists, artists, albums, songs, genres.', dismiss: 'library', dismissOutside: '#ipodMenu' });
    await click('#libMenuBtn', { ms: 500 });
    await click('#libraryRows tr:has(.lib-title:text-is("Gantry"))', { ms: 2500 });
    await snap({ id: 'now-playing', title: 'Now playing', group: 'Music', note: 'Gantry playing from this device: the disc, the transport and the list.' });

    await page.locator('#libraryRows tr:has(.lib-title:text-is("Blue Hour"))').click({ button: 'right', position: { x: 200, y: 8 }, force: true });
    await settle(400);
    await snap({ id: 'row-menu', title: 'Row menu', group: 'Music', note: 'Right-click (or long-press) a song: the contextual menu.', dismiss: 'now-playing' });
    await click('#ctx [data-act="parent"]', { ms: 400 });
    await snap({ id: 'row-menu-playlists', title: 'Row menu ▸ Add to Playlist', group: 'Music', note: 'The Add to Playlist submenu.', dismiss: 'now-playing' });
    await click('#ctx .ctx__sub [data-act="new-add"]', { ms: 600 });
    await page.fill('#sheetInput', 'Sunday Morning');
    await settle(300);
    await snap({ id: 'new-playlist-sheet', title: 'New playlist sheet', group: 'Music', note: 'Add to Playlist ▸ New Playlist…, answered in the sheet.', dismiss: 'now-playing', dismissOutside: '#sheet' });
    await click('#sheetCancel', { ms: 500 });

    // ---- Search: the music catalog, through the companion on this PC (NP-FIND-001..008)
    const pop = { dismiss: 'now-playing', dismissOutside: '#searchBox' };
    // Reading a state can take focus from the field, which shuts the popover; it opens again on focus.
    const inPop = async (selector, ms) => {
      if (await page.evaluate(() => document.getElementById('srch').hidden)) {
        await page.evaluate(() => document.getElementById('q').blur());
        await page.focus('#q');
        await settle(300);
      }
      await click(selector, { ms });
    };
    await page.click('#q', { force: true });
    await page.fill('#q', 'harbour');
    await page.press('#q', 'Enter');
    await settle(2500);
    await snap({ id: 'search', title: 'Search', group: 'Search', note: 'Search runs on Enter and streams in: songs, artists and albums in sections, each row with the platforms it is on, and a quiet line saying how every service did (one is cooling down). Songs have a 30-second preview, time and tempo, and + to add them. In this mockup the field searches the stock songs as you type and press Enter; the arrows and Page Up/Down move through every section.', ...pop });
    await page.press('#q', 'ArrowDown');
    await page.press('#q', 'ArrowDown');
    await settle(300);
    await snap({ id: 'search-keys', title: 'Search ▸ a row chosen with the keys', group: 'Search', note: 'Arrow keys move the highlight through every section; Enter previews a song (or opens an artist or album), Ctrl+Enter adds the song, Escape goes back and then closes.', ...pop });
    await inPop('.srch__more', 1500);
    await snap({ id: 'search-see-all', title: 'Search ▸ See all songs', group: 'Search', note: 'One section alone, under Back: the rest of its pages arrive as it scrolls, until it says that is all.', ...pop });
    await inPop('#srchBack', 600);
    await inPop('.srch__row--artist', 1500);
    await snap({ id: 'search-artist', title: 'Search ▸ an artist', group: 'Search', note: 'An artist: picture, genre and fans, their top songs and albums. An album here drills into it; Back walks back.', ...pop });
    await inPop('#srchList .srch__row--album', 1500);
    await snap({ id: 'search-album', title: 'Search ▸ an album', group: 'Search', note: 'An album: cover, year, label, genre and its songs, and Open in Music, which shows it in the music list.', ...pop });
    await inPop('#srchList .srch__row[data-i="0"] .srch__title', 2000);
    await snap({ id: 'search-song', title: 'Search ▸ a song', group: 'Search', note: 'A song: its platforms, genre, label and year (enrichment), its ISRC, Add to Library and Download…, and its lyrics, synced.', ...pop });
    await inPop('#srchBack', 400);
    await inPop('#srchBack', 400);
    await inPop('#srchBack', 600);
    await inPop('#srchFilterBtn', 600);
    await snap({ id: 'search-filter', title: 'Search ▸ Filter', group: 'Search', note: 'Which sections a search shows and which services it asks, kept in the player’s settings.', dismiss: 'search', dismissOutside: '#srchFilter' });
    await click('#srchFilterCancel', { ms: 400 });
    await inPop('#qMore', 600);
    await page.fill('#srchAdv input[name="artist"]', 'Cassette Bloom');
    await settle(300);
    await snap({ id: 'search-advanced', title: 'Search ▸ Track, Artist, Album, ISRC', group: 'Search', note: 'The pill’s switch folds out Track, Artist, Album and ISRC fields; the pill shows them merged, and folding them away keeps them merged.', ...pop });
    await click('#qMore', { ms: 400 });
    await page.fill('#q', 'harbour lights');
    await settle(300);
    await snap({ id: 'search-stale', title: 'Search ▸ typed, not yet searched', group: 'Search', note: 'Between a keystroke and Enter the rows are the last search’s, dimmed, and the count says what to do.', ...pop });
    await page.fill('#q', 'theremin');
    await page.press('#q', 'Enter');
    await settle(1500);
    await snap({ id: 'search-empty', title: 'Search ▸ no matches', group: 'Search', note: 'A search that finds nothing says so, with the words searched for.', ...pop });
    await page.fill('#q', fixtures.playlistLink);
    await page.press('#q', 'Enter');
    await settle(2500);
    await snap({ id: 'pasted-link', title: 'Pasted playlist link', group: 'Search', note: 'A pasted Spotify playlist, read by the companion: one listing that names its platform, its cover a 2×2 mosaic of its first four songs’ covers. Opening it shows it in the music list.', ...pop });
    await inPop('.srch__row--coll', 1500);
    await snap({ id: 'playlist-in-list', title: 'A playlist in the music list', group: 'Search', note: 'Opened, the playlist shows the way an album does: the silver bar names it, its songs are the rows, and the star beside its name keeps it in the library.' });
    await click('#libColStar', { ms: 600 });
    await snap({ id: 'playlist-kept', title: 'A playlist kept in the library', group: 'Search', note: 'Starred: it is in the library menu under Playlists, and opens again from there.' });
    await click('#libScopeClear', { ms: 400 });
    await page.fill('#q', '');
    await page.mouse.click(5, 300);
    await settle(400);

    // ---- Radio, Live TV, TV, Movies
    await click('.tb__btn[data-view="radio"]', { ms: 1500 });
    await snap({ id: 'radio', title: 'Radio', group: 'Radio and video', note: 'Radio with the station directory unreachable: the bundled shelf of stations.' });
    await click('.tb__btn[data-view="live-tv"]', { ms: 1200 });
    await snap({ id: 'live-tv', title: 'Live TV', group: 'Radio and video', note: 'The guide from the companion’s channels, with what is on now and next.' });
    await click('.tb__btn[data-view="tv"]', { ms: 800 });
    await snap({ id: 'tv', title: 'TV', group: 'Radio and video', note: 'TV has no catalogue yet: an honest empty guide.' });
    await click('#libMenuBtn', { ms: 500 });
    await snap({ id: 'tv-menu', title: 'TV menu', group: 'Radio and video', note: 'The library button on TV: TV, Saved and Playlists.', dismiss: 'tv', dismissOutside: '#mediaMenu' });
    await click('#libMenuBtn', { ms: 500 });
    await click('.tb__btn[data-view="movies"]', { ms: 800 });
    await snap({ id: 'movies', title: 'Movies', group: 'Radio and video', note: 'Movies has no catalogue yet: an honest empty list.' });
    await click('.tb__btn[data-view="music"]', { ms: 1000 });

    // ---- Settings
    const panes = [
      ['stats', 'Statistics', 'What this player has played: totals, top songs and when.'],
      ['rec', 'Recommendations', 'The recommendation algorithm and how it weighs what you play.'],
      ['src', 'Sources', 'Music on this device, the companion app (connected) and the hub.'],
      ['player', 'Player', 'Appearance, listening and the disc — how it spins and turns — with its live preview.'],
      ['eq', 'Equalizer', 'Presets, the curve and the default volume.'],
    ];
    for (const [pane, title, note] of panes) {
      await hash(`#settings/${pane}`, pane === 'player' ? 2500 : 1500);
      await snap({ id: `settings-${pane}`, title: `Settings ▸ ${title}`, group: 'Settings', note });
    }
    await hash('#settings/src');
    await page.fill('#cfgHub', fixtures.hubBase);
    await click('#hubTest', { ms: 1500 });
    await snap({ id: 'settings-src-hub', title: 'Settings ▸ Sources (hub tested)', group: 'Settings', note: 'The hub’s address typed and tested: its name, version, checks and fingerprint.' });
  },
};
