# @now-playing/aqua-ui

Shared React component library and semantic design tokens for the Now Playing suite. It implements
the **Snow Leopard / iTunes 9** Aqua profile (`AQUA_PROFILE=snow-leopard-itunes-9`) described in
`docs/design/APPLE_AQUA_2009_2010_UI_DESIGN_SPEC.md`, and the visual grammar preserved in
`docs/reference/now-playing-header.html`.

The package is consumed unbundled (`main` points at `src/index.ts`); Vite/Electron builds compile it
together with the product that imports it. `import '@now-playing/aqua-ui/styles.css'` is done by
`src/index.ts`, so importing any component also installs the token sheet.

## What is in here

| Area | Files | Notes |
| --- | --- | --- |
| Tokens | `src/styles/tokens.json`, `src/styles/aqua.css` §0–§2 | Every colour, radius, shadow, motion duration and easing is a CSS custom property. `[data-aqua-profile]` overrides live in §1; `prefers-reduced-motion` and the explicit `--aqua-anim-state` switch are in §2. |
| Provider | `src/context.tsx` | `AquaProvider` installs the profile attribute, tracks window activity (`[data-active="false"]` desaturates chrome per spec §6.4) and exposes `useReducedMotion` / `useWindowActive`. |
| Shell | `AquaWindow`, `Toolbar`, `TrafficLights`, `WorkArea`, `SourceList`, `Splitter`, `Content`, `BottomBar` | Unified toolbar + source list + content + status bar layout with a drawer variant below 720 px. |
| Transport | `Transport`, `TransportAuxButton`, `LcdDisplay`, `Scrubber`, `VolumeSlider` | The transport accepts leading/trailing aux buttons (star, add to playlist, share) and a `size="large"` car mode. |
| Search | `SearchField`, `ResultsPopover` | Combobox with a grid popup (APG pattern): rows carry selection via `aria-activedescendant`; provider badge and per-row actions are real buttons in their own cells. |
| Data | `AquaTable`, `ArtworkGrid`, `ListView`, `KeyValueList` | Table supports sorting, multi-selection, roving focus, context menus, current-row glyph and virtualisation above a threshold. |
| Controls | `Button`, `IconButton`, `Checkbox`, `Radio`, `TextField`, `PopUpMenu`, `Slider`, `ProgressBar`, `SegmentedControl`, `Tabs`, `SourceBadge`, `Avatar` | All controls are keyboard operable and expose the spec's pressed/disabled/busy states. |
| Overlays | `Sheet`, `Dialog`, `Menu`, `useContextMenu`, `ToastProvider`, `useToast` | Sheets slide from the title bar, trap focus and return it on close; menus support typeahead and disabled-with-reason items. |
| States | `EmptyState`, `LoadingState`, `PartialState`, `OfflineState`, `ErrorState`, `PermissionRequiredState`, `IncompatibleVersionState`, `UnavailableCapabilityState`, `StatusDot` | The honest state vocabulary used across all three products. |
| Icons | `Glyph`, `SourceIcon`, `AvatarIcon` | Inline SVG glyph set (no icon font, no CDN). |

## Gallery

`pnpm --filter @now-playing/aqua-ui dev` serves the component gallery. It is also the fixture used by
DOM, accessibility and visual tests:

```
/?component=shell|controls|overlays|states|results|icons|all
  &width=<px>   # forces a viewport width (drawer breakpoint testing)
  &reduced=1    # forces the reduced-motion state
  &inactive=1   # renders the inactive-window chrome
  &profile=<id> # switches the Aqua profile attribute
```

`pnpm --filter @now-playing/aqua-ui build:gallery` produces `gallery/dist` for Playwright.

## Tests

```
npx vitest run --project dom packages/aqua-ui
```

`tests/dom` covers source-list keyboard semantics, table selection/sorting, control state, overlay
focus management and an axe-core pass over the whole gallery (serious/critical violations fail the
run). Visual and keyboard-flow tests run in Playwright from the repository root (`pnpm test:a11y`).

## Design rules the components enforce

- Focus rings are always visible on keyboard focus (`:focus-visible`), never removed.
- Disabled controls stay readable and, where the reason is known, expose it through `title` and the
  accessible name (`label — reason`).
- Motion respects `prefers-reduced-motion` and the in-app switch; marquee and 3D affordances degrade
  to static equivalents.
- Nothing in the package fetches from the network; artwork and audio are supplied by the host app.
