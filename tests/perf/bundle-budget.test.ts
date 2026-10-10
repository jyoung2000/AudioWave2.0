/**
 * Performance budgets for what a browser has to download before anything works.
 *
 * These are measured from the built output, not guessed: the entry script and stylesheet that
 * `index.html` actually references, plus everything the page eagerly preloads. Lazily-imported
 * chunks are excluded on purpose — that is the whole point of splitting them — but the test also
 * checks that the *expensive* ones really did stay out of the entry, because a budget that only
 * counts bytes is passed by moving code around rather than by loading less of it.
 *
 * The budgets are deliberately close to the current numbers. A budget with slack is a budget nobody
 * notices breaking; when a change genuinely needs more, raising the number here is a decision
 * someone makes on purpose, in a diff, with a reason.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Bundle {
  name: string;
  distDir: string;
  html: string;
  /** Budget for what loads before first paint, in KB. */
  entryBudgetKb: number;
  /** Budget for everything the build emitted, in KB. */
  totalBudgetKb: number;
  /** Substrings that must not appear in the entry chunk: expensive things that must stay split. */
  mustBeSplit: string[];
}

const BUNDLES: Bundle[] = [
  {
    name: 'music-player',
    distDir: join(repoRoot, 'music-player', 'dist'),
    html: 'index.html',
    /*
     * The player is offline-first: this is what someone downloads on a phone before the first note.
     * The headroom is small on purpose (see the note at the top). It rose from 613KB with the
     * service worker registration, the two-deck crossfade engine and the module that keeps copies
     * of chosen files; the worker for that lives inline as a blob.
     *
     * Then from 637 to 644KB with the platform marks. Every row in the library draws one, so the
     * registry and its ten glyphs are in the first load by definition — there is no lazy version of
     * something on the first painted screen. The capability table and the .zip reader that came
     * with them are *not*: the table travels with Settings and the unpacker is fetched only when
     * someone imports an archive, which is why `lib/audio-files.ts` exists — importing one function
     * from the scanner used to pin the whole scanner into a shared chunk.
     *
     * Then from 656 to 658KB with the profile, invite and backup-space contracts. The route table
     * is one object and the hub client reads it at start-up, so a new route is in the first load
     * whether or not its pane is ever opened; what it costs is its schema and its summary string,
     * about 1KB for the nineteen added here.
     *
     * Then *down* from 658 to 240KB when the Airwave frontend became the shell. The first load is
     * now the bridge — db, library, the playback engine, the hub client and the crossfade rules —
     * at about 230KB; the interface itself is inline in the HTML and counted in the total below. The
     * number is lowered to what was measured because a budget with 400KB of slack defends nothing.
     *
     * And to 241 for the disc's motion and its preview in Settings (NP-PREF-014): the shell's inline
     * stage module is bundled into this entry, and the rates, the held angle and tilt, and the preview
     * that renders a copy of the disc while it is on screen are about 1KB of it, minified. three.js
     * itself stays behind the dynamic import.
     *
     * And to 248 for the music catalog's contracts (DEC-039, 2026-10-06): nine hub routes in the route
     * table the hub client reads at start-up, with their schemas — tracks, artists, albums, the NDJSON
     * chunks, collections, resolve, lyrics, enrichment and settings — measured, 7 KB minified.
     *
     * And to 249 for the catalog search's loader (NP-FIND-003, 2026-10-06): the bridge's dynamic import
     * of src/shell/search and the few lines that keep an Enter pressed before it lands — measured, under
     * 1 KB (248.6 KB, which rounds up). The search itself is a lazy chunk, fetched after the shell runs.
     *
     * And to 258 for the recommendation ranker (NP-DISC-001, 2026-10-07): src/shell/recommend/rank.ts —
     * the factors, penalties, familiarity mix, artist cap, seeded exploration, the one-line description
     * and the colour arithmetic — published by the bridge as window.NP_RECOMMEND, plus the five fields a
     * row now carries for it. Eager on purpose: Discover is one click from the first screen and must
     * rank the moment it opens, and the Settings preview ranks through the same call. Measured, 9 KB.
     *
     * And to 260 for a visitor's preview and a fetched file kept (NP-FIND-011/012, 2026-10-10): the
     * bridge's playPreview (a clip through the same engine) and tools.keep (the hub's file indexed as a
     * copy) — measured, 259.0 KB (265,222 bytes: the entry 103,971, the shared chunk 154,951, the small
     * chunks 6,300). The catalog set, its look-ahead and the hub's download stay in the lazy search chunk.
     *
     * And to 263 for the playlist folders' contracts (DEC-041, 2026-10-10): the contracts barrel the
     * entry imports now carries packages/contracts/src/api/playlist-folder.ts — the summary, entry,
     * page, folder and sidecar schemas a player will use to file into hub playlists — measured, 4.7 KB
     * minified (esbuild, zod external). The route table's new entries are not in the entry.
     */
    entryBudgetKb: 263,
    /*
     * The total rose from 1600 to 1900 when the hero gained the reference's jewel case.
     *
     * The case needs parts of Three.js the constellation never touched — physical materials, the
     * PMREM environment generator, area lights — and that took the Three chunk from about 640KB to
     * 988KB. It is a real cost and it is recorded here rather than absorbed quietly; what keeps it
     * honest is that none of it is in the first load. It arrives at idle, after the page has
     * painted, and only for people whose browser can draw it.
     */
    /*
     * And from 1920 to 2150 when the player learned to recommend and to
     * export. The recommender is about 145 KB and the FLAC and WAV encoders
     * about 150 KB with the worker they are inlined into.
     *
     * Both are deliberately outside the first load: the recommender is
     * fetched when a queue runs out or someone asks for something similar,
     * and the encoders travel with the download sheet. Someone who opens the
     * player and presses play downloads neither. That is the line worth
     * defending, and the entry budget above is what defends it — this number
     * only records what the app weighs in total.
     *
     * And from 2150 to 2180 for the local helper's client and the sheet that asks what entitles you
     * to a file. Both are behind a dynamic import and neither is reachable without a helper running,
     * so the entry above is unmoved — which is the number that was defended, and still is.
     *
     * And from 2180 to 2320 when the Airwave frontend became the shell. The shell is one HTML file
     * of about 900 KB — its styles and its application script are inline, as the file was written —
     * and this count includes the HTML. What left with it was the React interface's entry (the
     * views, the components, aqua-ui's stylesheet), which is why the first load *fell*: the entry is
     * now the bridge alone at about 230 KB. The shell is read once and cached by the service worker;
     * three.js stays behind a dynamic import inside it, as it did before.
     *
     * And from 2320 to 2322 for the fetch sheet in the shell (the Download key made real) and the
     * bridge's write journal and tools seam — measured, about 2 KB, none of it in the first load.
     *
     * And to 2324 for the shell's touch layer (this repo's 12px text and 44px targets on a coarse
     * pointer) and "Now Playing" in place of the mockup's name — measured, 2 KB, all of it CSS and
     * copy inside the HTML.
     *
     * And to 2372 for streaming from a PC (docs/AWSP.md §6): the dedicated worker that hosts the
     * iroh client (31 KB of wasm-bindgen glue and policy), the page's side of it (7 KB), the service
     * worker's range bridge (5 KB) and the Sources card in the shell (5 KB) — measured, 48 KB. The
     * client itself is a 2.3 MB `.wasm`, which this count does not include (it counts scripts,
     * stylesheets and HTML) and which is fetched only by someone who pairs with a PC: the worker is
     * started on first use, the page's side is a lazy chunk, and the entry above moved by under 1 KB
     * (the check that a row is remote and the dynamic import), staying inside 240.
     *
     * And to 2374 for enrichment (docs/PROVIDER_CAPABILITIES.md, Enrichment): the contract fields a
     * track now carries (album, featured artists, genre profile, tempo and where it came from) and
     * three metadata-only rows in the platform table — measured, 2 KB, none of it in the first load.
     *
     * And to 2383 for the listing that can be heard (NP-FIND-001): the paired hub leg in the
     * search module, the hold-to-arm ring and its styles, the genre chip, and the late-tempo
     * bridge into the library — measured, 9 KB, all inside the shell's HTML and none of it new
     * network or first-load script.
     *
     * And to 2385 for that listing's review fixes: the URL-scheme guard on hub metadata, the
     * clip-switch handoff that keeps the main track aside, and the steadier hold — measured,
     * 1 KB of the same inline shell script.
     *
     * And to 2397 for round 3 (2026-09-27): the song on the air and the station menu that keeps
     * it (NP-RADIO-001/002 — ICY through the hub or the companion, the On air section, kept songs,
     * long-press on touch, menus with several submenus) and the "setting up" state of the
     * companion's downloaders (UX-SETUP-001) — measured, 12 KB, all inline shell script in both
     * the shell and the single-file build, none of it new network or first-load script.
     *
     * And to 2401 for Live TV from the companion (NP-TV-001, 2026-10-03): reading the companion's
     * channels and guide and showing now and next — measured, 3 KB of inline shell script, counted
     * in both the shell and the single-file build; the entry is unchanged.
     *
     * And to 2403 for Live TV from the paired hub (the hub keeps the companion's copy, so a player
     * away from the companion's PC still gets channels) — measured, 2 KB of inline shell script.
     *
     * And to 2409 for pasted links read by the companion (NP-FIND-002, 2026-10-04): the resolve
     * step beside the hub/oEmbed chain, a playlist's songs as rows with their count and cap, the
     * per-entry lookup and the date on the details line — measured, 5 KB of inline shell script —
     * plus the full release date the library indexer reads (UX-DL-001: `releaseDateOf` and the
     * contract's `releaseDate`, in the lazily loaded scanner chunk) — 1 KB. The entry is unmoved.
     *
     * And to 2410 when the hub's download batches merged in (2026-10-04): the contracts the player
     * bundles gained `DownloadTags` and `DownloadBatchRef` on a download's source — measured, 1 KB.
     *
     * And to 2411 for asking the hub alongside the rest rather than first, with a longer wait for
     * Spotify links (spotDL takes 20-50 s) — measured, under 1 KB of inline shell script.
     *
     * And to 2417 for the disc's motion (NP-PREF-014): Settings ▸ Player ▸ The disc — spin and turn,
     * their speeds, a held facing, the song's tempo — and the stage reading the preferences when it
     * starts after they were announced — measured, 6 KB of inline shell markup and script, counted in
     * both the shell and the single-file build. The entry is unchanged.
     *
     * And to 2423 for the disc's angle, tilt, Reset Position and live preview (NP-PREF-014) —
     * measured, 6 KB of inline markup and script, counted in both builds; the entry's 1 KB is above.
     *
     * And to 2430 for the music catalog's contracts (DEC-039) — the entry's 7 KB above, nothing else.
     *
     * And to 2505 for the catalog search (NP-FIND-001..008, 2026-10-06): the lazy search chunk is
     * 102 KB — the popover's views, the hub/helper client and, for a player with neither, the catalog
     * engine itself (iTunes, Deezer, MusicBrainz, LRCLIB parsers, the merger, the NDJSON reader) — while
     * the shell's HTML lost the old inline search (29 KB less, after the new styles and markup it
     * gained). Measured: 2505 KB. None of it is in the first load.
     *
     * And to 2508 for that search's second and third rounds (owner, 2026-10-06): the results pager that
     * fetches later pages, whole-list loading with its progress in the music list, and the engine's
     * merger applied across chunks and pages — measured, 3 KB, in the lazy chunk and the shell's HTML.
     *
     * And to 2516 after merging the engine's whole-list paging and one-row merge (DEC-039, 2026-10-06):
     * the lazy search chunk carries the engine, so its new paging, merge and view helpers grew it from
     * 104 to 112 KB — measured. The entry is unchanged (249).
     *
     * And to 2536 for the redrawn search (NP-FIND-003..010, 2026-10-07): the overview, the one-type
     * pages with their arrows and scroll paging, the Playlists section and the row menu grew the
     * lazy search chunk from 112 to 121 KB — measured. The entry is unchanged (250).
     *
     * And to 2543 for every result carrying its facts (UX-CAT-006, 2026-10-07): the lazy search chunk
     * — which carries the engine for a player with neither hub nor companion — gains the page
     * hydration (Deezer detail by id, ISRC and name; the Cover Art Archive; the pool and the
     * filling), the credit line and the E mark, on top of the redrawn search's type pages, playlists
     * and row menu that landed since the last measure: 112 → 129 KB. Measured: 2543 KB in all. The
     * entry is unchanged (249).
     *
     * And to 2575 for Discover ranked by the chosen algorithm (NP-DISC-001..005, 2026-10-07): the
     * ranker in the entry (the 9 KB above) and, inline in the shell's HTML, Discover's paging and
     * refresh, the algorithm chip and its menu, the lean, the colour swatch, picker and legend, and
     * their styles — measured, 23 KB of markup, script and CSS. Nothing new is fetched lazily; the
     * search chunk is unchanged.
     *
     * And to 2615 for Discover's catalog set, its look-ahead, a visitor's preview and the hub's
     * download (NP-DISC-006/007, NP-FIND-011/012, 2026-10-10): the lazy search chunk gains the
     * online candidates, the look-ahead planner and runner, and the visit/fetch routes (now 144,493
     * bytes), and the shell's HTML the catalog set's heading, marks and toggle, the preview label and
     * the route-aware fetch sheet (now 948,028 bytes) — measured, 2609 KB in all, 34 KB more.
     *
     * Plus the playlist folders' contracts (DEC-041, 2026-10-10): the 5 KB in the entry above, and the
     * folder-playlist words in @now-playing/domain/catalog that the lazy search chunk carries —
     * measured on their own, under 1 KB (0.7 KB minified). The combined figure is measured below.
     *
     * And to 2650 for the hub's shelf from the player (DEC-041; NP-FIND-008/013/014, 2026-10-10):
     * filing into the hub's playlists, a hub playlist in the music list and the starred-list sync
     * (search/hub-shelf.ts) in the lazy search chunk (now 161,166 bytes, 16.7 KB more), and in the
     * shell's HTML the "On this player" / "On <hub>" groups, the bar's "…", the library menu's hub
     * levels and the sync hooks (now 954,215 bytes, 6 KB more) — measured, 2635 KB in all. The entry
     * is unchanged.
     */
    totalBudgetKb: 2650,
    // Three.js belongs to the constellation and the jewel case; the tag reader only to a scan.
    mustBeSplit: ['three', 'music-metadata'],
  },
  {
    name: 'hub-admin',
    distDir: join(repoRoot, 'docker-container', 'dist', 'web'),
    html: 'index.html',
    // The admin GUI is one screen behind a login; Search is the one lazy chunk.
    entryBudgetKb: 560,
    // Measured 2026-10-09 (UX-SEARCH-007…012, DEC-040): 589KB in all — the entry 545KB (index JS
    // 515KB, CSS 30KB, HTML 1KB, unchanged by the search) and the lazy Search chunk 43KB (13.7KB
    // gzipped), which grew by about 14KB with a type's own page, Playlists and a song's menu. The
    // first load is unchanged and still under its 560KB budget; the total moves from 580KB to 600KB
    // for the chunk that loads only when Search is opened.
    // Measured 2026-10-10 (DEC-041, Music ▸ Playlists and Add to Playlist ▸): 614KB in all. Playlists is
    // a second lazy chunk (14KB, with a 4KB client shared with Search), and the catalog code both
    // share moved out of the entry into a shared lazy chunk (231KB), so the entry fell to 336KB
    // (index JS 304KB, CSS 31KB, HTML 1KB); Search grew by under 1KB. The total moves to 615KB.
    totalBudgetKb: 615,
    mustBeSplit: [],
  },
];

/** The files `index.html` pulls in before the app can render: scripts, stylesheets and preloads. */
function entryAssets(distDir: string, htmlName: string): string[] {
  const html = readFileSync(join(distDir, htmlName), 'utf8');
  const hrefs = new Set<string>();
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) hrefs.add(match[1]!);
  for (const match of html.matchAll(/<link[^>]+rel="(?:stylesheet|modulepreload|preload)"[^>]+href="([^"]+)"/g)) hrefs.add(match[1]!);
  for (const match of html.matchAll(/<link[^>]+href="([^"]+)"[^>]+rel="(?:stylesheet|modulepreload|preload)"/g)) hrefs.add(match[1]!);
  return [...hrefs].filter((href) => href.endsWith('.js') || href.endsWith('.css')).map((href) => join(distDir, href.replace(/^\/+/, '').replace(/^\.\//, '')));
}

function kb(bytes: number): number {
  return Math.round(bytes / 1024);
}

function emittedBytes(distDir: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // Source maps are never downloaded by a normal visitor, so they do not count.
      else if (/\.(js|css|html)$/.test(entry.name)) total += statSync(full).size;
    }
  };
  walk(distDir);
  return total;
}

describe.each(BUNDLES)('$name', (bundle) => {
  const built = existsSync(join(bundle.distDir, bundle.html));

  it('has been built (run `pnpm build` first — this gate measures real output, it does not estimate)', () => {
    expect(built, `${bundle.distDir} has no ${bundle.html}`).toBe(true);
  });

  it.runIf(built)('keeps the first load inside its budget', () => {
    const assets = entryAssets(bundle.distDir, bundle.html);
    expect(assets.length, 'index.html referenced no scripts or stylesheets').toBeGreaterThan(0);
    const total = assets.reduce((sum, path) => sum + statSync(path).size, 0);
    // The message carries the numbers, so a failure says what to do rather than only that it broke.
    expect(kb(total), `first load is ${kb(total)}KB against a ${bundle.entryBudgetKb}KB budget (${assets.map((a) => `${a.split('/').pop()} ${kb(statSync(a).size)}KB`).join(', ')})`).toBeLessThanOrEqual(bundle.entryBudgetKb);
  });

  it.runIf(built)('keeps everything it emits inside its budget', () => {
    const total = emittedBytes(bundle.distDir);
    expect(kb(total), `the build emits ${kb(total)}KB against a ${bundle.totalBudgetKb}KB budget`).toBeLessThanOrEqual(bundle.totalBudgetKb);
  });

  it.runIf(built && bundle.mustBeSplit.length > 0)('keeps the expensive dependencies out of the first load', () => {
    const entry = entryAssets(bundle.distDir, bundle.html)
      .filter((path) => path.endsWith('.js'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    for (const marker of bundle.mustBeSplit) {
      // A crude but effective check: these libraries all leave unmistakable strings behind.
      const signature = marker === 'three' ? /THREE\.WebGLRenderer|BufferGeometry/ : /music-metadata|ID3v2Parser/;
      expect(signature.test(entry), `${marker} is in the entry chunk; it must stay behind a dynamic import`).toBe(false);
    }
  });
});
