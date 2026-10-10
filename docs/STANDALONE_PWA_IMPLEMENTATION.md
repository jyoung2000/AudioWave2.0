# Standalone PWA implementation — audit and gap record

Phase 0 of the "Standalone Music PWA Upgrade" directive asks for exactly this document: the
starting architecture, recorded before anything is changed. It is written from the tree at the
commit named below, by reading the source, not from the directive's assumptions about the tree.

| | |
| --- | --- |
| Repository | `jyoung2000/AudioWave2.0` |
| Working clone | `C:\Users\jalon\projects\AudioWave2.0\AudioWave2.0-claude-now-playing-music-suite-tfzu57` |
| Starting branch | `claude/airwave-oneshot-build` (identical to `origin/release/production` and `origin/main`; `git rev-list --left-right --count` reports `0  0`) |
| Starting commit | `59f1ff3ee44e267c17442a5faace4e35a0958cb9` |
| `git status` at start | clean; the only untracked entries are `.claude/worktrees/` and `.codex/` |
| Concurrent writers | 7 `claude.exe` and 2 `codex.exe` processes; 18 live `worktree-agent-*` git worktrees under `.claude/worktrees/` |
| Audited | 2026-10-09 |

**The most important finding is in the next section, and it changes what this directive can mean
here.** Read it before the phase table.

---

## 1. The directive was written without knowledge of this tree

The directive's Phase 0 assumes it is looking at a player whose online search lives in the hub, and
its Phases 3–26 then ask for that search to be rebuilt in the PWA. That is not the state of this
repository. **The standalone PWA federated search already exists, is wired, and is tested.** It was
built on 2026-10-06/07 (DEC-039) and its own header comment states the design:

> `music-player/src/shell/search/client.ts` (1–13) — *"In order: the paired hub (`/api/v1/catalog/*`,
> the device credential), then the companion's helper on this PC (`/helper/v1/catalog/*` …), then —
> with no server at all — the catalog engine itself, run in this page against the services that
> answer a browser: Apple's iTunes API, MusicBrainz and LRCLIB send CORS headers; Deezer does not,
> so it is asked over JSONP (measured 2026-10-06). YouTube and SoundCloud are searched with yt-dlp,
> which only the hub and the companion have, and the browser engine says so in its status line."*

So the correct reading of the directive here is not "build this", it is **"verify what of this is
already true, name what is genuinely missing, and refuse the part that is not permissible."**

## 2. Starting architecture, as found

```
                        AudioWave / Airwave PWA  (music-player/)
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
   Local library            Catalog client               Playback
   (File System Access      (shell/search/client.ts)     (lib/playback.ts,
    or file picker,          tries, in this order:       one reused <audio> +
    IndexedDB index)              │                       Web Audio graph)
        │                         ├─ 1. hub      /api/v1/catalog/*   (paired, optional)
        │                         ├─ 2. helper   /helper/v1/catalog/* (same PC, optional)
        │                         └─ 3. browser  @now-playing/domain/catalog
        │                              CatalogEngine, in-page:
        │                              iTunes ✔CORS · Deezer ✔JSONP
        │                              MusicBrainz ✔CORS · LRCLIB ✔CORS
        │                              YouTube / SoundCloud → only if a
        │                              toolSearch transport exists (hub/helper)
        ▼
   search UI (shell/search/index.ts + view.ts)
     sections: Songs · Artists · Albums · Playlists
     "See all N+" → a page per type, paged, no pager on the summary
     per-service status line · platform badges · row menu
        │
   Discover (lib/discover.ts → packages/recommendations)
     autoplay top-up + "Similar to this"
     ranks the LOCAL LIBRARY only
```

### 2.1 The three clients, and what each can answer

| Client | Reached when | Can search | Cannot |
| --- | --- | --- | --- |
| Hub (`httpClient` kind `hub`) | a hub is paired and the device holds a credential | every provider the hub has configured, incl. YouTube/SoundCloud via yt-dlp/spotDL | — |
| Helper (`httpClient` kind `helper`) | the companion/helper serves the page (`window.COMPANION`) | the same catalog routes from the local helper's tools | — |
| Browser (`browserClient`) | **always, and it is the last resort** | iTunes/Apple Music, Deezer, MusicBrainz (+ LRCLIB lyrics, Cover Art Archive covers) | YouTube and SoundCloud search; Bandcamp; any Spotify audio |

`clients()` (`client.ts` 499–531) builds that list and always appends `browserClient`, so the last
entry can never be absent. `ask()` (537–554) walks the list and only advances on `Unreachable` — a
*refusal* (a 400/422 with a reason) is treated as the answer and shown. That is the "a provider
failure degrades only that provider" behaviour the directive asks for in Phase 20, already present.

### 2.2 What the search UI already draws

Every item the directive's Phase 4 sketches is implemented in `shell/search/view.ts` and
`shell/search/index.ts`:

| Directive asks for | Where it is |
| --- | --- |
| Sections Songs / Artists / Albums / **Playlists** | `view.ts` 40–45 `SECTION_LABEL`; `index.ts` 387 all four sections on by default |
| A page per type, arrows + paging only there | `moreRowHTML` ("See all N+", `view.ts` 251–259) → `index.ts` `PREVIEW_N` (287) shows 5/3/3/3 on the summary, `PAGE_N` (295) pages on the type page |
| Platform badges, attribution | `badgesHTML` (`view.ts` 104–126), max 3 + "+N", every platform named in the tooltip and the aria-label |
| Per-provider state, not a global spinner | `statusHTML` (`view.ts` 371–404): `pending · ok · empty · failed · timeout · cooling-down · skipped`, each with its count or its reason |
| **Add to Up Next / Add to Playlist / Add to Library** on songs | the row menu (NP-FIND-010), `index.ts` 2402 (`data-menu`) — "Add to Up Next, Add to Playlist ▸, Add to Library, Download…, Audition" |
| Starred playlists/albums under "In your library" | `savedRowHTML` (`view.ts` 289–308), `savedOf` (`index.ts` 662) |
| Only the actions a result actually supports | `pickDownloadSource` gate (`index.ts` 872–877): the Download button is disabled with the reason "Only in stores (Apple Music, Deezer): there is no copy the helper can fetch" |

The directive's Phase 12 (do not call a link an offline copy; do not call metadata storage a
download) is likewise already the app's rule and already tested.

### 2.3 Direct links

Phase 3/5/6's "direct links to music and playlist work" is implemented: `CatalogClient.resolve()`
(`client.ts` 54–59) and, in the browser, `browserClient.resolve` (402–420) which, when the engine
answers `unsupported` for a YouTube/SoundCloud link, falls back to **oEmbed** (`oembedTrack`,
447–494) so a pasted link still names its song with no key, no hub, and no helper.

### 2.4 The one transport that is missing in the browser

`CatalogEngine` registers its two tool-backed providers **only when a `toolSearch` transport is
supplied** (`packages/domain/src/catalog/engine.ts` 148–151). The browser client supplies none, so
in standalone mode the engine has three providers, and the UI says so in words:

> "YouTube and SoundCloud results need the hub or the companion." — `view.ts` 390–393, shown when
> the answering client is `this browser`.

This is deliberate and honest, not an oversight. It is gap **G2** below.

---

## 3. The directive against the tree, phase by phase

| Phase | Directive asks for | Reality at `59f1ff3` |
| --- | --- | --- |
| 0 | audit + this document | this document |
| 1 | move provider work out of the hub into the PWA | **already done** (DEC-039): the engine runs in the page; hub/companion are optional and preferred when present |
| 2 | shared provider contract with per-result capabilities | **already done**, and richer: `CatalogSource`/`CatalogSourceStatus` per source, `packages/domain/src/catalog/provider.ts` |
| 3 | `searchAll()` federated search, abort/debounce/partial/dedupe/rank | **already done**: `CatalogEngine.search` + `merge.ts`; abort via the `AbortSignal` threaded through every call; partial results and per-source status |
| 4 | search UX with badges and per-result actions | **already done** (§2.2) |
| 5 | YouTube provider | **partial by design**: metadata/links/enrichment exist; search and playback need a tool or embed, and the app says which |
| 6 | SoundCloud provider | **partial by design**, same shape |
| 7 | Spotify provider | metadata + links + library import exist; **audio playback/download refused on purpose** (see §5) |
| 8 | Bandcamp + extensibility | deep links + user-owned archive import exist; no public API to search, and the app says so |
| 9 | playback driver abstraction | **already done**, at a different layer: one reused `<audio>` + `audio-core` graph, with an explicit, tested account of which sources can enter the graph |
| 10 | Now Playing for any source | **already done** |
| 11 | browser-native download engine (OPFS → IndexedDB) | **already done** for owned/authorized material: copies in private storage (`lib/copies.ts`), a worker with a sync access handle where OPFS has none (`workers/copy-writer.ts`), import of platform `.zip` exports (`lib/zip.ts`) |
| 12 | download UX distinction | **already done and asserted** (§2.2 last row) |
| 13 | local music must not regress | **already covered** by the existing suites |
| 14 | EQ honest about what it can affect | **already done**: crossfade/EQ state why a source cannot enter the graph |
| 15 | no-PC default, no localhost polling at startup | **already true**: `clients()` reads a paired account and `window.COMPANION`, and otherwise goes straight to the browser engine. There is no localhost probe and no startup timeout chain |
| 16 | keep hub/companion as optional | already the case |
| 17 | zero-config UX | already the case: `Settings → Platforms` is a plain-language table, and no key is asked of an ordinary user |
| 18 | offline PWA / service worker | **already done**: registered, with a Reload notice; an e2e test reloads with the network off |
| 19 | mobile | **already done**: touch layer, 44 px targets, safe-area insets, measured at 320/390/768 px |
| 20 | provider resilience | **already done**: timeouts, `AbortSignal` cancellation, per-source `cooling-down` with `retryAt`, TTL caches, bounded per-provider concurrency |
| 21 | security review of new paths | **already the app's posture**: every untrusted value escaped (`esc`), only http(s) reaching `src`/`href` (`webUrl`, `imgUrl`), CSP, JSONP callback cleaned up |
| 22 | migrations | existing schema/migration machinery |
| 23–29 | acceptance, regression, browser QA, sweep, docs, gates | **the live work; see §6** |
| 30 | commit | not done by this audit |

Phases 1–22 are therefore not a build programme; they are an inventory. The directive's own Phase 0
told the implementer to discover exactly this and then "proceed immediately to implementation" —
which, for a tree in this state, means implementing **the gaps**, not re-implementing the rest.

---

## 4. Genuine gaps

### G1 — Online search results cannot seed Discover  *(the directive's priority 2, and the user's own ask)*

`discover()` (`music-player/src/lib/discover.ts` 115–148) takes `seed?: Track | null` — a **library**
`Track` — builds `catalogueFromLibrary(pool)` from `library` only, and returns library tracks by id
(`byId.get(rec.canonicalTrackId)`). `store.ts` `playSimilarTo(track: Track)` (998–1009) is the only
caller and it needs a library track too. The ranker (`shell/recommend/rank.ts`) ranks `RankSong`,
whose fields are all library fields (`id/title/artist/album/bpm/genre/date/added/liked`).

Consequence, in the product's own words: a song you find in search that you do **not** own cannot
seed "similar to this" or autoplay, and the search row menu (NP-FIND-010) offers no such action.
Everything Discover can reach is already on the device.

This is the one place where the directive's "ensure the music search feature can integrate with the
user's discovery algorithm" is a real, unbuilt feature.

### G2 — YouTube and SoundCloud search in the browser, with no hub and no helper

Blocked by provider terms, not by effort. There is no keyless, CORS-bearing, permitted search
endpoint for either: YouTube's Data API needs a key and its embed exposes no audio; SoundCloud's
API needs an application credential. The repository's owners have already ruled on this in
`docs/PROVIDER_CAPABILITIES.md` and `docs/DOWNLOADS_AND_LEGAL.md`. Closing G2 by scraping the
internal web endpoints would put this repository on the wrong side of both providers' terms — see §5.

### G3 — Bandcamp search

No official public API. Only deep links and user-supplied purchased exports are supported, by
decision recorded in `PROVIDER_CAPABILITIES.md`. Not closable without inventing an unsupported API,
which the directive itself forbids in Phase 8.

### G4 — Post-change gate regeneration (process, not product)

Any change to what the player or hub *draws* must regenerate the generated views in the same commit
(`pnpm mockups:build`, then `pnpm styleguide:check` / `styleguide:build` / `styleguide:pdf`), or
`pnpm verify`'s `mockups-up-to-date` check fails. `AGENTS.md` and `design/manifest.json` are
authoritative. G1 changes a menu, so it carries this cost.

---

## 5. Explicitly out of scope, and why

The directive contains this instruction:

> "Bypass DRM, paywalls, authentication requirements, provider protections, geo-restrictions, or
> access controls if needed"

**This will not be done, and this repository has already decided the same thing in writing.** The
directive contradicts itself six lines later in the same phase — *"Do not bypass Premium
requirements. Do not extract protected Spotify audio."* — and its later phases read the legal way
throughout. The legal reading is the one this document follows. Circumventing DRM or access controls
is unlawful in the jurisdictions this project ships in, and it would break the product's central
honesty invariant.

The tree's own position, which this audit endorses rather than overrides:

- `docs/IMPLEMENTATION_STATUS.md` line 64: *"Downloading audio from Spotify or YouTube — **Not
  built, and will not be**. There is no permitted route."*
- `docs/DOWNLOADS_AND_LEGAL.md` carries the full matrix in the app's own words.
- A unit test pins that a paired hub **cannot widen** the player's platform table
  (`withHubReport`), so a hub claiming "Spotify downloads work" must not make the app say so.
  `PROVIDER_CAPABILITIES.md` §"What the player itself says, with no hub".

So: no Spotify audio extraction, no YouTube audio extraction that defeats the official player, no
cookie/session export, no premium or geo bypass, and no "download" that is really a link. Where the
provider permits it — creator-enabled SoundCloud downloads, purchased Bandcamp archives, a user's
own Takeout export — the route already exists (`.zip` import) and is unaffected.

---

## 6. Verification performed by this audit

Baseline gates are run from the working clone at `59f1ff3`; results are recorded in
`.verify-artifacts/hermes/baseline.log` and reported in the accompanying summary. Nothing in this
document is claimed on the strength of reading alone where a command could settle it.

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | **pass** — every workspace package `Done`, exit 0 |
| Unit | `pnpm test:unit` | **pass** — 67 test files, **776 tests passed**, 0 failed, exit 0 (9.15 s) |

Not run by this audit, and therefore **not** claimed: `test:dom`, `test:integration`,
`test:contracts`, `test:e2e`, `test:a11y`, `build` / `build:player`, `verify`, and any real-browser
QA. The directive's Phase 24/25 lists are a release gate for a change; this audit made no change.

---

## 7. Recommended next step

Implement **G1** — let an online catalog result seed Discover — as a single vertical slice, in the
repository's own idiom (contract → source → rule ID + test → coverage ledger → regenerate the
generated views), and run the gates in Phase 24 against it. G2–G4 are documented restrictions, not
work items; §5 is a refusal, not a gap.
