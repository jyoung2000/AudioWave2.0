# The 2010 rebuild: one page, not one window

The player used to be a **desktop window**: title bar, source list down the left, a chrome toolbar
carrying the transport, a status bar along the bottom. That is a faithful Aqua/iTunes 9 arrangement,
and it is the wrong shape for the thing this actually is — an app you open on a phone as often as on
a desktop, mostly to look at one song.

The reference at `docs/reference/now-playing-header.html` shows the other shape: a **sticky status
bar**, a **hero player**, and an **iTunes 10 list** under it. One column, no frame, no window
furniture. Everything on screen is either the song, the controls, or the list.

This document is the map from the old arrangement to the new one. It exists so "all the
functionality transferred" is checkable rather than asserted: every feature the player had appears
in the right-hand column of a table below, with the file it lives in.

---

## 1. What the reference gives us, and what it must never give us

The reference is a design document that happens to run. Read as a design, it is precise — every
gradient in it is sampled rather than guessed, and the comments say what from. Read as code, half of
it is a demo harness that would be a security and privacy defect if it shipped.

### Taken

| From the reference | What it becomes here |
|---|---|
| The status bar: sampled seven-stop grey gradient, 1 px edge, white emboss line, sticky | `.np-bar` — the app's only chrome |
| The recessed search pill with the inset shadow and the white lip | `.np-search` — replaces the toolbar `SearchField` |
| The iTunes 11 "Up Next" results popover: gradient header with a count and Clear, 40 px rows, circled chevron on the hot row, footer pager | `.np-results` — used for search results everywhere |
| The iOS 5 segmented control with the one-figure / three-figure silhouettes | `.np-mode` — **Solo and Shared listening**, see §3 |
| The profile avatar: white gel disc, inset ring, silhouette clipped to the circle | `.np-avatar` — your listener identity, and the group menu in Shared |
| The hero: art stage, 21 px bold title over 15 px meta | `.np-hero` |
| The iPod 5G scrubber: 12 px well, near-white track, sky-blue fill that brightens downward, ribbing as a whisper, time stamps beneath the ends, no knob | `.np-scrub` — replaces `Scrubber` in the shell |
| The LIVE marker with the pulsing halo | Shown when Shared mode is following a host, and only then |
| The chromeless transport: glyphs on the page, no slab, 48×44 keys, a 64×52 play key, pressed-in state | `.np-keys` |
| The 122 px volume line with the gel knob | `.np-vol` |
| The iTunes 10 list: 18 px rows, Aqua stripe and **no rules**, glossy embossed sticky header, sorted column tinted blue, monochrome initial badges, icon columns for download and star | `.np-list` — every list in the app |
| The overlay Aqua gel scroller that fades when idle | `.np-list__bar` |
| The parking marquee on the playing row (glide, park, glide back, gradient-dissolved edges) | Reused as-is; the existing `Marquee` component was already this |
| The iOS context menu, the alert sheet, the toast | `.np-ctx`, restyled `Sheet`, restyled `Toast` |
| Dark mode for all of the above | Kept; the app had none before |

### Refused

Everything in the reference's `<script>` blocks that reaches the network. Listed here explicitly
because each one is a decision, not an oversight:

| In the reference | Why it does not ship |
|---|---|
| `fetch('https://api.anthropic.com/v1/messages', …)` from the page | A browser cannot hold an API key secretly. Shipping this ships the key. |
| `jsonp()` — a `<script>` tag whose callback runs whatever comes back | Arbitrary third-party JavaScript with full page privileges. Used for Deezer BPM and the iTunes Search API. |
| `noembed.com` as a CORS-open oEmbed relay | Every title someone looks at is sent to a third party. That is telemetry with extra steps. |
| `http://127.0.0.1:8642` assumed present | The app would claim a capability that depends on software it cannot see. |
| `<script type="importmap">` pointing at `cdn.jsdelivr.net` | The app loads nothing from outside its own origin; there is a test that fails if it does. |
| The two demo albums and the sixteen demo tracks | Fake content in a music player is indistinguishable from a bug. |

Provider search still exists — it goes through a paired hub, which is the thing that *can* hold a
credential, and which the person chose to run. Nothing about that changes here.

---

## 2. Where every section went

The source list is gone as a sidebar; it is now a horizontal **section strip** under the status bar.
It keeps the same accessible structure it had — a `navigation` landmark named "Sections" containing
`option`s with the same nine names — so a keyboard or screen-reader user's mental model of the app
does not change, and the existing tests keep testing the same thing.

| Section | Was | Is now |
|---|---|---|
| Music | `AquaTable` in a `Panel` | `np-list`: 18 px rows, stripes, no rules, sortable glossy header, star column, "not playable here" reason still shown inline |
| Now playing | A panel with art and a signal-chain `KeyValueList` | Folded into the **hero**, which is on every screen. The signal-chain detail moves to a disclosure under it, so the honest account of the DSP is still one click from the song |
| Up next | `AquaTable` | `np-list` with the queue's drag order and "playing from" context |
| Playlists | Panels + table | Sidebar-less two pane: playlist strip, then `np-list` |
| Search | Field + results | The status-bar pill is now the app's only search field; the Search section shows the full results, the pill shows the popover |
| Constellation | Three.js star field + `SegmentedControl` + 2D table fallback | Unchanged behaviour, reskinned; the stage borrows the hero's art-stage treatment |
| Listening | Ranked tables and charts | Same data, `np-list` and restyled charts |
| Equaliser | Preset menu, curve, 11 vertical sliders, bypass/limiter, headroom, retune | Unchanged structurally — this screen is a control panel and a control panel is what it should look like. Restyled to the new material |
| Settings | Six panels | Same six panels, restyled; the mode switch's capability report joins them |

The hero is **persistent**. In the old shell the transport lived in the toolbar and "Now playing"
was a place you went; now the song and its controls are always the top of the page, which is what
the reference is arguing for and what a phone needs.

---

## 3. Solo and Shared

The reference puts a two-segment control in the status bar and draws one silhouette for the left
segment and three for the right. That is the whole design idea, and it is a good one: **who you are
listening with is a mode of the app, not a screen inside it.**

### Solo

What the player has always done. Your library, your queue, your equaliser, your history. Nothing
leaves the device. This is the default and it is complete on its own.

### Shared

A hub group: everyone tuned to the same queue, one host driving it. The hub already implements all
of it — `/api/v1/groups`, the queue command service, presence and snapshots over the realtime
WebSocket. The player did not use any of it before; it does now (`src/lib/group-client.ts`).

In Shared mode:

- the hero shows the group's name, the members who are online, and who is driving;
- the LIVE marker appears when you are following the host's position rather than your own;
- the scrubber goes read-only while following, because seeking a broadcast is not a thing you can
  do — and it says so rather than silently ignoring the drag;
- the transport becomes a **proposal**: skip and next go to the hub as queue commands, and land for
  everyone or not at all;
- the list gains a "who queued this" column.

### When Shared cannot work

The switch is capability-gated, and the reason is on screen rather than in a tooltip:

| Situation | What the Shared segment does |
|---|---|
| No hub paired | Disabled. "Shared listening needs a paired hub — something both devices can reach." |
| Hub paired but unreachable | Disabled, with the hub client's own reason (which distinguishes "off" from "different network"). |
| Running from a `file://` page | Disabled. "A browser will not open a WebSocket from a local file, so there is nothing to keep the two players in step." |
| Paired and reachable, no group yet | Enabled. Choosing it offers *Create a group* or *Join with a code*. |

There is no path where the control is present and does nothing. That rule is the reason this
section is longer than the design deserves.

---

## 4. What this does not change

- The Aqua profile is still `snow-leopard-itunes-9`, and every §17 MUST is still a release gate
  (`docs/AQUA_CONFORMANCE.md`). The new surfaces are 2010 Apple rather than 2009 Apple — the same
  light source, the same 1 px rims, the same restraint about where blue is allowed.
- The single-file build still produces one `now-playing.html` with nothing beside it.
- Nothing is fetched from another origin. The reference's CDN import map is replaced by the bundled
  Three.js the player already lazy-loads.
- Listening events stay append-only; the recommender stays deterministic; the EQ precedence ladder
  is untouched.
