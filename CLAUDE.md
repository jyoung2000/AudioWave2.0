@AGENTS.md

<!-- living-style-guide:start -->
## UI and UX changes

Follow the "UI and UX changes" section of `AGENTS.md`: read `design/manifest.json` first, use the
documented tokens, components and rule IDs, change sources, behaviour, tests and the coverage ledger
together, and run `pnpm styleguide:check`, `pnpm styleguide:build` and `pnpm styleguide:pdf`.
<!-- living-style-guide:end -->

## Living mockups

`design/frontends/airwave-*.html` are generated from the apps (`pnpm mockups:build`). When the owner
asks to "incorporate my mockup changes", follow "Living mockups" in `AGENTS.md`: `pnpm mockups:diff`,
carry each change into the real sources (never into a generated file), regenerate, confirm the diff
is clean, report anything not carried over, run the gates, commit.
