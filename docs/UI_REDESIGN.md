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
| The iTunes 10 list: nine columns, 18 px rows, Aqua stripe and **no rules**, glossy embossed sticky header, sorted column tinted blue, monochrome initial badges, icon columns for offline and star | `.library` — **the reference's own stylesheet block, copied rather than reinterpreted.** Every list in the app wears it |
| The overlay Aqua gel scroller that fades 900 ms after the last movement, with a draggable thumb and a click-to-page track | `.library__bar`, ported from the reference's own code |
| The parking marquee on the playing row: measured travel, one shared clock for title and artist, gradient-dissolved edges | `useMarquee`, ported |
| The desktop context menu — Add to Playlist ▸ with checkmarks, a separator, New Playlist… — with its keyboard model and edge flip | `RowMenu`, ported |
| The New Playlist alert sheet and the toast | `NewPlaylistSheet`, and the toast the reference's CSS describes |
| The 3D jewel case: every texture generator, the full case (lid, tray, walls, hinge posts and pins, retention nubs, ribbed spine, disc well), the diffraction-grating shader on the data side, the three staggered curves that open it, drag with momentum, double-click to reset, the persisted pose | `lib/jewel-case.ts` — **ported, not reimplemented**: the reference's numbers, its shader and its choreography. Lazily mounted over the flat cover |
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
| Equaliser | Preset menu, curve, 11 vertical sliders, bypass/limiter, headroom, retune | Redrawn as the **iTunes equaliser window** from the supplied screenshot: an On checkbox beside the preset pop-up, a preamp and ten bands on a ±12 dB scale with tick dashes flanking each rail and lozenge thumbs. Every existing feature stays — the curve, the headroom figures, the limiter, the retuning panel, the import and export |
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

## 4. What the reference's columns mean here

The reference's rows are demo data, so its platform badge, its tempo and its download key are
decorations. These are real files. Each column keeps its place and its look and gains a meaning the
code can back:

| Column | What it says |
|---|---|
| Source badge | `L` for a file on this device, `H` for a hub stream, or the provider's initials. It is a **link** only when a provider gave a canonical URL to link to |
| BPM | Read from the file's own tags at index time; a dash when the tag is absent. The reference fetched this from a third party over JSONP, which this app will not do |
| Offline | Whether the track can play with the network off — a check for a file in a connected folder, an arrow with the reason for anything else. It reports rather than toggles, because there is nothing here to download. A file added with the one-shot picker reads as *not* offline, because it cannot be reopened after a reload |
| Star | The library's own `liked` flag, the same one the transport's star sets |

The audition button on the search rows is real too: fifteen seconds of the track through its own
audio element, with whatever was playing paused for the duration and resumed after.

## 5. What this does not change

- The Aqua profile is still `snow-leopard-itunes-9`, and every §17 MUST is still a release gate
  (`docs/AQUA_CONFORMANCE.md`). The new surfaces are 2010 Apple rather than 2009 Apple — the same
  light source, the same 1 px rims, the same restraint about where blue is allowed.
- The single-file build still produces one `now-playing.html` with nothing beside it.
- Nothing is fetched from another origin. The reference's CDN import map is replaced by the bundled
  Three.js the player already lazy-loads.
- Listening events stay append-only; the recommender stays deterministic; the EQ precedence ladder
  is untouched.

---

## 6. The line-by-line audit

After the port was in, the reference was walked again — its stylesheet class by class, its two
scripts block by block — against what ships. Almost everything matched, and the gaps that did not
are listed here so the next reader does not have to redo the walk.

**Behaviours that had been reinterpreted, now the reference's:**

| What | Was | Now |
|---|---|---|
| The clock | Polled every 20 s, so it could be that late, and a backgrounded tab came back stale | A timeout re-armed to each minute boundary, re-synced on `visibilitychange` and `focus` |
| The transport row's right edge | Free | Measured against the progress rail and written to `--np-track-inset-r`, so the volume slider ends exactly under the bar |
| The mode switch | Left/Right only, focus left behind | Both axes, Home/End, Space/Return, and the focus ring travels with the roving tab stop |
| The scrubber keys | Left/Right, 5 s / 30 s | Both axes, 5 s / 15 s, and Space is play/pause here as everywhere else |
| The volume keys | 2 % a press | 4 % a press, 10 % with Shift |
| A live rail | Announced as a slider that refused every change | `role="img"`, no value pair, named "Live broadcast, *mm:ss* elapsed", and the fill sits at the live edge |
| Search: Escape | Closed the popover *and* emptied the field | Closes the popover, keeps the query |
| Search: the arrows at a page edge | Wrapped inside the page, hiding the rest of the results | Turn the page, as the pager does. PageDown/PageUp turn it directly |
| Search: pressing a row | Took the focus out of the combobox, dropping `aria-activedescendant` | Focus stays in the field; links still behave as links |
| Search: Clear | Left the focus at the top of the document | Puts the caret back in the field |
| The audition's ring | Ran on a wall clock and cut the clip dead | Follows the audio's own time and fades the last 0.7 s, as the reference does |
| Page size | Six rows | Five, the reference's |
| The list's selection | Started on row 1 | Starts on the playing row, and the list scrolls it back into view when a song starts from somewhere else |

**Not ported, and why:** the reference's search reaches four network providers (a local yt-dlp
helper, the iTunes Search API over JSONP, Deezer for tempo, an Anthropic web search) and resolves
pasted links through `noembed.com`. Those stay out — the reasons are in
[DEVIATIONS.md](DEVIATIONS.md), and they are about JSONP being arbitrary code execution and relays
being telemetry, not about effort. `.player__fill { width: 13% }` and `.volume__knob { left: 72% }`
are demo values our components set from real state.
