# Airwave — agent context

A pnpm monorepo (Node 22, TypeScript 6, React 19):

- `music-player/` — the PWA (page skin); also shipped inside `android/` and served by `local-helper/`.
- `docker-container/` — the self-hosted hub: API, admin GUI (`src/web`, window skin), Discord worker.
- `windows-companion/` — the Electron companion (window skin).
- `packages/aqua-ui` — every shared component, the stylesheets and `tokens.json`; also the styleguide.
- `packages/contracts`, `packages/domain` — schemas, routes, queue logic, Discord templates.

`pnpm verify` runs every release gate available on the current machine. Plans live in `.agents/plans/`.

<!-- living-style-guide:start -->
## UI and UX changes

Read the design sources listed in `design/manifest.json` before changing UI or UX: `tokens.json` and
the four stylesheets for values, `packages/aqua-ui` for components, `design/ux-rules.json` for
behaviour (rules have stable IDs), `design/coverage.json` for every screen and journey, and
`design/decisions.md` for exceptions.

- Use the documented tokens, components and interaction contracts. Cite the rule ID a change touches.
- For a requested change, update the authoritative source, the affected product behaviour, the rule's
  test and the coverage ledger together. A new screen goes into `design/coverage.json`.
- Record a deliberate exception in `design/decisions.md`; never widen an exception to make a check pass.
- Run `pnpm styleguide:check` and the tests the rule names, then `pnpm styleguide:build` and
  `pnpm styleguide:pdf`. `docs/design/styleguide.html` and its PDF are generated views, not sources.
- The current user request and higher-level instructions win when they conflict with the guide.
<!-- living-style-guide:end -->

## Living mockups

`design/frontends/airwave-now-playing.html`, `airwave-hub.html` and `airwave-companion.html` are the
owner's mockups, and they are **generated from the apps** (DEC-038): `pnpm mockups:build` builds
each app, runs it in Chrome on sample data (`scripts/mockups/fixtures/`), and writes every screen
and state as readable markup beside verbatim copies of the app's stylesheets, with a small
navigator. The hand-drawn designs they replaced are frozen in `design/frontends/origin/` — still
read by `make-shell.py` and `make-window-css.py`, never edited.

- **App → mockup.** Any change that alters what an app draws must regenerate its mockup
  (`pnpm mockups:build [player|hub|companion]`) in the same commit. `pnpm verify`
  (`mockups-up-to-date`) renders them again and fails on any difference; `pnpm styleguide:check`
  fails when a mockup's inputs stamp is stale. If the build names a request or IPC channel the
  sample data does not answer, add it to the fixtures (the hub's is re-recorded with
  `pnpm build:hub && pnpm mockups:record-hub`).
- **Mockup → app.** When the owner says "incorporate my mockup changes" (or anything like it —
  "make the app match my mockup", "I edited the hub mockup"):
  1. Keep the owner's edited file: if it is in `design/frontends/`, first copy it to a scratch
     folder (`pnpm mockups:export <scratch>`), because step 5 regenerates it. Then run
     `pnpm mockups:diff [app] --mockups <that folder>` (or without `--mockups` while the edit is
     still in `design/frontends/`; the owner's own copies live in `C:\Users\jalon\Documents\Airwave\`). It renders the apps into a scratch folder and prints
     each change by section: `-` is what the app draws now, `+` is the mockup. Stylesheet hunks
     carry the source file's own line number; the same change made in several states is printed
     once with the others named.
  2. Understand each change: which screen, which element, what the owner wants (a word, a
     spacing, a colour, a new or removed element), and which rule ID or token it touches.
  3. Make it in the real source, never in a generated file:
     - player markup or CSS: a new asserted `replace()` step in `music-player/scripts/make-shell.py`
       (then `python music-player/scripts/make-shell.py`); player behaviour in `music-player/src/shell`;
     - hub: `docker-container/src/web` (views, `ui.tsx`, `styles.css`);
     - companion: `windows-companion/src/renderer` (views, `ui.tsx`, `styles.css`);
     - the window kit both share (`airwave-window.css` / `airwave-hub.css` blocks): an asserted entry
       in `EDITS` in `packages/aqua-ui/scripts/make-window-css.py`, then `pnpm build:window-css`
       (or, for one product only, an override in that product's `styles.css`);
     - shared values: `packages/aqua-ui/src/styles/tokens.json` and the stylesheets that mirror it.
     Never edit `design/frontends/origin/`, `music-player/index.html`, the window stylesheets, the
     mockups themselves or `docs/design/styleguide.*` by hand.
  4. Update tests and ledgers per "UI and UX changes" above (the rule's test, `design/coverage.json`
     for a new screen, `design/decisions.md` for an exception).
  5. Run `pnpm mockups:build [app]`, then `pnpm mockups:diff [app] --mockups <the owner's copy>`
     against the owner's edited file: what is left must be nothing, or only what could not be
     carried over. Look at the regenerated state too (open the file, or screenshot it). Report
     every change that was not carried over and why — never drop one silently.
  6. Run the gates (`pnpm styleguide:check`, the tests the rule names, `pnpm styleguide:build`,
     `pnpm styleguide:pdf`, `node scripts/verify.mjs mockups-up-to-date`) and commit.
- `pnpm mockups:export <folder>` copies the three mockups somewhere else; the owner keeps copies in
  `C:\Users\jalon\Documents\Airwave\`. Only write there when the owner asks.
- What a mockup cannot hold: anything the app works out while it runs beyond the recorded states
  (playing sound or video, live search, dragging, animation), and canvases are pictures. Those
  changes go to the app directly.
