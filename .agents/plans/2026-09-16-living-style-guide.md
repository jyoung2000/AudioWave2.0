# Living style guide — design authority, HTML/PDF, checks

Request: `/living-style-guide create` over the whole repo.

## Steps

- [x] Audit every UI surface (player, hub, companion, Discord replies, Android shell/system UI, local helper)
- [x] Design authority in `design/` (manifest, ux-rules, coverage, token-map, decisions) reusing `packages/aqua-ui` tokens and stylesheets
- [x] Guide sections for brand, rules, screens, journeys, Discord, platforms, dark scheme, coverage, upkeep (`packages/aqua-ui/styleguide/Governance.tsx`)
- [x] `pnpm styleguide:build` / `styleguide:check` / `styleguide:pdf`; wired into `scripts/verify.mjs` and `.github/workflows/ci.yml`
- [x] `AGENTS.md` + `CLAUDE.md` design section
- [x] Reversible token propagation check (`--np-accent`), runtime look at player and hub login
- [x] PDF rendered page by page; print defects fixed (narrow media queries scoped to screen, two-column dark table, rule-list bands)

## Progress

- 2026-09-16: `styleguide:check` passes — 25 rules, 44 surfaces, 33 discovered from navigation, 12 Discord commands, 130 tokens, 2 recorded exceptions (DEC-002, DEC-004). PDF is 56 pages, fingerprint 6ff3f666f1c6ce49. Build is byte-identical on repeat. aqua-ui typecheck and 71 vitest tests pass; eslint and prettier clean on changed files.

## Progress — 2026-09-17 critique pass

User ran `/design-critique` against the 2012 OS X HIG and the reference header HTML. Fixed:
- App-icon note off centre (player icon 27 px left): transforms corrected in all four SVGs,
  placements now pinned by `tests/unit/icon-glyphs.test.ts` (DEC-015).
- Equalizer stretching to its container (958 px in the guide): `.eqw { max-width: 600px }` (DEC-014).
- Styleguide glyph bed rendered as a vertical strip (`.np-app` flex column) — now a row.
- Toast specimen stretched full width — now a centred pill.
- The visualisers were invisible in the guide: new "The visualisers" prose under #page, a
  `player-constellation` mockup in screens.tsx drawn by the view's own placement algorithm,
  coverage.json updated (9 mockups). PDF is 58 pages, fingerprint 48631f8e91501636.
- Verified: typecheck, 75 unit/dom tests, styleguide:check, prettier, eslint, PDF page inspection.

## Progress — 2026-09-17 transport centring

- Play was off the progress rail's centre at in-between widths (45 px left at 700 px in the guide;
  28 px left on desktop in the real player, whose eleven keys never left room for the volume on
  both sides). `KeyTransport` now measures its row: volume beside the keys only when it fits on
  both sides, keys wrap only when needed with previous/play/next alone on line one (DEC-016).
  Stylesheet rules keyed on `data-stacked` / `data-wrapped`; the old 620 px viewport rule is gone.
- Guide demo now carries the player's eleven keys (Discover and Download added).
- Measured in the built guide and the running player (localhost:5173) at 1280/900/700/600/480/
  390/320: play 0 px from the rail centre everywhere, previous/next on its line, keys inside the rail.
- 2 new DOM tests (`tests/dom/page-chrome.test.tsx`); aqua-ui 77 tests pass. HTML and PDF share
  fingerprint c06be7ece6dfa5b5; PDF is 59 pages. Player e2e not run (no bundled Chromium).

## Progress — 2026-09-17 visualisers, HTML = PDF

- User could not find the visualiser in the HTML. Cause: the Constellation existed only in the
  HTML's mockup picker (the PDF prints every mockup), and the player's audio spectrum
  (`NowPlaying.tsx`) was not in the guide at all.
- Extracted `drawSpectrum` (`music-player/src/lib/spectrum.ts`) and `layoutStars`
  (`music-player/src/lib/constellation-layout.ts`); the views call them, and the guide's new
  `styleguide/visualisers.tsx` draws its specimens with the same functions and the player's own
  `.player-spectrum` / `.player-constellation` rules.
- Both are now inline in the Page chapter (HTML and PDF pages 19–20) and whole in the mockups
  (new `player-engine` screen; `player-constellation`). 10 surfaces have mockups.
- `design/manifest.json` fingerprint now also covers the three product stylesheets, the two new
  lib files and `decisions.md`, so a change to any of them marks the guide stale.
- 6 new unit tests (`music-player/tests/unit/visualisers.test.ts`); 162 tests pass; both packages
  typecheck; lint and prettier clean. HTML and PDF fingerprint db3c5bf6919cfa52, 61 pages.

## Verification (for Antigravity)

Not verified yet:
- the companion, Android and Discord products at runtime;
- the hub past its login screen (no credentials were used);
- `pnpm test:e2e` for the styleguide, because Playwright's bundled Chromium is not installed (the PDF export used installed Chrome through `NP_STYLEGUIDE_BROWSER`).

Open decisions: DEC-005, DEC-008, DEC-012 in `design/decisions.md`.
DEC-004 was resolved on 2026-09-20 (see `.agents/plans/2026-09-20-local-fix-pass.md`): the
stylesheet was right and `tokens.json` was wrong, so the token now records the shipped
`rgb(31 41 45 / 22%)` and the exception is gone.
