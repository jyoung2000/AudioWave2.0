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

const ORIGIN = recording.base;
const TABS = ['overview', 'devices', 'music', 'groups', 'sharing', 'system'];
const SIGNED_IN = [...TABS, 'groups-kitchen', 'devices-pairing'];

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
      music: 'Library folders (scan each), Providers, Downloads, Live TV from the companion, Recommendations.',
      groups: 'Listening together: groups, their invites and members.',
      sharing: 'Shared links (make one for a playlist or an album) and the Discord bot.',
      system: 'Network, Backup (folder, parts, schedule, archives) and Diagnostics (log, support bundle).',
    };
    for (const id of TABS) {
      if (id !== 'overview') await tab(id);
      await snap({ id, title: id[0].toUpperCase() + id.slice(1), group: 'Signed in', note: notes[id], settle: 800 });
    }
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
