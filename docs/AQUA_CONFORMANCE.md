# Aqua specification conformance

`AQUA_PROFILE=snow-leopard-itunes-9`

The plan says every MUST item in §17 and §18 of
[the specification](design/APPLE_AQUA_2009_2010_UI_DESIGN_SPEC.md) is a release gate. That is only
true if each one maps to something that can fail, so this page is the map. Three kinds of entry:

- **Test** — a specific test fails if the item regresses. The file is named.
- **Reviewer** — a judgement a machine cannot make ("reads as a hierarchy"). Checked by a person, and
  said so here rather than dressed up as automated.
- **Deviation** — not met, with the reason in [DEVIATIONS.md](DEVIATIONS.md).

## §17.1 Composition

| MUST | How it is checked |
|---|---|
| One dominant work window is visually clear | **Reviewer.** Each product renders a single `AquaWindow`; `tests/dom/overlays.test.tsx` asserts sheets and menus are children of it rather than competing windows |
| Titlebar and toolbar read as one continuous neutral surface | **Test** — `aqua-conformance.test.ts`, chrome ramp is achromatic and continuous |
| Persistent source list, or a responsive equivalent with current-location context | **Test** — `tests/dom/source-list.test.tsx`; the e2e a11y spec walks all nine sections through it |
| Content region visually dominant and mostly neutral | **Reviewer**, with `windowBody` and `content` tokens pinned by the conformance test |
| Bottom-bar actions visibly subordinate | **Test** — `aqua-conformance.test.ts`, `bottomBarSmall` and label sizes are below body sizes |
| *SHOULD:* large/medium/small hierarchy | **Reviewer** |

## §17.2 Material

| MUST | How it is checked |
|---|---|
| Rims crisp and generally 1 px | **Test** — every border declaration in `aqua.css` is ≤ 1 px |
| Virtual light source above each dimensional control | **Test** — the gel ramp is monotonically darker downward; both inset shadow tokens exist |
| Gel has specular top, mid body, darker lower depth | **Test** — five-step luminance ordering |
| Neutral controls stay neutral; Aqua blue is selective | **Test** — chrome chroma ≤ 2, graphite ≤ 16, accent > 100 |
| Internal panes do not all cast independent card shadows | **Test** — `tests/dom/overlays.test.tsx` |
| *SHOULD:* window shadow stronger than any control shadow | **Test** — blur radii compared |

## §17.3 Typography and density

| MUST | How it is checked |
|---|---|
| Lucida Grande or a compact, tuned fallback | **Test**, and a **Deviation**: the face is not redistributable, so a tuned fallback chain ships |
| ~13 px body, ~12 px list | **Test** |
| Source-group and toolbar labels smaller and subordinate | **Test** |
| Consistent 4/8/12/20 spacing | **Test** — every spacing token is on the rhythm |
| *SHOULD:* compact data rows | **Test** — table and source rows ≤ 20/21 px |

## §17.4 Components

| MUST | How it is checked |
|---|---|
| Familiar transport symbols, play/pause spatially stable | **Test** — `tests/dom/controls.test.tsx`; the player e2e asserts the transport row's controls are named and reachable |
| Search is a rounded recessed field with visible focus and clear state | **Test** — `tests/dom/controls.test.tsx`; the e2e focus-visibility test walks ancestors, which is how the search field's `:focus-within` ring is caught |
| Source and row selection have active and inactive variants | **Test** — `tests/dom/source-list.test.tsx`, `table.test.tsx` |
| Tables communicate sort state and preserve semantics | **Test** — `tests/dom/table.test.tsx` asserts `aria-sort` and roving tabindex |
| Progress communicates status beyond animation | **Test** — `tests/dom/controls.test.tsx` asserts text and `aria-valuenow`, not motion alone |
| *SHOULD:* central inset information display | Present — the LCD display in the player's toolbar |

## §17.5 Interaction

| MUST | How it is checked |
|---|---|
| Hover, pressed, focus, selected, disabled, busy on every control | **Test** — the state ladder in `tests/dom/controls.test.tsx` |
| Keyboard users can reach and operate every action | **Test** — `music-player/tests/e2e/a11y.spec.ts` walks every section with the keyboard alone |
| Focus not colour-alone, visible on gradients | **Test** — the focus shadow has a spread; the e2e test checks focus is visible wherever it lands, including on an ancestor |
| Reduced motion removes pulse and nonessential travel | **Test** — `prefers-reduced-motion` and the explicit `--aqua-anim-state` switch, plus an e2e test that sets the media feature |
| Destructive actions clearly worded and separated | **Test** — `tests/dom/controls.test.tsx`; the hub and companion both confirm before destructive actions |
| *SHOULD:* immediate feedback on drag, resize, reorder | Present in the queue and the source-list splitter |

## §17.6 Profile coherence

| MUST | How it is checked |
|---|---|
| The selected profile is declared | **Test** — the token file and the stylesheet agree on `snow-leopard-itunes-9` |
| Default profile: horizontal traffic lights, coloured source icons | **Test** |
| iTunes 10 profile applies its changes as one set | **Test** — the override block exists and is keyed on the profile attribute |
| Classic gel accent strengthens only appropriate controls | **Test** — chroma bounds above |

## §18 Functional and accessibility

| Item | How it is checked |
|---|---|
| Loads with no runtime errors or console warnings | **Test** — the first player e2e test fails on any console error |
| Core workflows still complete | **Test** — the ten acceptance flows, mapped in [TESTING.md](TESTING.md) |
| Keyboard and screen-reader operability | **Test** — axe on the player's nine screens and the hub's thirteen admin views, plus keyboard-only navigation of both |
| Reduced motion honoured | **Test** |
| Colour contrast | **Test** — axe, on every screen of both interfaces |

## What is not met

Three items, each with its reasoning in [DEVIATIONS.md](DEVIATIONS.md): Lucida Grande is not
shipped (not redistributable), there is no dark colour scheme (not part of this profile), and Cover
Flow is not implemented.
