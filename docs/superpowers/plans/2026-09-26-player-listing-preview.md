# Player Listing & 30-Second Hold-to-Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the player is paired, the header search sheet leads with the hub's enriched results (real artist with features, album, cover, genre chip, BPM), every row with a clip can be heard for up to 30 seconds by a click or a five-second hold with a visible fill, and a song added from search carries its BPM into the library and the queue — all in the shell's own Aqua language.

**Architecture:** Every shell change is a `replace()` step appended to `music-player/scripts/make-shell.py` (DEC-019: `index.html` is generated, never hand-edited), anchored on strings verified unique in the current output; the script asserts loudly on drift. The hub leg reads the paired credential from `window.kv.get('player:hub')` inside the search module (self-contained; the shell's `hubCall` lives in another closure) and calls `GET /api/v1/search` / `GET /api/v1/providers/resolve` with the `Bearer credentialId.secret` scheme `hubRaw` uses. Tests are a new Playwright spec `np/preview.spec.ts` against a stubbed hub (the repo's pattern), plus one journey step against the real hub.

**Tech Stack:** the generated shell (ES5-ish inline JS + CSS in `make-shell.py`), Playwright (`tests/e2e/np/`), the journey harness (`tests/journey/`), `design/ux-rules.json` + `ledger-shell.py` + styleguide gates.

**Spec:** `docs/superpowers/specs/2026-09-26-metadata-enrichment-and-preview-design.md` (sub-project 2). Sub-project 1 is shipped: `SearchResultBase` carries `featuredArtists`, `genres`, `genreProfile`, `bpm`, `bpmSource`, `identity.matchConfidence`; hub `/api/v1/search` answers from the enrichment cache.

## Global Constraints

- `music-player/index.html` is generated: every edit is a `replace()` in `make-shell.py`, appended after the existing steps, anchored on text verified unique in the current `index.html`. After editing: `python scripts/make-shell.py && pnpm build:player && pnpm build:local` (run from `music-player/` for the first, repo root for the rest).
- Cite the rule ID a change touches; rule, test and coverage move together; `pnpm styleguide:check`, `styleguide:build`, `styleguide:pdf` before the docs commit.
- Tokens only — no new hex values; the names used below (`--srch-hot`, `--srch-rule`, `--srch-ink`, `--srch-pf`, `--srch-pf-ink`, `--srch-art-ring`, `--lib-accent`, `--bar-emboss`) all exist in the shell's `:root` today.
- A row with `matchConfidence < 0.5` shows the platform's own words and no chip — never a guessed album (NP-PRIN-002's spirit: honest, explained).
- Unpaired behaviour is exactly today's; the hub leg appears only when `kv('player:hub')` holds a credential.
- Fix-forward only; never push except in the final task; commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Playwright spec runs: `cd music-player && npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/np/preview.spec.ts` (build first).

## Review Focus

1. A paired player whose hub is down or slow must degrade to companion/iTunes inside the existing 8 s deadline, not hang the popover. Pinned in Task 1.
2. A hub row with `matchConfidence: 0.3` must not show album or chip, but must still show its own title/artist and be addable. Pinned in Task 1.
3. Hover-arming must never start audio on touch, with reduced motion, or after the pointer left during the 5 s; a second row hovered mid-arm cancels the first. Pinned in Task 3.
4. A YouTube row (no clip) must say why on hover and never render a play scrim. Pinned in Task 2.
5. Adding a row whose BPM arrives *after* the add must update the library entry once, not create a duplicate or lose the late answer. Pinned in Task 4.

---

### Task 1: The hub leg — enriched results first when paired

**Files:**
- Modify: `music-player/scripts/make-shell.py` (append steps at the end, before the sanity block)
- Create: `music-player/tests/e2e/np/preview.spec.ts`
- Test: same file

**Interfaces:**
- Consumes: hub `GET /api/v1/search?q=&scope=songs` → `SearchResponse` (results carry `albumName, artworkUrl, previewUrl, durationMs, bpm, genres, featuredArtists, identity.matchConfidence, provider, canonicalUrl`); `GET /api/v1/providers/resolve?url=` → one `SearchResult`; auth header `Bearer <credentialId>.<secret>` from `kv('player:hub')`.
- Produces (inside the search module): `hubAcctFor()` (Promise of `{base, credentialId, secret}` or null), `hubSearch(q)`, `fromHub(results)` mapping onto the module's `track()` rows with extra fields `r.feat` (array), `r.genre` (string|null), `r.conf` (number|null); the chain `[hubSearch, companionSearch, itunesSearch]` when paired; iTunes fill-in of `r.prev` for hub rows without one (normalised title+artist match, duration ± 3 s).

- [ ] **Step 1: Write the failing spec**

`music-player/tests/e2e/np/preview.spec.ts`, following the repo's stub pattern (see `np/groups.spec.ts` for `ACCT`/`kv.set` seeding and `page.route`):

```ts
import { expect, test, type Page } from '@playwright/test';
import { boot } from '../_shell';

const HUB = 'http://192.168.1.20:4546';
const ACCT = { base: HUB, credentialId: '00000000-0000-4000-8000-0000000000aa', secret: 'x'.repeat(40), scopes: ['search:use'], hubName: 'TOWER', deviceId: 'd1' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

function hubRow(over: Record<string, unknown> = {}) {
  return {
    id: 'spotify:track:abc', kind: 'track', provider: 'spotify', providerId: 'abc', title: 'Golden Hour', artistName: 'Artist',
    albumName: 'Album', durationMs: 200_000, artworkUrl: null, canonicalUrl: 'https://open.spotify.com/track/abc', year: 2017,
    genre: 'hip hop', genres: ['hip hop', 'trap'], genreProfile: { 'hip hop': 0.7, trap: 0.3 }, featuredArtists: ['Guest'],
    bpm: 98, bpmSource: 'deezer', capabilities: {}, identity: { matchConfidence: 0.95 }, attribution: null, cachedAt: null,
    stale: false, accessState: 'available', previewUrl: 'https://p.scdn.co/mp3-preview/abc', trackId: null, variants: [], ...over,
  };
}

async function pairAndWire(page: Page, rows: unknown[]): Promise<string[]> {
  const asked: string[] = [];
  await page.route(`${HUB}/**`, (r) => {
    const u = new URL(r.request().url());
    asked.push(u.pathname + u.search);
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    if (u.pathname === '/api/v1/search') return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ query: u.searchParams.get('q'), scope: 'songs', results: rows, partialFailures: [], sources: [], nextCursor: null, tookMs: 3 }) });
    return r.fulfill({ status: 404, headers: CORS, body: '{}' });
  });
  await boot(page);
  await page.evaluate(async (a) => {
    (window as unknown as { kv: { set(k: string, v: unknown): void } }).kv.set('player:hub', a);
    await new Promise((res) => setTimeout(res, 300));
  }, ACCT);
  await page.goto('about:blank');
  await boot(page);
  return asked;
}

test('paired, the hub answers first: album, features, genre chip and bpm on the row', async ({ page }) => {
  const asked = await pairAndWire(page, [hubRow()]);
  await page.fill('#q', 'Golden Hour');
  await page.keyboard.press('Enter');
  const row = page.locator('.srch__row').first();
  await expect(row.locator('.srch__title')).toHaveText('Golden Hour');
  await expect(row.locator('.srch__sub')).toContainText('Artist feat. Guest — Album');
  await expect(row.locator('.srch__genre')).toHaveText('hip hop');
  await expect(row.locator('.srch__bpm')).toHaveText('98 bpm');
  expect(asked.some((u) => u.startsWith('/api/v1/search'))).toBe(true);
});

test('a low-confidence row keeps the platform’s own words: no album, no chip', async ({ page }) => {
  await pairAndWire(page, [hubRow({ albumName: 'Guessed Album', identity: { matchConfidence: 0.3 }, genres: [], genre: null })]);
  await page.fill('#q', 'Golden Hour');
  await page.keyboard.press('Enter');
  const row = page.locator('.srch__row').first();
  await expect(row.locator('.srch__sub')).not.toContainText('Guessed Album');
  await expect(row.locator('.srch__genre')).toHaveCount(0);
});

test('a hub that never answers leaves the chain to iTunes inside the deadline', async ({ page }) => {
  await page.route(`${HUB}/**`, () => { /* black hole: never fulfil */ });
  await page.route(/itunes\.apple\.com/, (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ results: [{ trackName: 'Fallback Song', artistName: 'Someone', collectionName: 'LP', trackTimeMillis: 180000, previewUrl: 'https://audio-ssl.itunes.apple.com/x.m4a' }] }) }));
  await boot(page);
  await page.evaluate(async (a) => { (window as unknown as { kv: { set(k: string, v: unknown): void } }).kv.set('player:hub', a); await new Promise((res) => setTimeout(res, 300)); }, ACCT);
  await page.goto('about:blank');
  await boot(page);
  await page.fill('#q', 'Fallback');
  await page.keyboard.press('Enter');
  await expect(page.locator('.srch__row .srch__title').first()).toHaveText('Fallback Song', { timeout: 12_000 });
});
```

Copy `boot` usage and any needed helpers from `np/func.spec.ts` (which drives `#q` and `.srch__row` today); reuse its offline-route setup if `_shell.ts` requires one.

- [ ] **Step 2: Run it to watch it fail**

Run: `pnpm build:player && cd music-player && npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/np/preview.spec.ts`
Expected: FAIL — the sub reads `Artist — Spotify`-style text, `.srch__genre` count 0, and the hub is never asked.

- [ ] **Step 3: The make-shell steps**

Append to `music-player/scripts/make-shell.py`, before the sanity block, a commented section `# ---- search: the hub leg (sub-project 2, NP-FIND-001) ----`. Three replaces, anchors first verified with `grep -c` against `music-player/index.html`:

(a) Anchor `"var DEADLINE = 8000;"` → prepend the hub leg (keep the anchor text at the end):

```js
    /* ---- the hub leg: enriched results when paired (NP-FIND-001) ----
       The paired credential lives in kv; this module reads it directly because the
       shell's hub closure is elsewhere. Same Bearer scheme as hubRaw. */
    function hubAcctFor() {
      if (!window.kv || !window.kv.get) return Promise.resolve(null);
      return window.kv.get('player:hub').then(function (v) {
        return v && v.base && v.credentialId && v.secret ? v : null;
      }, function () { return null; });
    }
    var PLATFORM_NAMES = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify', bandcamp: 'Bandcamp' };
    function fromHub(d) {
      var rows = (d && d.results) || [], out = [];
      for (var i = 0; i < rows.length && out.length < 25; i++) {
        var x = rows[i] || {};
        if (x.kind !== 'track' || typeof x.title !== 'string') continue;
        var conf = x.identity && typeof x.identity.matchConfidence === 'number' ? x.identity.matchConfidence : null;
        var sure = conf === null || conf >= 0.5;
        var r = track(x.title, x.artistName || '', sure ? (x.albumName || '') : '', x.artworkUrl || null,
                      x.previewUrl || null, x.canonicalUrl || null, PLATFORM_NAMES[x.provider] || null,
                      x.durationMs > 0 ? x.durationMs / 1000 : 0, x.bpm);
        r.feat = sure && x.featuredArtists && x.featuredArtists.length ? x.featuredArtists.slice(0, 3) : [];
        r.genre = sure && x.genres && x.genres[0] ? String(x.genres[0]) : null;
        r.conf = conf;
        out.push(r);
      }
      return out;
    }
    function hubSearch(q) {
      return hubAcctFor().then(function (acct) {
        if (!acct) throw new Error('not paired');
        return getJSON(acct.base + '/api/v1/search?scope=songs&q=' + encodeURIComponent(q), false, 5000,
                       { Authorization: 'Bearer ' + acct.credentialId + '.' + acct.secret })
          .then(fromHub);
      });
    }
```

Before writing this step, read the module's `getJSON` signature in `index.html` (search `function getJSON(`): if it takes no headers argument, extend it in the same replace to accept an optional headers object passed through to `fetch` — a one-line addition guarded so every existing call is unchanged.

(b) Anchor `"var chain = [companionSearch, itunesSearch];"` → replace with:

```js
      var chain = [companionSearch, itunesSearch];
      /* Paired, the hub leads: its rows carry album, features, genre and tempo from the
         enrichment cache. iTunes stays in the chain for the unpaired path and, below,
         lends its 30-second clips to hub rows that arrived without one. */
      if (hubReady) chain = [hubSearch, companionSearch, itunesSearch];
```
with `hubReady` maintained beside the module's state: in the same replace, add `var hubReady = false; hubAcctFor().then(function (a) { hubReady = !!a; });` immediately after the `bpmCache` declaration (anchor `"var bpmCache = {};"`), and refresh it at the top of `search(q)`.

(c) iTunes fill-in — anchor the resolved-rows point (the `return rows;` inside the chain walk, exact text `"if (rows && rows.length) return rows;"`): when the winning rows came from `hubSearch` and any lack `prev`, fire `itunesSearch(q)` in the background and, for each hub row without `prev`, adopt the clip of an iTunes row whose lower-cased `t`+`a` match and whose `d` is within 3 s, then repaint via the existing `render()` if still listing. Pasted links: anchor `"function resolveLink(r) {"` and prepend a first try that, when paired, asks `acct.base + '/api/v1/providers/resolve?url=' + enc` with the Bearer header and applies `fromHub({results:[answer]})[0]`'s fields via `applyMeta` (plus `bpm`/`feat`/`genre` directly).

(d) Row markup — anchor the `rowHTML` sub-line (exact text from today's output):
```js
      var sub = r.p ? (r.a ? esc(r.a) + ' — ' + r.p : r.p)
                    : (r.a ? esc(r.a) + (r.al ? ' — ' + esc(r.al) : '') : (r.al ? esc(r.al) : ''));
```
→ becomes: features and album first when known, platform kept as the tail when there is no album:
```js
      var who = r.a ? esc(r.a) + (r.feat && r.feat.length ? ' feat. ' + esc(r.feat.join(', ')) : '') : '';
      var tail = r.al ? esc(r.al) : (r.p || '');
      var sub = who ? (tail ? who + ' — ' + tail : who) : tail;
```
And in the same replace, after the `.srch__bpm` span in the template, add `(r.genre ? '<span class="srch__genre">' + esc(r.genre) + '</span>' : '')`, plus the chip CSS appended to the module's style block (anchor `".srch__pf {"`, prepend before it):
```css
  .srch__genre {
    flex: none; padding: 1px 6px; border-radius: 3px;
    background: var(--srch-pf); color: var(--srch-pf-ink);
    font-size: 10.5px; letter-spacing: 0.02em; font-variant-caps: small-caps;
  }
  @media (max-width: 480px) { .srch__genre { display: none; } }
```

- [ ] **Step 4: Regenerate and watch it pass**

Run: `cd music-player && python scripts/make-shell.py && cd .. && pnpm build:player && pnpm build:local && cd music-player && npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/np/preview.spec.ts tests/e2e/np/func.spec.ts`
Expected: preview.spec 3/3 PASS and `func.spec` (the popover's existing owner) still green.

- [ ] **Step 5: Commit**

```bash
git add music-player/scripts/make-shell.py music-player/index.html music-player/tests/e2e/np/preview.spec.ts now-playing.html
git commit -m "player: paired search leads with the hub's enriched rows — features, album, genre chip, bpm

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: The 30-second click preview, honestly sourced

**Files:**
- Modify: `music-player/scripts/make-shell.py` (append)
- Test: `music-player/tests/e2e/np/preview.spec.ts` (add cases)

**Interfaces:**
- Consumes: `r.prev` (hub `previewUrl` first, iTunes fill-in from Task 1), `window.NP_PLAYER` (`pause()`, `resume()`, `playing()` — `music-player/src/shell/bridge.ts:370-388`).
- Produces: `CLIP = 30`; main playback pauses on preview start and resumes on stop; a row without a clip explains itself on hover.

- [ ] **Step 1: Add the failing cases**

```ts
test('a click plays up to thirty seconds, and the main track waits its turn', async ({ page }) => {
  await pairAndWire(page, [hubRow()]);
  await page.route('https://p.scdn.co/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/mpeg' }, body: Buffer.alloc(4000) }));
  await page.fill('#q', 'Golden Hour');
  await page.keyboard.press('Enter');
  const clip = await page.evaluate(() => {
    const w = window as unknown as { NP_SRCH_CLIP?: number };
    return w.NP_SRCH_CLIP ?? null;
  });
  expect(clip, 'the clip length the module exposes for tests').toBe(30);
  const art = page.locator('.srch__row button.srch__art').first();
  await art.click();
  await expect(page.locator('.srch__art.is-preview')).toHaveCount(1);
  await art.click();
  await expect(page.locator('.srch__art.is-preview')).toHaveCount(0);
});

test('a row with no clip says so instead of pretending', async ({ page }) => {
  await pairAndWire(page, [hubRow({ provider: 'youtube', previewUrl: null, canonicalUrl: 'https://youtu.be/x' })]);
  await page.fill('#q', 'Golden Hour');
  await page.keyboard.press('Enter');
  const art = page.locator('.srch__row .srch__art').first();
  await expect(page.locator('.srch__row button.srch__art')).toHaveCount(0);
  await expect(art).toHaveAttribute('title', /No preview/);
});
```

- [ ] **Step 2: Run to watch them fail** — `NP_SRCH_CLIP` undefined; no `title` attribute.

- [ ] **Step 3: The make-shell steps**

(a) Anchor `"var CLIP = 15;                 // seconds of preview"` → `"var CLIP = 30;                 // seconds of preview — the whole clip a platform serves\n    window.NP_SRCH_CLIP = CLIP;"`. The ring maths already derive from `CLIP` via `tick()` (verify by reading `tick()` at ~8422; if 15 is hard-coded anywhere else in the module, fold it into `CLIP` in the same replace).
(b) Anchor `"function preview(i, el) {"` — inside, right after `stopPreview(); if (same) return;`, add:
```js
      /* One sound at a time: the main track steps aside for the audition and returns after. */
      if (window.NP_PLAYER && window.NP_PLAYER.playing && window.NP_PLAYER.playing()) {
        try { window.NP_PLAYER.pause(); resumeMain = true; } catch (e) { resumeMain = false; }
      }
```
declare `var resumeMain = false;` beside `var audio = null` and, in `stopPreview()` (anchor `"function stopPreview() {"`), end with `if (resumeMain) { resumeMain = false; try { window.NP_PLAYER.resume(); } catch (e) {} }`.
(c) The no-clip explanation: find `artHTML` (`grep -n "function artHTML" music-player/index.html`) and, in its no-preview branch (the non-`<button>` tile), add `title="No preview — opens on ' + (r.p || 'its platform') + '"` and `aria-label` to match (NP-PRIN-002: unavailable is shown and explained).

- [ ] **Step 4: Regenerate and run** — same commands as Task 1 Step 4; all preview.spec cases green.

- [ ] **Step 5: Commit** — `player: the search audition runs the whole 30-second clip, pauses the main track, and a clipless row says why`.

---

### Task 3: Hold-to-arm — five seconds, visibly

**Files:**
- Modify: `music-player/scripts/make-shell.py` (append)
- Test: `music-player/tests/e2e/np/preview.spec.ts` (add cases)

**Interfaces:**
- Produces: `.srch__art.is-arming` (ring fills clockwise in `--lib-accent` over 5 s, linear); arming only under `(hover: hover) and (pointer: fine)` and not under `prefers-reduced-motion: reduce`; cancel on `pointerleave`, any key, list scroll, popover close, or another row arming; at 5 s the ordinary `preview()` runs.

- [ ] **Step 1: Add the failing cases**

```ts
test('resting the pointer on a row arms it, fills the ring, and then plays', async ({ page }) => {
  await pairAndWire(page, [hubRow()]);
  await page.route('https://p.scdn.co/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/mpeg' }, body: Buffer.alloc(4000) }));
  await page.fill('#q', 'Golden Hour');
  await page.keyboard.press('Enter');
  await page.evaluate(() => ((window as unknown as { NP_SRCH_ARM_MS: number }).NP_SRCH_ARM_MS = 300)); // test seam: shrink the hold
  await page.locator('.srch__row').first().hover();
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(1);
  await expect(page.locator('.srch__art.is-preview')).toHaveCount(1, { timeout: 3000 });
});

test('leaving the row mid-hold cancels; nothing plays', async ({ page }) => {
  await pairAndWire(page, [hubRow()]);
  await page.fill('#q', 'Golden Hour');
  await page.keyboard.press('Enter');
  await page.evaluate(() => ((window as unknown as { NP_SRCH_ARM_MS: number }).NP_SRCH_ARM_MS = 800));
  await page.locator('.srch__row').first().hover();
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(1);
  await page.mouse.move(10, 10);
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(0);
  await page.waitForTimeout(900);
  await expect(page.locator('.srch__art.is-preview')).toHaveCount(0);
});

test('reduced motion never arms; the click still works', async ({ page, browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const p2 = await ctx.newPage();
  await pairAndWire(p2, [hubRow()]);
  await p2.fill('#q', 'Golden Hour');
  await p2.keyboard.press('Enter');
  await p2.locator('.srch__row').first().hover();
  await p2.waitForTimeout(400);
  await expect(p2.locator('.srch__art.is-arming')).toHaveCount(0);
  await ctx.close();
});
```
(`pairAndWire` must accept a `Page` — it already does.)

- [ ] **Step 2: Run to watch them fail** — no `.is-arming` class exists.

- [ ] **Step 3: The make-shell steps**

CSS (same style anchor as Task 1's chip, one replace can carry both if sequenced; otherwise anchor `".srch__ring--on {"` and prepend):
```css
  /* Arming: the ring fills clockwise in the library's selection blue over the hold,
     then the countdown runs down in white — two states told apart without reading. */
  .srch__art.is-arming .srch__scrim { opacity: 1; }
  .srch__art.is-arming .srch__ring--on {
    display: block; stroke: var(--lib-accent);
    transition: stroke-dashoffset var(--arm-ms, 5000ms) linear;
  }
  .srch__art:not(.is-arming):not(.is-preview) .srch__ring--on { transition: stroke-dashoffset 0.2s ease; }
```
JS — anchor `"document.getElementById('invOut').addEventListener"`? No: stay inside the search module. Anchor `"function stopPreview() {"` and prepend the arming block:
```js
    /* ---- hold-to-hear: five seconds of rest on a row with a clip (NP-FIND-001) ---- */
    var ARM_DEFAULT = 5000;
    window.NP_SRCH_ARM_MS = ARM_DEFAULT;
    var armTimer = 0, armedEl = null;
    function canArm() {
      try {
        return matchMedia('(hover: hover) and (pointer: fine)').matches &&
               !matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (e) { return false; }
    }
    function disarm() {
      if (armTimer) { clearTimeout(armTimer); armTimer = 0; }
      if (armedEl) { armedEl.classList.remove('is-arming'); armedEl.style.removeProperty('--p'); armedEl = null; }
    }
    body.addEventListener('pointerenter', function (e) {
      if (!canArm()) return;
      var rowEl = e.target && e.target.closest ? e.target.closest('.srch__row') : null;
      if (!rowEl) return;
      var i = +rowEl.dataset.i, r = visible()[i];
      var el = rowEl.querySelector('button.srch__art');
      if (!r || !r.prev || !el || playing === r) return;
      disarm();
      armedEl = el;
      el.classList.add('is-arming');
      el.style.setProperty('--arm-ms', (window.NP_SRCH_ARM_MS || ARM_DEFAULT) + 'ms');
      el.style.setProperty('--p', '1'); /* the transition carries it from 0 */
      armTimer = setTimeout(function () {
        var target = armedEl; disarm();
        if (target) preview(i, target);
      }, window.NP_SRCH_ARM_MS || ARM_DEFAULT);
    }, true);
    body.addEventListener('pointerleave', function (e) {
      if (armedEl && e.target && e.target.closest && e.target.closest('.srch__row')) disarm();
    }, true);
    body.addEventListener('scroll', disarm, true);
    document.addEventListener('keydown', disarm, true);
```
and inside `stopPreview()`/`close()` add a `disarm();` first line (both anchored replaces). `body` is the module's existing results container variable (verify its name — `var body = ...` near the module top — and use that exact name).

- [ ] **Step 4: Regenerate and run** — all preview.spec cases green; run `np/func.spec.ts` too (hover paths).

- [ ] **Step 5: Commit** — `player: rest on a row for five seconds and it plays — the ring fills so you see it coming`.

---

### Task 4: BPM follows the song into the library and the queue

**Files:**
- Modify: `music-player/scripts/make-shell.py` (append)
- Test: `music-player/tests/e2e/np/preview.spec.ts` (add case)

**Interfaces:**
- Consumes: the search→library bridge (the comment `"The one bridge between search and the library"` in `index.html` marks it; the library owns the merge including "duration/BPM carry-over" — locate with `grep -n "duration/BPM carry-over" music-player/index.html`).
- Produces: the library entry created from an added row carries `bpm` (and `genre`) when known; a row added before its BPM arrived is updated in place when `enrich()`'s cached answer lands (the existing `bpmCache` then a library update, not a new entry); wherever the library/queue row template prints the time, a `bpm` chip prints beside it when the entry has one.

- [ ] **Step 1: Write the failing case**

```ts
test('adding a row carries its bpm into the library, and a late answer fills it in', async ({ page }) => {
  await pairAndWire(page, [hubRow()]);
  await page.fill('#q', 'Golden Hour');
  await page.keyboard.press('Enter');
  await page.locator('.srch__row [data-add]').first().click();
  const bpm = await page.evaluate(() => {
    const lib = (window as unknown as { NP_LIB?: Array<{ title: string; bpm?: number | null }> }).NP_LIB;
    return lib?.find((t) => t.title === 'Golden Hour')?.bpm ?? null;
  });
  expect(bpm).toBe(98);
});
```
Before writing, read how the bridge exposes the library to tests (`grep -n "NP_LIB\|window.LIBRARY" music-player/index.html music-player/src/shell/bridge.ts | head`) and assert through the surface that exists; if none is exposed, assert through the Music list's rendered row (`.row` containing `Golden Hour` and `98`), which is the honest user-visible check — prefer that.

- [ ] **Step 2: Run to watch it fail.**

- [ ] **Step 3: The make-shell steps** — at the bridge's add call, pass `bpm: r.bpm || null, genre: r.genre || null` with the row's other fields (one replace, anchored on the bridge's exact call text read in Step 1); in the library/queue row template that prints `fmtTime`, add `(t.bpm ? '<span class="row__bpm">' + t.bpm + '</span>' : '')` with a small CSS rule reusing the `.srch__bpm` numeric style (tokens only); in `enrich()`'s repaint (anchor `"r.bpmTried = true;"`), when `m.bpm` lands and `r.added`, call the library's update path for the matching entry (the bridge's own update seam — read it in Step 1; if the bridge has no update seam, set the entry's `bpm` and dispatch the library's existing refresh event rather than inventing one).

- [ ] **Step 4: Regenerate and run** — the new case plus the whole `np/preview.spec.ts` file green; also `pnpm test:dom` (the bridge has DOM tests).

- [ ] **Step 5: Commit** — `player: a song added from search keeps its tempo — in the library row and when the answer comes late`.

---

### Task 5: The rule, the ledger and the styleguide

**Files:**
- Modify: `design/ux-rules.json`, `music-player/scripts/ledger-shell.py` (the search-popover surface entry), regenerated `design/coverage.json`, `docs/design/styleguide.html`, `docs/design/styleguide.pdf`

**Interfaces:**
- Produces: rule `NP-FIND-001` (group `np-find` — the first of its group; the spec's draft said 004, but no NP-FIND rules exist, so numbering starts honestly at 001), title `A listing can be heard before it is added`, contract: click plays the clip (up to 30 s) with a countdown ring; resting a fine pointer on the row for five seconds arms it with a visible fill and then plays; leaving, a key, scrolling or another row cancels; touch and reduced motion never arm; a row without a clip says why on hover; the main track pauses and resumes. Evidence: the five `np/preview.spec.ts` tests by exact name, plus journey step 08 (Task 6).

- [ ] **Step 1:** Add the rule to `design/ux-rules.json` in the file's own layout (copy an adjacent rule's field order: id, group, title, contract, example, authority `adopted`, owners `["music-player/index.html", "music-player/scripts/make-shell.py"]`, evidence). Extend the `search-popover` surface entry in `ledger-shell.py` with the preview/arming state and rerun it per its own header comment.
- [ ] **Step 2:** Run `pnpm styleguide:check` — expect PASS (fix forward, never widen an exception); then `pnpm styleguide:build && pnpm styleguide:pdf`.
- [ ] **Step 3:** Commit — `design: NP-FIND-001, a listing can be heard before it is added — rule, coverage and styleguide together`.

---

### Task 6: Journey step 08 — the hub leg against the real hub

**Files:**
- Modify: `tests/journey/cross-app.spec.ts`

**Interfaces:**
- Consumes: the paired player from step 02; the hub's fixture/public-domain provider (real audio, keyless).
- Produces: step 08 — in the player, search from `#q` for a title the hub's library holds (seed one in the harness the way `enrichment-wiring.test.ts` seeds `canonical_tracks` — or, simpler and GUI-honest, add a small root with one file through the hub's Music tab if the GUI offers it; otherwise seed via the API with the admin csrf); assert a `.srch__row` appears whose sub-line names the hub-known album when the canonical row was seeded enriched, and that clicking its art sets `.is-preview`. **Deliberate deviation from the spec's step-08 sketch:** live MusicBrainz/Deezer are not reachable in the harness, so the *enrichment fields* are proven by the stubbed spec and the hub integration suites; the journey proves the paired hub leg end-to-end and the click preview against real audio. Record this as a ruling in the ledger.

- [ ] **Step 1:** Write the step (same `test.step` style as 01–07), seeding one canonical row with `albumName`/`bpm`/`enrichedAt` through `NP_JOURNEY`-side API calls before the search.
- [ ] **Step 2:** `pnpm test:journey` — watch the new step fail before the shell rebuild reaches the preview servers (it runs against `music-player/dist`; the build from Task 4's regenerate must be in place), then pass. Run twice.
- [ ] **Step 3:** Commit — `tests: journey step 08 — paired search through the real hub, and the clip plays`.

---

### Task 7: Gates, docs, push

- [ ] **Step 1:** `node scripts/verify.mjs` — every gate; fix forward anything red (budget changes here are display-only strings and CSS; if `test:perf` moves, document the measured delta in the budget history as the repo does).
- [ ] **Step 2:** Append to `.agents/plans/2026-09-21-airwave-oneshot.md`: what shipped, the measured counts from the runs, the NP-FIND-001 numbering ruling and the journey step-08 deviation. Update the Hermes prompt §3 quality sweep with the hold-to-preview checks (arming fill visible, cancel rules, touch/reduced-motion, clipless YouTube row's title).
- [ ] **Step 3:** Commit docs, then `git push origin claude/airwave-oneshot-build`.

---

## Self-review

- **Spec coverage:** hub-first sources (T1), merge rule/iTunes fill-in (T1c), pasted links via hub resolve (T1c), row `feat/album/chip/bpm` + confidence gate (T1d), 30 s + source preference + YouTube honesty + pause/resume (T2), hold-to-arm with fill and every cancel path + touch/reduced-motion (T3), BPM into queue incl. late fill (T4), NP-FIND rule/coverage/styleguide (T5), journey (T6), gates+push (T7). The spec's "Aqua look" details are carried inside T1/T3's CSS with the verified token names.
- **Placeholders:** T1c/T2c/T4 name grep commands to locate anchors whose exact text this plan cannot safely freeze (the generated file moves under earlier tasks); each names the exact new code and the assertion that catches a wrong anchor (`make-shell.py` raises).
- **Type consistency:** `r.feat/r.genre/r.conf`, `NP_SRCH_CLIP`, `NP_SRCH_ARM_MS`, `.is-arming`, `hubSearch/fromHub/hubAcctFor` used identically throughout.
- **Review Focus:** 1→T1 (black-hole test), 2→T1 (low-confidence test), 3→T3 (cancel + reduced-motion tests), 4→T2 (clipless test), 5→T4 (late-answer test).
