/**
 * Airwave Companion's window (windows-companion/src/renderer), built by its own Vite config and run
 * in Chrome with the preload bridge stood in for: every `window.companion.invoke(channel)` is
 * answered from scripts/mockups/fixtures/companion.mjs, checked against the IPC contract, and a
 * channel that would act on the PC is not answered (the build names it). The one event that arrives
 * is a search's `event:catalog-chunk`: the catalog channels answer from stock
 * (scripts/mockups/lib/stock-catalog.mjs), and a search's answer carries its chunks, which the stand-in
 * bridge hands to the window's listeners before it resolves, as the main process would.
 */
import { viteBuild } from '../lib/browser.mjs';
import manifest from '../../../design/manifest.json' with { type: 'json' };
import { importedStylesheets } from './hub.mjs';
import { answers, now } from '../fixtures/companion.mjs';
import { IPC, IPC_EVENTS } from '../../../windows-companion/src/shared/ipc.ts';
import { CATALOG_STOCK, resolveAnswer, searchChunks } from '../lib/stock-catalog.mjs';

const ORIGIN = 'http://127.0.0.1:47920';
const TABS = ['library', 'search', 'live-tv', 'remote', 'settings'];
const SEARCH = ['search-results', 'search-row-menu', 'search-filter', 'search-song', 'search-see-all', 'search-playlists', 'search-link', 'search-playlist'];
const ALL = [...TABS, 'settings-backup', 'library-remove-folder', ...SEARCH];

/** The preload bridge, as the page sees it: each call is a request the mockup's router answers. */
const BRIDGE = `(() => {
  const listeners = {};
  window.companion = {
    invoke(channel, request) {
      return fetch('/__ipc/' + channel, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request === undefined ? null : request) })
        .then((r) => (r.ok ? r.json() : r.json().then((p) => Promise.reject(new Error(p.message)))))
        .then((answer) => {
          if (!answer || !Array.isArray(answer.__events)) return answer;
          for (const e of answer.__events) for (const listener of listeners[e.event] || []) listener(e.payload);
          return answer.value;
        });
    },
    on(event, listener) {
      (listeners[event] = listeners[event] || new Set()).add(listener);
      return () => listeners[event].delete(listener);
    },
  };
})();`;

/** The catalog channels, from stock: a search answers with its chunks as events, a link with what it is. */
function catalogAnswer(channel, request) {
  const parse = (value) => IPC[channel].response.parse(value);
  if (channel === 'catalog:search') {
    const events = searchChunks(request.q ?? '', request.offset ?? 0).map((chunk) => ({ event: 'event:catalog-chunk', payload: IPC_EVENTS['event:catalog-chunk'].parse({ searchId: request.searchId, chunk }) }));
    return { __events: events, value: parse({ reason: null }) };
  }
  if (channel === 'catalog:resolve') return parse({ result: resolveAnswer(request.url), reason: null });
  return undefined;
}

/** Each answer as the main process would send it: parsed by its contract, defaults filled in. */
function checked() {
  const out = {};
  for (const [channel, value] of Object.entries(answers)) {
    const spec = IPC[channel];
    if (!spec) throw new Error(`companion fixture: ${channel} is not an IPC channel`);
    const parsed = spec.response.safeParse(value);
    if (!parsed.success) throw new Error(`companion fixture: ${channel} does not match its contract: ${parsed.error.message.slice(0, 600)}`);
    out[channel] = parsed.data;
  }
  return out;
}

const LINKS = [
  ...TABS.map((tab) => ({ selector: `#companion-tab-${tab}`, to: tab, in: ALL })),
  { selector: '#folders button[aria-label^="Remove "]', to: 'library-remove-folder', in: ['library'] },
  { selector: 'dialog.sheet button', to: 'library', in: ['library-remove-folder'] },
  // Search (DEC-039, UX-SEARCH-007…012): the calm overview, a song row's menu, the filter sheet, a song, a
  // type's own page (Songs) and the Playlists page, a pasted playlist and the list it opens.
  { selector: '.srch__bar button[type="submit"]', to: 'search-results', in: ['search'] },
  { selector: '[role="listbox"][aria-label="Songs"] [data-menu]', to: 'search-row-menu', in: ['search-results'] },
  { selector: '.srch__bar button.push', text: 'Filter', to: 'search-filter', in: ['search-results'] },
  { selector: 'dialog.sheet--form .sheet__acts button', to: 'search-results', in: ['search-filter'] },
  { selector: '[role="listbox"][aria-label="Songs"] li', to: 'search-song', in: ['search-results'] },
  { selector: '.srch__seeall button', text: 'songs', to: 'search-see-all', in: ['search-results'] },
  { selector: '.srch__seeall button', text: 'playlists', to: 'search-playlists', in: ['search-results'] },
  { selector: '.srch__seg button', text: 'Playlists', to: 'search-playlists', in: ['search-see-all'] },
  { selector: '.srch__seg button', text: 'Songs', to: 'search-see-all', in: ['search-playlists'] },
  { selector: '.srch__nav button', to: 'search-results', in: ['search-song', 'search-see-all', 'search-playlists'] },
  { selector: '[role="listbox"][aria-label="The playlist"] li', to: 'search-playlist', in: ['search-link'] },
  { selector: '.srch__nav button', to: 'search-link', in: ['search-playlist'] },
];

export default {
  id: 'companion',
  title: 'Airwave Companion',
  file: 'airwave-companion.html',
  from: 'windows-companion/src/renderer (its views, window kit and styles.css) with packages/aqua-ui/src/styles/airwave-window.css and aqua-art.ts, built by windows-companion/src/renderer/vite.config.ts; the main process answered from scripts/mockups/fixtures/companion.mjs.',
  // What it is made from, for its stamp: design/manifest.json, mockups.files.companion.inputs.
  inputs: manifest.mockups.files.companion.inputs,
  viewport: { width: 640, height: 760 },
  locale: 'en-GB',
  timezoneId: 'UTC',
  unanswered: [],
  expectedErrors: [],
  links: LINKS,

  async prepare() {
    const dist = await viteBuild({ configFile: 'windows-companion/src/renderer/vite.config.ts', label: 'companion' });
    const table = checked();
    return {
      dist,
      origin: ORIGIN,
      now,
      init: [BRIDGE],
      routes: async (route, url) => {
        if (url.origin !== ORIGIN || !url.pathname.startsWith('/__ipc/')) return false;
        const channel = decodeURIComponent(url.pathname.slice('/__ipc/'.length));
        const live = catalogAnswer(channel, route.request().postDataJSON() ?? {});
        if (live !== undefined) {
          await route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(live) });
          return true;
        }
        if (!(channel in table)) return false;
        await route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(table[channel]) });
        return true;
      },
    };
  },

  stylesheets() {
    return importedStylesheets('windows-companion/src/renderer/main.tsx');
  },

  async run({ page, until, click, settle, snap, origin }) {
    await page.goto(`${origin}/`);
    await until(() => Boolean(document.getElementById('companion-tab-library')), undefined, { what: 'the window' });
    await settle(1500);
    const notes = {
      search: 'Search before anything is asked: the field, Track/Artist/Album, Filter….',
      library: 'Folders by kind (music, saved TV, movies) with Add Folder…, then the music the companion found, with its search.',
      'live-tv': 'Channel playlists (M3U) and programme guides (XMLTV), each checked and kept, with what each holds.',
      remote: 'Streaming to your devices (pairing code, paired devices, last seen, network modes), the hub connection, and transfers.',
      settings: 'Downloaders (check and update), General, Downloads, Network; Backup; About (cache, logs, update check).',
    };
    for (const id of TABS) {
      if (id !== 'library') await click(`#companion-tab-${id}`, { ms: 1200 });
      await snap({ id, title: id === 'live-tv' ? 'Live TV' : id[0].toUpperCase() + id.slice(1), group: 'Tools', note: notes[id] });
    }

    // Search (DEC-039), answered from stock through the stand-in bridge.
    await click('#companion-tab-search', { ms: 1000 });
    await page.fill('input[aria-label="Search for music"]', CATALOG_STOCK.query);
    await click('.srch__bar button[type="submit"]', { ms: 1500 });
    await until(() => [...document.querySelectorAll('.srch [role="status"]')].some((s) => /^Done/.test(s.textContent ?? '')), undefined, { what: 'the search results' });
    await snap({ id: 'search-results', title: 'Search ▸ Results', group: 'Search', note: 'The calm overview: five songs, three artists, albums and playlists, each with “See all N”, and no pager; each row with its platforms, credit line (“feat. …” when a store lists a contributor), BPM, time, the explicit mark, preview and its “…”; every service’s state on one line under them, and the platforms that only gave links.' });
    // A song row's menu (UX-SEARCH-012): the companion has no queue, so Up Next is the paired hub's group.
    await click('[role="listbox"][aria-label="Songs"] [data-menu]', { ms: 800 });
    await until(() => Boolean(document.querySelector('.menu .menu__item')) && /Kitchen/.test(document.querySelector('.menu')?.textContent ?? ''), undefined, { what: 'the row menu with the hub’s group' });
    await snap({ id: 'search-row-menu', title: 'Search ▸ A song’s menu', group: 'Search', note: 'A song row’s “…” (or a right-click, or Shift+F10): Add to Up Next (the paired hub’s group: the companion has no queue of its own), Add to Playlist… (it keeps none, so this PC’s library, said in its sheet), Add to Library…, Download…, Audition and Open Details.', dismiss: 'search-results', dismissOutside: '.menu' });
    await page.keyboard.press('Escape');
    await settle(400);
    await click('.srch__bar button.push:has-text("Filter")', { ms: 600 });
    await snap({ id: 'search-filter', title: 'Search ▸ Filter (sheet)', group: 'Search', note: 'Which sections are shown and which services are asked, kept on this PC.', dismiss: 'search-results', dismissOutside: '.sheet' });
    await page.keyboard.press('Escape');
    await settle(400);
    await click('[role="listbox"][aria-label="Songs"] li', { ms: 1500 });
    await until(() => Boolean(document.querySelector('.lyrics')), undefined, { what: 'the song' });
    await snap({ id: 'search-song', title: 'Search ▸ A song', group: 'Search', note: 'Genre, label and year, synced lyrics, the preview, and Download to this PC through the helper.' });
    await click('.srch__nav button', { ms: 800 });
    // A type's own page (UX-SEARCH-009) and the Playlists page (UX-SEARCH-010).
    await click('.srch__seeall button:has-text("songs")', { ms: 1500 });
    await until(() => document.querySelector('.srch__pageof')?.textContent === 'Page 1 of 2', undefined, { what: 'the Songs page' });
    await snap({ id: 'search-see-all', title: 'Search ▸ Songs (a type’s page)', group: 'Search', note: 'See all: Songs alone, under Back — the count, a field that searches songs only, the Songs · Artists · Albums · Playlists control, the services’ line and the list, which reads on as it scrolls; the footer’s ‹ › and “Page 1 of 2” stay put and land on a page’s first row.' });
    await click('.srch__seg button:has-text("Playlists")', { ms: 1500 });
    await until(() => document.querySelectorAll('[role="listbox"][aria-label="Playlists from the catalog"] li').length === 14, undefined, { what: 'the Playlists page' });
    await snap({ id: 'search-playlists', title: 'Search ▸ Playlists', group: 'Search', note: 'Playlists as a type: the one starred on this PC first, under “In your library”, then Deezer’s public playlists, twelve a page; one opens like an album.' });
    await click('.srch__nav button', { ms: 800 });
    await page.fill('input[aria-label="Search for music"]', CATALOG_STOCK.playlistUrl);
    await click('.srch__bar button[type="submit"]', { ms: 1500 });
    await until(() => Boolean(document.querySelector('[role="listbox"][aria-label="The playlist"]')), undefined, { what: 'the pasted playlist' });
    await snap({ id: 'search-link', title: 'Search ▸ A pasted playlist', group: 'Search', note: 'A Spotify playlist link, read rather than searched: its 2×2 mosaic, its platform and its length.' });
    await click('[role="listbox"][aria-label="The playlist"] li', { ms: 1500 });
    await snap({ id: 'search-playlist', title: 'Search ▸ The playlist, opened', group: 'Search', note: 'Opened like an album: its songs, each playing from YouTube Music through spotDL, and the star (already starred).' });
    await click('#companion-tab-settings', { ms: 1000 });
    await page.evaluate(() => document.getElementById('backup')?.scrollIntoView({ block: 'start' }));
    await settle(400);
    await snap({ id: 'settings-backup', title: 'Settings ▸ Backup and About', group: 'Tools', note: 'The Settings tool scrolled to Backup (folder, parts, schedule, archives) and About.' });

    await click('#companion-tab-library', { ms: 1000 });
    const remove = page.getByRole('button', { name: 'Remove D:\\TV', exact: true }).first();
    if (await remove.count()) {
      await remove.click({ force: true });
      await settle(600);
      await snap({ id: 'library-remove-folder', title: 'Library ▸ Remove a folder (sheet)', group: 'Tools', note: 'Removing asks first, in a sheet: the files stay where they are.', dismiss: 'library', dismissOutside: '.sheet' });
    }
  },
};
