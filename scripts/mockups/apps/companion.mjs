/**
 * Airwave Companion's window (windows-companion/src/renderer), built by its own Vite config and run
 * in Chrome with the preload bridge stood in for: every `window.companion.invoke(channel)` is
 * answered from scripts/mockups/fixtures/companion.mjs, checked against the IPC contract. Events
 * never arrive, and a channel that would act on the PC is not answered (the build names it).
 */
import { viteBuild } from '../lib/browser.mjs';
import manifest from '../../../design/manifest.json' with { type: 'json' };
import { importedStylesheets } from './hub.mjs';
import { answers, now } from '../fixtures/companion.mjs';
import { IPC } from '../../../windows-companion/src/shared/ipc.ts';

const ORIGIN = 'http://127.0.0.1:47920';
const TABS = ['library', 'live-tv', 'remote', 'settings'];
const ALL = [...TABS, 'settings-backup', 'library-remove-folder'];

/** The preload bridge, as the page sees it: each call is a request the mockup's router answers. */
const BRIDGE = `(() => {
  window.companion = {
    invoke(channel, request) {
      return fetch('/__ipc/' + channel, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request === undefined ? null : request) })
        .then((r) => (r.ok ? r.json() : r.json().then((p) => Promise.reject(new Error(p.message)))));
    },
    on() { return () => undefined; },
  };
})();`;

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
      library: 'Folders by kind (music, saved TV, movies) with Add Folder…, then the music the companion found, with its search.',
      'live-tv': 'Channel playlists (M3U) and programme guides (XMLTV), each checked and kept, with what each holds.',
      remote: 'Streaming to your devices (pairing code, paired devices, last seen, network modes), the hub connection, and transfers.',
      settings: 'Downloaders (check and update), General, Downloads, Network; Backup; About (cache, logs, update check).',
    };
    for (const id of TABS) {
      if (id !== 'library') await click(`#companion-tab-${id}`, { ms: 1200 });
      await snap({ id, title: id === 'live-tv' ? 'Live TV' : id[0].toUpperCase() + id.slice(1), group: 'Tools', note: notes[id] });
    }
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
