# Now Playing — UI styleguide

`AQUA_PROFILE=snow-leopard-itunes-9`

This is how the suite looks and why. It is written from the code: every value here is one you can
find in [`tokens.json`](../../packages/aqua-ui/src/styles/tokens.json) or in the stylesheets beside
it, and if the two ever disagree the code is right and this page is stale.

A rendered companion to this page — the swatches, the type scale, the space ruler and the material
recipes drawn from the real CSS — is [`styleguide.html`](styleguide.html); open it in a browser.

Three things are *not* here. The component API is in
[`packages/aqua-ui/README.md`](../../packages/aqua-ui/README.md); the rendered specimen of every
component is the gallery (`pnpm --filter @now-playing/aqua-ui dev`); and the reasoning behind the
2010 page shell — what moved where, and what the reference gave us — is in
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

## 2. Two skins, one system

| | Window skin | Page skin |
|---|---|---|
| Token prefix | `--aqua-*` | `--np-*`, `--lib-*` |
| Stylesheets | `aqua.css`, `aqua-window.css`, `aqua-media.css` | `now-playing.css` |
| Type | Lucida Grande | the platform UI stack |
| Used by | hub admin GUI, Windows companion | the music player PWA |
| Shape | a framed desktop window with a source list | a sticky bar over a hero and a list |

Both are the same profile — the same light source, the same hairline rims, the same restraint about
where blue is allowed. They differ in *arrangement*, because a window frame drawn inside a browser
viewport is a picture of a window rather than a window, and a 196 px source list is unavailable on a
phone. Controls (`Button`, `Checkbox`, `Slider`, `PopUpMenu`) are shared verbatim.

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

The window skin sets Lucida Grande. The page skin uses `--np-ui-font`, the platform stack
(`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …`), because the 2010 page it is modelled
on ran on whatever the OS supplied.

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
this profile is 10.6. The default action is the *same face* with the hue turned up
(`#d6e9fb → #8bbcea`) and dark ink, not a lozenge of blue.

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

**Page shell** — `PageBar`, `BarSearch`, `BarClock`, `ModeSwitch`, `ProfileButton`, `SectionStrip`,
`Hero`, `HeroArt`, `TrackScrubber`, `KeyTransport`, `KeyButton`, `LevelSlider`.

**Window shell** — `AquaWindow`, `Toolbar`, `TrafficLights`, `SourceList`, `WorkArea`, `Content`,
`BottomBar`, `Splitter`.

**Media** — `Transport`, `TransportAuxButton`, `LcdDisplay`, `Scrubber`, `VolumeSlider`,
`SearchField`, `ResultsPopover`, `NowPlayingGlyph`, `ArtworkGrid`, `Marquee`.

**Controls** — `Button`, `ButtonLink`, `IconButton`, `Checkbox`, `Radio`, `TextField`, `PopUpMenu`,
`Slider`, `SegmentedControl`, `ProgressBar`, `Spinner`, `Tabs`.

**Structure** — `Panel`, `PanelSection`, `FormRow`, `KeyValueList`, `AquaTable`, `ListView`,
`StatusDot`, `SourceBadge`, `Avatar`, `AvatarButton`, `Glyph`, `SourceIcon`.

**Overlays** — `Sheet`, `Dialog`, `Menu`, `useContextMenu`, `ToastProvider`, `useToast`.

**States** — `StatePanel`, `EmptyState`, `ErrorState`, `LoadingState`, `OfflineState`,
`PartialState`, `PermissionRequiredState`, `UnavailableCapabilityState`, `IncompatibleVersionState`,
`InlineValidation`.

That last group is the one people skip. Every screen owes an answer for empty, loading, offline,
partial, refused and out-of-date — and `UnavailableCapabilityState` exists so "this cannot work here"
is a designed state carrying its reason, rather than a blank pane.

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

## 10. Changing any of this

1. **Tokens first.** A new colour or size goes in `tokens.json` and then into the stylesheet as a
   custom property. A literal hex in a component is a bug.
2. **Both schemes.** Define the light value on bare `:root`; redefine only what changes inside the
   dark guard.
3. **Both skins, if it is a control.** `Button`, `Slider` and friends are shared by three products.
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
