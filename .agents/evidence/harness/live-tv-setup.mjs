#!/usr/bin/env node
/**
 * Adds an M3U playlist and an XMLTV guide to the companion's Live TV tab, through its own UI,
 * and reads back what it stored. Both sources are openly published and free-to-air:
 *   - the playlist: iptv-org's UK list (https://iptv-org.github.io/iptv/countries/uk.m3u)
 *   - the guide:    epg.pw's FREE public UK XMLTV guide (https://epg.pw/xmltv/epg_GB.xml.gz)
 * Neither is a paid or private IPTV list.
 *
 *   node .agents/evidence/harness/live-tv-setup.mjs <m3uUrl> <xmltvUrl>
 */
import { _electron as electron } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.NP_SCRATCH;
const CLONE = process.env.NP_CLONE;
const m3uUrl = process.argv[2];
const xmltvUrl = process.argv[3];
if (!SCRATCH || !CLONE || !m3uUrl || !xmltvUrl) {
  console.error('usage: node .agents/evidence/harness/live-tv-setup.mjs <m3uUrl> <xmltvUrl>   (NP_SCRATCH, NP_CLONE set)');
  process.exit(2);
}
const EVIDENCE = join(SCRATCH, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });

const root = join(CLONE, 'windows-companion', 'release', 'win-unpacked');
if (!existsSync(join(root, 'Airwave Companion.exe'))) {
  console.error('No packaged companion');
  process.exit(3);
}

const app = await electron.launch({
  executablePath: join(root, 'Airwave Companion.exe'),
  env: {
    ...process.env,
    PORTABLE_EXECUTABLE_DIR: SCRATCH,
    NP_DATA_DIR: join(SCRATCH, 'hub'),
    NP_HELPER_PORT: process.env.NP_HELPER_PORT ?? '17342',
  },
});
console.log(`COMPANION_PID=${app.process().pid}`);
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.getByRole('tab', { name: 'Live TV', exact: false }).first().click({ timeout: 20_000 });
await win.waitForTimeout(800);

/** The tab renders one <fieldset> per source kind, each with a <legend> naming it. */
async function addSource(legendText, url) {
  const fieldset = win.locator('fieldset').filter({ has: win.locator('legend', { hasText: legendText }) }).first();
  await fieldset.waitFor({ timeout: 15_000 });
  const field = fieldset.locator('input').first();
  await field.fill(url);
  await fieldset.getByRole('button', { name: 'Add', exact: true }).first().click();
  // The link is fetched and checked, so this is not instant.
  await win.waitForTimeout(4000);
  const text = (await fieldset.innerText()).replace(/\s+/g, ' ').trim();
  console.log(`--- after adding ${legendText}:\n${text.slice(0, 600)}\n`);
  return text;
}

const afterM3u = await addSource('Channel playlists', m3uUrl);
const afterXmltv = await addSource('Programme guides', xmltvUrl);

await win.screenshot({ path: join(EVIDENCE, '22-livetv-sources-added.png') });
console.log('screenshot: evidence/22-livetv-sources-added.png');

// What the companion actually stored, read off disk rather than off pixels.
const storeDir = join(SCRATCH, 'NowPlayingCompanion-data');
for (const rel of ['live-tv', 'helper/live-tv', 'helper']) {
  const dir = join(storeDir, rel);
  if (!existsSync(dir)) continue;
  console.log(`\n### ${rel}`);
  for (const f of ['channels.json', 'playlists.json', 'guides.json', 'live-tv.json', 'live-tv']) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    console.log(`${f}: ${readFileSync(p, 'utf8').slice(0, 600)}`);
  }
}
await app.close();