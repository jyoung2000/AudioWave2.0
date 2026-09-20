# Now Playing — agent context

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
