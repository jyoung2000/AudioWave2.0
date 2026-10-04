# Airwave Style Guide

`AQUA_PROFILE=snow-leopard-itunes-9`

One guide for the three apps of Airwave — **Airwave** (the player), **Airwave Hub** and **Airwave
Companion** — and why they look the way they do. It is written from the code: every value here is
one you can find in [`tokens.json`](../../packages/aqua-ui/src/styles/tokens.json) or in the
stylesheets beside it, and if the two ever disagree the code is right and this page is stale.
("Now Playing" is the name of the player's home page, and of nothing else.)

The rendered companion to this page is [`styleguide.html`](styleguide.html), and it is not a
drawing of the system. The hub's and the companion's windows are drawn with the stylesheets and the
kits those products ship; every control of the component library is the real one wearing the real
stylesheet; every swatch is read from `tokens.json` at build time; and which product uses what is
read from the products' imports when the page is built. Open it in a browser; regenerate it with
`pnpm styleguide:build`.

It also carries a **mockup of each product at each screen size, at 1:1, that you can edit** —
[§10](#10-the-mockups) explains what that means and where it stops being true.

Three things are *not* here. The component API is in
[`packages/aqua-ui/README.md`](../../packages/aqua-ui/README.md); the rendered specimen of every
library component is the gallery (`pnpm --filter @now-playing/aqua-ui dev`); and the reasoning
behind the 2010 page shell — what moved where, and what the reference gave us — is in
[UI_REDESIGN.md](../UI_REDESIGN.md).

---

## 1. The rules that outrank the visuals

A styleguide that starts with colour teaches the wrong lesson. These four rules decide whether a
control gets drawn at all, and they have overruled the aesthetics more than once in this codebase.

**A control that cannot act is not drawn.** No button that looks live and does nothing; no toggle
whose state is decoration. The equalizer window is missing its traffic lights for exactly this
reason — three circles that close nothing.

**A capability that is unavailable says so where the choice is made.** Not in a tooltip, not in a
log, not by disappearing. The Shared segment of the mode switch stays visible when there is no hub
and reports the reason when pressed. A control that vanishes teaches nothing; one that explains
itself does.

**Say what the code does, not what the feature is called.** The equalizer's solfeggio presets are
filters, and the panel says they are filters and claims no physical effect. The retuning panel
reports that the fallback changed the tempo rather than claiming "preserve tempo". If a label and
the DSP disagree, change the label.

**A disabled control still has to be legible about why.** Greyed, not gone — the dimmed bands on the
equalizer rail are what tell you *where* the current preset is silent. Each carries the reason in
its accessible name, not only in a tooltip.

---

## 2. Three apps, one system

Each app's interface comes from its own design file in [`design/frontends/`](../../design/frontends/).
The design file is the authority for how its app looks; this guide and the ledgers in `design/` are
the authority for what the three share — the rules, the words, every screen, and the checks.

| | Airwave (player) | Airwave Hub | Airwave Companion |
|---|---|---|---|
| Design | `airwave-now-playing.html` | `airwave-hub.html` | `airwave-companion.html` |
| How it reaches the product | served as the shell: `make-shell.py` writes `music-player/index.html` from it | `pnpm build:window-css` writes `airwave-window.css` + `airwave-hub.css` from it | `pnpm build:window-css` writes `airwave-window.css` from it |
| Controls | the design's own script, inside the shell | AquaArt (`@now-playing/aqua-ui/airwave-art`) + `docker-container/src/web/ui.tsx` | AquaArt + `windows-companion/src/renderer/ui.tsx` |
| Its own styles | inline in the shell | `docker-container/src/web/styles.css` | `windows-companion/src/renderer/styles.css` |
| Shape | a sticky bar over a hero and a list | a window: title and six tools on one chrome sheet, a pane, a status strip | the same window with four tools; its chrome is the title bar |
| Dark | follows the system | light only | light only |

### The Airwave window (hub, companion)

A centred Snow Leopard window with no source list and no traffic lights: the tools are the
navigation. Everything it wears is one of three things.

- **Generated stylesheets.** `airwave-window.css` is the companion design's `<style>`, whole;
  `airwave-hub.css` is every rule the hub design adds (tiles, tables, capability chips, the gate).
  Never edit them: change the design file and run `pnpm build:window-css`. Their `:root` values
  are recorded in `tokens.json` under `airwave`, and `pnpm styleguide:check` compares the two.
- **AquaArt.** The push button (Snow Leopard's), the pop-up and the checkbox (10.4's) are SVG
  drawings published as custom properties and worn through `border-image`. One module,
  `packages/aqua-ui/src/airwave/aqua-art.ts`, shared by both products.
- **A kit per product.** Each product's `ui.tsx` writes the design's markup — `.push`, `.field`,
  `.pop`, `.chk`, `.well`, `.rows`, `.sdot` — and its `styles.css` adds what the design left to
  its script: the hub's sign-in, sheet, quiet states and contrast inks (DEC-022); the companion's
  full-frame window, title-bar chrome (DEC-020), song list and sheet. The two kits are not one
  component library, on purpose (DEC-026).

What every Airwave window owes: loading, empty and failed are one quiet line inside the list's
well; a failed action says what to do under the control that failed; a disabled button says why;
anything that cannot be undone asks first in a sheet, with Cancel as the safe default (DEC-021).

### The component library

`packages/aqua-ui` also holds the React component library the three products were first built
from, in two skins:

| | Window skin | Page skin |
|---|---|---|
| Token prefix | `--aqua-*` | `--np-*`, `--lib-*` |
| Stylesheets | `aqua.css` | `now-playing.css` |
| Type | Lucida Grande | Helvetica — the iPod's face |
| Imported by | the player's React source, for its controls, table, sheets and states | the player's React source in `music-player/src` (kept, not served — DEC-019) |
| Shape | Snow Leopard controls: buttons, fields, a table, a sheet, state panels | a sticky bar over a hero and a list |

It is kept, tested and documented below (§3–§9 describe it). The library exports what the player's
React source imports and nothing else: the framed window the hub and the companion were first built
from — toolbar, transport, LCD, source list, bottom bar — and the other components no product
imported were removed with `aqua-window.css` and `aqua-media.css` (DEC-026), and the rendered guide
names any component that falls out of use. The page skin and the player's shell are the same look,
drawn twice: the shell is what is served.

---

## 3. Colour

Colour is decided by role, never by picking a hex. All 134 tokens live in `tokens.json`; these are
the ones you reach for.

### Ink and ground

| Role | Page | Window |
|---|---|---|
| Primary text | `--np-ink` `#1b1c1f` | `--aqua-text` `#161616` |
| Secondary text | `--np-meta` `#575757` | `--aqua-text-secondary` `#565b60` |
| Disabled text | — | `--aqua-text-disabled` `#96999c` |
| Page / content ground | `--np-page` `#fff` | `--aqua-content` `#fff` |
| Window body | — | `--aqua-window-body` `#ececec` |
| Row stripe | `--np-list-alt` `#f2f5f9` | `--aqua-stripe` `#f1f6fb` |
| Hairline border | `--np-list-border` `#ababab` | `--aqua-row-divider` `#d8dee5` |

### Blue, and where it is allowed

Blue means *selected*, *active*, or *the default action*. It is not a brand colour and it is never
decoration.

| Role | Token | Value |
|---|---|---|
| Accent / links | `--np-accent` | `#2b6fd6` |
| Row selection | `--lib-sel-top` → `--lib-sel-bot` | `#5b8dd9` → `#3a6cc4` |
| Playing row | `--lib-np` | `#dde9f8` |
| Sorted column | `--lib-sort-top` → `-bot` | `#e8eef7` → `#cfdbeb` |
| Focus ring | `--aqua-focus` | `#3f9fe8` |
| Aqua gel (specular → rim) | `--aqua-blue-*` | `#eafbff` … `#07558f` |

The full five-stop Aqua gel survives in exactly one place — the overlay scroller's thumb. Everywhere
else Snow Leopard had already flattened it, and so have we.

### Status

| Role | Token | Value |
|---|---|---|
| Live broadcast | `--np-live` | `#cc1027` |
| Star / favourite | `--lib-star` | `#f0a422` |
| Danger | `--aqua-danger` | `#d64a44` |
| Warning | `--aqua-warning` | `#d9a431` |
| Success | `--aqua-success` | `#4e9d47` |

### Dark

The page skin has a full dark palette. It is opt-out, not opt-in: every dark rule is guarded
`@media (prefers-color-scheme: dark) { :root:not([data-np-theme='light']) { … } }`, so the system
preference wins unless a page pins itself light. **Only redefine tokens inside that block** — never
give a colour its sole definition there, or the light scheme loses it.

---

## 4. Type

Two families, one scale.

| Step | Token | Size | Used for |
|---|---|---|---|
| System | `--aqua-font-system` | 13px | body, buttons, menus, the status bar |
| View | `--aqua-font-view` | 12px | table rows, dense content |
| Small | `--aqua-font-small` | 11px | hints, secondary labels, small buttons |
| Label | `--aqua-font-label` | 10px | band labels, scale marks, badges |
| Mini | `--aqua-font-mini` | 9px | mini controls only |

Weights are **400** and **700** (`--aqua-weight-regular` / `-emphasized`). There is no 500 and no
600: the profile predates variable UI fonts, and a half-weight reads as a rendering fault beside a
true bold. Line heights are `1.2` compact and `1.35` body.

Numbers that change in place — timers, dB values, tempo, track times — take
`font-variant-numeric: tabular-nums`, so a digit changing does not shift the ones beside it.

The window skin sets Lucida Grande, as OS X did. The page skin sets **Helvetica** through
`--np-ui-font` (`"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif`) — the face the
iPod classic drew its Now Playing screen in, which is what the hero is modelled on. Arial is the
metric-compatible stand-in where Helvetica is absent, so nothing reflows on Windows.

---

## 5. Space

One scale, no arbitrary values.

| Token | Value | Typical use |
|---|---|---|
| `--aqua-space-micro` | 2px | between a glyph and its own hairline |
| `--aqua-space-tight` | 4px | inside a compact control |
| `--aqua-space-inline` | 6px | icon to label |
| `--aqua-space-control` | 8px | between sibling controls |
| `--aqua-space-small-group` | 10px | rows within a group |
| `--aqua-space-group` | 12px | between groups |
| `--aqua-space-frame-top` | 14px | frame padding; `--np-pad` matches it |
| `--aqua-space-strong-group` | 16px | between unrelated groups |
| `--aqua-space-window-edge` | 20px | window edge inset |
| `--aqua-space-major` | 24px | major section breaks |

### Control heights

| Token | Value |
|---|---|
| `--aqua-control-h` | 22px |
| `--aqua-control-h-small` | 19px |
| `--aqua-control-h-mini` | 15px |
| `--np-field-h` (page search) | 26px |
| `--aqua-row-h` (table row) | 20px |
| music list row (`.library tbody td`) | 18px |
| scrubber rail (`.np-scrub__rail`) | 12px |
| transport key / play key (`.np-key`) | 48px / 64px |

**`--aqua-hit: 32px`** is the floor for a pointer target. A 12 px scrubber and an 18 px list row are
period-correct and stay that size; they get their hit area from an invisible `::after` that expands
past the visual, not from growing the visual. Never shrink a hit target to match a visual.

---

## 5b. Touch

Everything above was drawn for a mouse on a 2010 desktop: 13 px system text, 11 px in a table, a
22 px control, an 18 px row. At arm's length with a cursor that lands on one pixel, all of it is
right, and on a desktop it is left exactly as it is — **including a desktop window dragged narrow**,
because the pointer is still precise and the reader is still close.

A finger is about 9 mm across and a phone is held further away than it looks. So the whole system
steps up on `(pointer: coarse)`, and only the numbers change: every gradient, bevel, radius and
border is the same, so it still reads as this interface rather than a separate mobile theme.

| | Desktop | Coarse pointer |
|---|---|---|
| System / view / small / label / mini text | 13 / 12 / 11 / 10 / 9 px | 15 / 14 / 13 / 12 / 11 px |
| Control, small, mini | 22 / 19 / 15 px | 34 / 30 / 26 px |
| Table header, row, source row | 20 / 20 / 21 px | 32 / 44 / 44 px |
| `--aqua-hit` | 32 px | 44 px |
| The player's list row, and its text | 18 px, 11 px | 44 px, 13 px |
| A field's text | 11–13 px | 16 px |

Three rules hold the layer together.

**Nothing interactive is under 44 px.** Where a control has room, it grows. Where it cannot — a
badge, a 22 px vertical fader, the icons inside a list row — it keeps the size it is
drawn at and takes its taps from a transparent `::after` centred on it. The visual and the target
are different things, and only one of them is allowed to be small.

*Including the things that are targets without looking like controls.* A table row carries the
selection and the roving tabindex, so the row is the target and it takes the full 44 px — it sat at
36 for a while because 36 looks generous beside a 20 px desktop row, which is the wrong comparison.
The player's sortable column header was 34 for the same reason. Neither was found by reading the
CSS; both came out of the fit check in [§10](#10-the-mockups).

**No text is under 12 px.** A hint explaining what the app cannot do is the last thing that should
be unreadable on the device asking the question.

**A field's text is 16 px.** Not a style choice: iOS zooms the page when a field under 16 px takes
focus, which throws a sticky header off and leaves the reader somewhere they did not ask to be.

The layer lives at the end of each stylesheet, after the components. Written at the top it loses to
a component's own rule on source order — which is exactly what happened the first time, leaving
every small button 30 px tall inside a block that asked for 44.

`music-player/tests/e2e/responsive.spec.ts` measures all of this at 320, 390 and 768 px, and
asserts the desktop still gets its 18 px row of 11 px text. A screenshot would catch none of it.
`packages/aqua-ui/tests/e2e/styleguide.spec.ts` then measures every screen of all three products at
every size each is shown at, and fails on the first thing that is too small or cut off.

## 6. Shape and material

Radii: `--aqua-window-radius` 7px, `--aqua-panel-radius` 5px, `--aqua-control-radius` 5px,
`--aqua-pill-radius` 999px. The push button is the exception at **4px** — Snow Leopard's, measured.

### The push button

The signature recipe, and the one most likely to be got wrong:

```css
background: linear-gradient(to bottom, #fdfdfd 0%, #f4f4f4 47%, #e6e6e6 53%, #dcdcdc 100%);
border: 1px solid #a3a3a3;
border-bottom-color: #8d8d8d;
border-radius: 4px;
box-shadow:
  inset 0 1px 0 rgb(255 255 255 / 90%),   /* one pixel of light on the top edge */
  0 1px 0 rgb(255 255 255 / 55%);         /* the surface catching it underneath */
```

A rounded rect, one quiet vertical gradient, a hairline rim that darkens along the bottom, one pixel
of white on top. **No pill, no glass lozenge, no gloss step across the middle** — those are 10.2, and
this profile is 10.6.

The **default action** is the same shape carrying the Aqua blue: a pale cyan cap (`#cfeaff`) over a
saturated body (`#5aa8ef`), a specular hairline at the top, a dark rim (`#4684c8`, `#356db0` along
the bottom), dark ink, and the slow pulse. That is what Snow Leopard's default button was — the gel
stayed on the default action after it had left every other button — and it is the one place on a
form where the system's blue is a highlight rather than a selection.

### Where the Aqua blue survives

Snow Leopard flattened most of Aqua's gel; these are the places it kept it, and the places this
system keeps it:

| Place | What it is |
|---|---|
| The default button | The gel face above, pulsing |
| Table-row selection | `--aqua-selection-*` gradient with white text |
| Music-list selection, sorted column | `--lib-sel-*`, `--lib-sort-*` |
| The overlay scroller thumb | The full five-stop `--aqua-blue-*` gel at strength — the only place |
| The checked box, the pop-up's end cap | `--aqua-blue-*` at control size |
| The aqua-tinted segmented control | The selected segment |
| The indeterminate progress bar | The barber pole |
| The focus ring | `--aqua-focus` with a soft glow, everywhere |

Everything else that is blue on the page is a selection or a link. The iPod rail is the other blue,
and it is not gel: it is the device's own sky-to-cyan fill.

### The recessed field

Wells go the other way: light comes from above, so the inside is shadowed at the top and the lower
lip catches light.

```css
box-shadow:
  inset 0 0 0 1px var(--np-field-ring),    /* rgb(0 0 0 / 20%) */
  inset 0 2px 3px var(--np-field-shadow),  /* rgb(0 0 0 / 32%) */
  0 1px 0 var(--np-field-lip);             /* rgb(255 255 255 / 70%) */
```

### The scrubber rail

12 px, near-square ends, and a fill that **brightens downward** — `#8fb9e4` at the top through a
saturated `#2b9bec` dip at 62% to a cyan `#a5e9fd` glow along the bottom lip. That inversion is the
iPod Classic's, and getting it the usual way round is the fastest way to make this look generic. No
knob: the device had none, and a knob on a 12 px bar is a thumb-sized lie about precision.

### Light

One source, above and slightly forward. Raised things are light at the top and dark at the bottom;
recessed things are the reverse. Every shadow in the system follows from that, and a rule that
contradicts it will look broken even when the colours are right.

---

## 7. Motion

| Token | Value | Use |
|---|---|---|
| `--aqua-motion-press` | 70ms | button press |
| `--aqua-motion-selection` | 100ms | selection change |
| `--aqua-motion-disclosure` | 140ms | disclosure triangle |
| `--aqua-motion-panel` | 200ms | sheet, popover |
| `--aqua-motion-pulse` | 1650ms | default-button halo |
| `--aqua-ease` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | everything |

Motion is confirmation, never decoration. Nothing animates that a person did not just cause.

**Reduced motion is a contract, not a courtesy.** Under `prefers-reduced-motion: reduce` the live
dot stops pulsing, the marquee does not scroll (the cell keeps its ellipsis), the sheet's travel
drops to 0 and it fades only, the constellation opens as a table rather than an animated field, and
the 3D stage stops its idle drift. Two variables carry most of it — `--aqua-anim-state: paused` and
`--aqua-sheet-travel: 0` — so a new animation should read one of them rather than inventing a third.

---

## 8. The components

Everything is exported from `@now-playing/aqua-ui`. Reach for one of these before writing a `<div>`.

These are the component library's. The hub and the companion import none of them (their kits are
in §2); the player's React source imports every one, and a component no product imports is removed
rather than kept. The rendered page reads the exact list from the products' imports each time it is
built; the short version:

| | Player's React source | Hub | Companion |
|---|---|---|---|
| Page shell (`PageBar` … `LevelSlider`) | ● | – | – |
| Controls, structure, states, toasts | ● | – | – |
| The 3D stage, the list, popover, menu, sheet, toast, equalizer (page-skin classes) | ● | – | – |

**Page shell** — `PageBar`, `BarSearch`, `BarClock`, `ModeSwitch`, `ProfileButton`, `SectionStrip`,
`Hero`, `HeroArt`, `TrackScrubber`, `KeyTransport`, `KeyButton`, `LevelSlider`.

**Stage and list** — `JewelStage` over `mountJewelCase` (the reference's 3D module, ported), and
`MusicList` with its own row menu, marquee and overlay scroller, and the `sourceOf` / `offlineOf`
helpers that name where a track lives. Both live here rather than in the player so this page renders
the same ones.

**Controls** — `Button`, `ButtonLink`, `IconButton`, `Checkbox`, `TextField`, `PopUpMenu`, `Slider`,
`SegmentedControl`, `ProgressBar`, `Spinner`.

**Structure** — `Panel`, `PanelSection`, `KeyValueList`, `AquaTable`, `StatusDot`, `SourceBadge`,
`ProviderMark`, `Glyph`.

**Overlays** — `Sheet`, `ToastProvider`, `useToast`.

**States** — `EmptyState`, `LoadingState`, `InlineValidation`.

That last group is the one people skip. Every screen owes an answer for empty, loading, offline,
partial, refused and out-of-date. The library draws empty and loading as panels; the rest are said
in the view's own words, where the choice is made, carrying the reason rather than leaving a blank
pane.

### A download is a link

`ButtonLink` renders an `<a>` wearing the button's face. Use it for downloads and for destinations
in another tab. A `<button>` with an `onClick` that assigns `location` looks identical and quietly
removes the middle click, the context menu and the status-bar preview — which matter most for
exactly those two cases.

---

## 9. Accessibility

Not a checklist bolted on afterwards; these are the parts of the design.

- **One tab stop per group, arrows to move.** The section strip, the mode switch, the music list and
  the context menu all use a roving `tabIndex`, and the focus ring travels with the selection. A
  ring left on an element that is no longer tabbable lets the next Tab escape from nowhere.
- **Focus is always visible.** `--aqua-focus-shadow`, or a 2px `--np-accent` outline at 2px offset.
  An e2e test tabs the whole page and fails on any element that shows no indicator.
- **Roles must be true.** A rail that cannot be dragged is `role="img"` with no value pair, not a
  `slider` that refuses every change. A button that opens a section does not claim
  `aria-haspopup="menu"`.
- **Names say what will happen**, including the refusal: *"500 Hz band, not used by 528 Hz (MI)"*.
- **Live regions are polite** and carry one sentence: the search popover's count, the status line.
- **Colour is never the only signal.** The playing row has a speaker glyph as well as a tint; status
  dots carry text.

---

## 10. The mockups

The last section of [`styleguide.html`](styleguide.html) is a working mockup of all three products:
pick a product, pick a screen, tick the sizes you care about, and each one renders in its own frame
with a measurement of how well it fits underneath.

**A frame is an iframe, and that is the whole point.** The obvious way to draw a phone is a 390 px
`div`, and it is a lie: a media query asks the *viewport*, not the box, so every
`@media (max-width: 480px)` rule in this system stays switched off and you get a desktop layout in a
phone-shaped hole. An iframe is the one thing in a browser with a viewport of its own, so a 390 px
frame really is a 390 px viewport and the layout inside it is the layout a phone gets.

**What is in the frame is what the product loads.** For the hub and the companion that is the
generated Airwave stylesheets and the product's own `styles.css` — and nothing from the component
library — with AquaArt installed in the frame as the product's `main.tsx` installs it, and the
product's own kit and icons portalled into the frame's `#root`. For the player it is the component
library's page skin: the host page's stylesheets cloned in, the player's own stylesheet after them,
and the library's components — the React interface, not the served shell, which is one document
with its own scripts and cannot be portalled into a frame. The frames say which they are.

**Where that stops — and where it no longer does.** Most of the hub's sections (Groups, Library,
Live TV from the companion, Profiles, Shared links, Recommendations, Discord, Network, Backup,
Diagnostics) and the companion's Settings, Backup and About are the products' own view components,
executed as they are. Each view reaches its product through one module — the hub's API client, the
companion's bridge — and the styleguide build alone swaps those two for fakes that answer from
recordings of a real hub and a real companion (`packages/aqua-ui/styleguide/fixtures/`, with the
scripts that record them) and refuse every change with a sentence (DEC-030). The other screens —
sign-in, first run, Overview, Providers, Downloads, the confirmation sheets, and the companion's
Library, Live TV and Remote — need states a recording cannot reach (a refused link, a failed
download, an open sheet), so they are arranged as the views arrange them, in the views' own words,
with fixture data (DEC-009). Each screen's note says which it is.

**The served player is photographed, not framed.** The shell is one document with its own scripts,
so the guide shows it as screenshots of the production build in *The served shell*, taken by
`pnpm styleguide:shell` (`scripts/styleguide-shell-shots.mjs`) at 1280 × 860 and 390 × 844 with
nothing reaching the network. `shots.json` beside them records the hash of the shell they show, and
`pnpm styleguide:check` fails when `music-player/index.html` changes without new screenshots.

**Touch is emulated, and the emulation is derived.** An iframe inherits the host's pointer, so on a
desktop `@media (pointer: coarse)` never matches however narrow the frame is — and this system keeps
its whole touch layer behind exactly that query. So the frame reads those rules back out of the real
stylesheets and re-applies them with the pointer clause stripped and any width clause left intact.
Derived from the shipped CSS, never written twice. A frame that silently failed to do this would
show desktop sizes in a phone and report them as passing, so there is a test that asserts a 44 px
column header inside the phone frame and something smaller inside the laptop one.

**Each product is shown at the sizes it is really seen at.** The player and the hub at 320, 390,
768, 1280 and 1680 px; the companion at 520 × 440 (its smallest window), 640 × 760 (as it opens)
and a laptop. The Airwave window has almost no touch layer — list rows and the round minus grow,
buttons do not — so the hub's phone frames print their target sizes without being failed on the
44 px floor. That is an open question, not a pass: DEC-027.

### The line under each frame

| It says | It means |
| --- | --- |
| `nothing off the side` | The document does not scroll past its own viewport. |
| `smallest text` | The smallest font size on any leaf of text. The floor is 12 px on touch, 10 px otherwise. Glyphs marked `aria-hidden` are excluded: the list's 8 px sort triangle is an icon that happens to be a character, and the sort it indicates is on the header as `aria-sort`. |
| `smallest target` | The smallest interactive thing, counting a transparent `::after` overlay and, for a control inside a `<label>`, the label. The floor is 44 px. Shown only where touch applies. |
| `… runs *n* px past the edge` | Something extends past the viewport. Not reported for anything inside a horizontal scroller — the section strip scrolls on purpose — nor inside a mask-faded marquee, which is that fade's job. |
| `… is cut off *n* px short of its end` | Something extends past a container that **clips**. This is the serious one: the content is not off the side of the screen, it is gone, and there is nothing to scroll to reach it. |

That last row is not hypothetical. At 390 px the earlier hub window's toolbar ran its last two columns off the
side, and because a window clips, the search field was not merely cramped — it did not exist, while
the page reported itself as fitting perfectly. That toolbar has since been removed with the rest of
the library's earlier window skin; the check that caught it still runs on every screen.

### Editing it

The token editor at the bottom lists every custom property the stylesheets define on `:root` — read
from the stylesheets themselves rather than from `tokens.json`, so it can never offer a name the
page does not actually use. Type part of a property name, change the value, and every open frame
repaints as you type, at every size at once.

**Copy the CSS** says where each change belongs. Component-library properties come out as a
`:root:root { … }` block to save over
[`packages/aqua-ui/src/styles/overrides.css`](../../packages/aqua-ui/src/styles/overrides.css):
whatever imports the library reads it — the player's React source, the gallery and this guide —
because that file is imported last. The doubled `:root:root` selects the same element and carries
one more point of specificity, so the block wins regardless of import order. Airwave window
properties come out as a separate block with a note: the hub and the companion do not load
`overrides.css`, and their stylesheets are generated, so those values are changed in the `:root`
of the design files and rebuilt with `pnpm build:window-css`.

That file is empty in the repository, and should usually stay that way: an override is a way to try
something, and the place for a value you have decided to keep is `tokens.json` and the stylesheet
(or the design file, for an Airwave window), per [§11](#11-changing-any-of-this).

### The gates

`pnpm verify` rebuilds the page (`build:styleguide`), checks that the committed copy matches
(`styleguide-up-to-date`, the same arrangement as the single-file player), and runs
`packages/aqua-ui/tests/e2e/styleguide.spec.ts` — which walks every product, every screen and every
size that product is shown at, and fails with the full list of anything too small or cut off.

## 11. Changing any of this

1. **Tokens first.** In the component library a new colour or size goes in `tokens.json` and then
   into the stylesheet as a custom property. In an Airwave window it goes in the design file's
   `:root`, then `pnpm build:window-css`, then the `airwave` group of `tokens.json`. A literal hex
   in a component is a bug.
2. **Both schemes.** Define the light value on bare `:root`; redefine only what changes inside the
   dark guard.
3. **The right source.** An Airwave window changes in its design file (and AquaArt in
   `src/airwave/aqua-art.ts`, kept line for line with the designs' script); the player's shell
   changes in `airwave-now-playing.html`; a library control changes in both of its skins.
4. **Say why in the CSS.** Every unobvious value in these stylesheets carries a comment explaining
   what it is reconstructing. Keep that up — it is what made the Snow Leopard button correction
   findable.
5. **The gates.** `docs/AQUA_CONFORMANCE.md` maps every §17/§18 MUST to a test, a named reviewer
   check, or a recorded deviation. `pnpm verify` runs the lot. A deviation is legitimate; an
   undocumented one is not.

The correction log in [DEVIATIONS.md](../DEVIATIONS.md) is worth reading before a large change. It
records the mistakes this system has already made — the buttons that were a decade too glossy, the
list that got redesigned instead of expanded — and each one was found by building the thing and
looking at it, not by reading the code.

## 12. Rules, screens and upkeep

The visual system above is one half of the design authority. The other half lives in
[`design/`](../../design/) and is rendered into the same page:

- [`design/ux-rules.json`](../../design/ux-rules.json) — interaction and content rules with stable
  IDs (`UX-PRIN-001` … `VOICE-003`, and `NP-*` for the player's shell), the code that owns each one
  and the test that proves it.
- [`design/coverage.json`](../../design/coverage.json) — every screen, overlay and journey of the
  player, the hub, the companion, the Android shell, the local helper and the Discord bot.
- [`design/token-map.json`](../../design/token-map.json) — which custom property carries each value
  in `tokens.json`.
- [`design/decisions.md`](../../design/decisions.md) — adopted, proposed and unresolved decisions.
- [`design/manifest.json`](../../design/manifest.json) — where everything is, and what was seen in
  a running product.

`pnpm styleguide:check` fails when a rule's evidence is missing, when a product declares a screen
the ledger does not know, when `tokens.json` and the stylesheets disagree outside a recorded
exception, or when `styleguide.html` was built from older sources. `pnpm styleguide:pdf` prints the
page to [`styleguide.pdf`](styleguide.pdf): cover, contents, chapters, and every mockup screen.
