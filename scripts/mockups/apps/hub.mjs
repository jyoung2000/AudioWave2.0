/**
 * Airwave Hub's admin window (docker-container/src/web), built by its own Vite config and run
 * against what a real hub told it (scripts/mockups/fixtures/hub.json, written by record-hub.mjs):
 * signed out, at the first-run gate, and set up with a library, two paired devices, groups, a
 * shared album and a backup schedule. Anything the window would change is refused with a sentence,
 * the way the window shows any refused action.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT, viteBuild } from '../lib/browser.mjs';
import manifest from '../../../design/manifest.json' with { type: 'json' };
import recording from '../fixtures/hub.json' with { type: 'json' };
import { CATALOG_STOCK, hubCatalogAnswer } from '../lib/stock-catalog.mjs';

const ORIGIN = recording.base;
const TABS = ['overview', 'devices', 'music', 'search', 'groups', 'sharing', 'system'];
const SEARCH = ['search-results', 'search-filter', 'search-song', 'search-album', 'search-link', 'search-playlist'];
const SIGNED_IN = [...TABS, 'groups-kitchen', 'devices-pairing', ...SEARCH];

/** Which recorded phases answer, first match wins. */
const PHASES = {
  'signed-out': ['signed-out'],
  'first-run': ['first-run', 'signed-out'],
  'signed-in': ['signed-in', 'setting-up'],
  pairing: ['pairing', 'signed-in', 'setting-up'],
};

/** The stylesheets a product's main.tsx imports, in the order it imports them, as source files. */
export function importedStylesheets(mainFile) {
  const main = readFileSync(join(ROOT, mainFile), 'utf8');
  const exports = JSON.parse(readFileSync(join(ROOT, 'packages/aqua-ui/package.json'), 'utf8')).exports;
  return [...main.matchAll(/^import\s+'([^']+\.css)';/gm)].map((m) => {
    const spec = m[1];
    const source = spec.startsWith('@now-playing/aqua-ui/') ? join('packages/aqua-ui', exports[`./${spec.slice('@now-playing/aqua-ui/'.length)}`]) : join(dirname(mainFile), spec);
    const path = source.replace(/\\/g, '/');
    return { source: path, css: readFileSync(join(ROOT, path), 'utf8') };
  });
}

const LINKS = [
  ...TABS.map((tab) => ({ selector: `#tab-${tab}`, to: tab, in: SIGNED_IN })),
  { selector: 'form.signin button[type="submit"]', to: 'first-run', in: ['sign-in'] },
  { selector: '.gate button[type="submit"]', to: 'overview', in: ['first-run'] },
  { selector: '.panefoot button.push', to: 'sign-in', in: ['overview'] },
  { selector: 'button[aria-label="Open Kitchen"]', to: 'groups-kitchen', in: ['groups'] },
  { selector: 'button[aria-label="Close Kitchen"]', to: 'groups', in: ['groups-kitchen'] },
  { selector: 'button.push', text: 'Start Pairing', to: 'devices-pairing', in: ['devices'] },
  { selector: 'button[aria-label="Remove Live recordings"]', to: 'music-remove-folder', in: ['music'] },
  { selector: '.sheet__acts button', to: 'music', in: ['music-remove-folder'] },
  // Search (DEC-039): the results, the filter sheet, a song, an album, a pasted playlist and the list it opens.
  { selector: '.srch__bar button[type="submit"]', to: 'search-results', in: ['search'] },
  { selector: '.srch__bar button.push', text: 'Filter', to: 'search-filter', in: ['search-results'] },
  { selector: '.sheet--form .sheet__acts button', to: 'search-results', in: ['search-filter'] },
  { selector: '[role="listbox"][aria-label="Songs"] li', to: 'search-song', in: ['search-results'] },
  { selector: '[role="listbox"][aria-label="Albums"] li', to: 'search-album', in: ['search-results'] },
  { selector: '.srch__nav button', to: 'search-results', in: ['search-song', 'search-album'] },
  { selector: '[role="listbox"][aria-label="The playlist"] li', to: 'search-playlist', in: ['search-link'] },
  { selector: '.srch__nav button', to: 'search-link', in: ['search-playlist'] },
];

export default {
  id: 'hub',
  title: 'Airwave Hub',
  file: 'airwave-hub.html',
  from: 'docker-container/src/web (its views, window kit and styles.css) with packages/aqua-ui/src/styles/airwave-window.css, airwave-hub.css and aqua-art.ts, built by docker-container/src/web/vite.config.ts; data recorded from a real hub (scripts/mockups/fixtures/hub.json).',
  // What it is made from, for its stamp: design/manifest.json, mockups.files.hub.inputs.
  inputs: manifest.mockups.files.hub.inputs,
  viewport: { width: 1280, height: 860 },
  locale: 'en-GB',
  timezoneId: 'UTC',
  unanswered: [],
  expectedErrors: [],
  links: LINKS,

  async prepare() {
    const dist = await viteBuild({ configFile: 'docker-container/src/web/vite.config.ts', label: 'hub' });
    const state = { phase: 'signed-out' };
    // A minute after the recording ended, on the minute: "just now" stays "just now".
    const now = new Date(Math.ceil((Date.parse(recording.recordedAt) + 60_000) / 60_000) * 60_000).toISOString();
    return {
      dist,
      origin: ORIGIN,
      now,
      state,
      routes: async (route, url) => {
        if (url.origin !== ORIGIN || !url.pathname.startsWith('/api/')) return false;
        const method = route.request().method();
        // The catalog is answered from stock, not from the recording (scripts/mockups/lib/stock-catalog.mjs).
        const catalog = hubCatalogAnswer(method, url.pathname, url.searchParams);
        if (catalog) {
          await route.fulfill({ status: catalog.status, headers: { 'content-type': catalog.contentType }, body: catalog.body });
          return true;
        }
        const key = `${method} ${url.pathname}${url.search}`;
        const bare = `${method} ${url.pathname}`;
        for (const phase of PHASES[state.phase]) {
          const answers = recording.phases[phase] ?? {};
          const answer = answers[key] ?? answers[bare] ?? Object.entries(answers).find(([k]) => k.split('?')[0] === bare)?.[1];
          if (answer) {
            await route.fulfill({ status: answer.status, headers: { 'content-type': answer.contentType }, body: typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body) });
            return true;
          }
        }
        if (method !== 'GET' && method !== 'HEAD') {
          await route.fulfill({ status: 503, headers: { 'content-type': 'application/problem+json' }, body: JSON.stringify({ title: 'Mockup', status: 503, detail: 'This window is a mockup, so there is no hub behind it to change.' }) });
          return true;
        }
        return false;
      },
    };
  },

  stylesheets() {
    return importedStylesheets('docker-container/src/web/main.tsx');
  },

  async run({ page, until, click, settle, snap, origin, prepared }) {
    const phase = (name) => {
      prepared.state.phase = name;
    };
    const tab = async (id) => {
      await click(`#tab-${id}`, { ms: 1500 });
    };

    phase('signed-out');
    await page.goto(`${origin}/`);
    await until(() => Boolean(document.getElementById('signin-pass')), undefined, { what: 'the sign-in form' });
    await settle(800);
    await snap({ id: 'sign-in', title: 'Sign in', group: 'Before setup', note: 'Not signed in: the window with its tools locked and the sign-in form in the pane.' });

    phase('first-run');
    await page.fill('#signin-pass', 'admin');
    await click('form.signin button[type="submit"]', { ms: 1500 });
    await until(() => Boolean(document.getElementById('gateH')), undefined, { what: 'the first-run gate' });
    await settle(1000);
    await snap({ id: 'first-run', title: 'First-run gate', group: 'Before setup', note: 'Signed in with the bootstrap admin/admin: the amber gate asks for a real password; the other tools stay locked.' });

    phase('signed-in');
    await page.goto(`${origin}/#overview`);
    await page.reload();
    await until(() => Boolean(document.getElementById('tab-overview')) && !document.getElementById('gateH'), undefined, { what: 'the signed-in window' });
    await settle(1500);
    const notes = {
      overview: 'The hub at a glance: tiles, what needs attention, provider health, this hub, and Sign Out.',
      devices: 'Pair a device (type and permissions), pairing codes, paired devices; and Profiles.',
      music: 'Library folders (scan each), Providers, Music search (services, lyrics in downloads, the SongLink key), Downloads, Live TV from the companion, Recommendations.',
      search: 'Search before anything is asked: the field, Track/Artist/Album, Filter….',
      groups: 'Listening together: groups, their invites and members.',
      sharing: 'Shared links (make one for a playlist or an album) and the Discord bot.',
      system: 'Network, Backup (folder, parts, schedule, archives) and Diagnostics (log, support bundle).',
    };
    for (const id of TABS) {
      if (id !== 'overview') await tab(id);
      await snap({ id, title: id[0].toUpperCase() + id.slice(1), group: 'Signed in', note: notes[id], settle: 800 });
    }
    // Search (DEC-039), answered from stock: the results as every service has answered, the filter,
    // a song, an album, a pasted Spotify playlist and the list it opens with its star.
    const searched = () => /^Done/.test(document.querySelector('.srch [role="status"]')?.textContent ?? '');
    await tab('search');
    await page.fill('input[aria-label="Search for music"]', CATALOG_STOCK.query);
    await click('.srch__bar button[type="submit"]', { ms: 1500 });
    await until(searched, undefined, { what: 'the search results' });
    await snap({ id: 'search-results', title: 'Search ▸ Results', group: 'Search', note: 'Every service’s state on one line (one resting, with when it is back); Songs, Artists and Albums, each row with its platforms, credit line (“feat. …” when a store lists a contributor), BPM, time, the explicit mark and a preview; See All.' });
    await click('.srch__bar button.push:has-text("Filter")', { ms: 600 });
    await snap({ id: 'search-filter', title: 'Search ▸ Filter (sheet)', group: 'Search', note: 'Which sections are shown and which services are asked, kept for this browser.', dismiss: 'search-results', dismissOutside: '.sheet' });
    await page.keyboard.press('Escape');
    await settle(400);
    await click('[role="listbox"][aria-label="Songs"] li', { ms: 1500 });
    await until(() => Boolean(document.querySelector('.lyrics')), undefined, { what: 'the song' });
    await snap({ id: 'search-song', title: 'Search ▸ A song', group: 'Search', note: 'Genre, label and year (MusicBrainz), synced lyrics (LRCLIB), the preview, and Download to this hub with the rights basis.' });
    await click('.srch__nav button', { ms: 800 });
    await click('[role="listbox"][aria-label="Albums"] li:has-text("Harbour Lights")', { ms: 1500 });
    await until(() => Boolean(document.querySelector('[role="listbox"][aria-label^="Songs on"]')), undefined, { what: 'the album' });
    await snap({ id: 'search-album', title: 'Search ▸ An album', group: 'Search', note: 'Cover, label, date and songs, and the star that keeps it in the library.' });
    await click('.srch__nav button', { ms: 800 });
    await page.fill('input[aria-label="Search for music"]', CATALOG_STOCK.playlistUrl);
    await click('.srch__bar button[type="submit"]', { ms: 1500 });
    await until(() => Boolean(document.querySelector('[role="listbox"][aria-label="The playlist"]')), undefined, { what: 'the pasted playlist' });
    await snap({ id: 'search-link', title: 'Search ▸ A pasted playlist', group: 'Search', note: 'A Spotify playlist link, read rather than searched: its 2×2 mosaic, its platform and its length.' });
    await click('[role="listbox"][aria-label="The playlist"] li', { ms: 1500 });
    await snap({ id: 'search-playlist', title: 'Search ▸ The playlist, opened', group: 'Search', note: 'Opened like an album: its songs, each playing from YouTube Music through spotDL, and the star (already starred).' });

    await tab('groups');
    await click('button[aria-label="Open Kitchen"]', { ms: 1500 });
    await snap({ id: 'groups-kitchen', title: 'Groups ▸ Kitchen opened', group: 'Signed in', note: 'One group opened inline: its clock, queue, now playing, members, invites and history.' });

    await tab('music');
    await click('button[aria-label="Remove Live recordings"]', { ms: 600 });
    await snap({ id: 'music-remove-folder', title: 'Music ▸ Remove a folder (sheet)', group: 'Signed in', note: 'A confirmation sheet: it drops from under the toolbar and holds the keyboard until answered.', dismiss: 'music', dismissOutside: '.sheet' });
    await page.keyboard.press('Escape');
    await settle(400);

    phase('pairing');
    await tab('devices');
    await page.locator('button.push', { hasText: 'Start Pairing' }).first().click({ force: true });
    await settle(1500);
    await snap({ id: 'devices-pairing', title: 'Devices ▸ Pairing started', group: 'Signed in', note: 'Start Pairing…: the one-time code, its QR and the hub’s fingerprint, waiting for the device.' });
  },
};
