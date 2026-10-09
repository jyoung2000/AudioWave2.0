# Search UI: owner requirements (2026-10-06)

Collected while the catalog engine (shared domain, contracts, hub and helper endpoints) is being
built. The UI phase on the player, hub and companion must meet every item here.

## Search is about music
- Search finds songs, artists and albums. Never offer "search on YouTube/SoundCloud/…" rows or
  per-row platform-search links (the shell's `findLinks` / `.srch__pf` and the "open it on a
  platform instead" fallback go).
- Every result row shows the platform(s) the song comes from.
- Spotify items say where they play from ("Spotify · plays from YouTube Music", through spotDL).

## MusicSearch features (clean-room; see the DEC entry)
- Live multi-source results with dedupe and per-source status.
- Track / Artist / Album advanced fields; ISRC search.
- Songs / Artists / Albums sections; a filter for sections and sources (persisted).
- A "see all" view per section with infinite scroll.
- Album and artist detail with drill-down.
- Paste any music link; album and playlist expansion.
- Deezer and iTunes previews.
- Genre, label and year; lyrics.

## Pasted playlist links
- The playlist listing shows the platform the playlist is from.
- Its cover is a 2×2 mosaic of the first four songs' covers (or the platform's own cover when it
  has one and fewer than four songs have artwork).
- Clicking the playlist opens it in the music list the way an album opens: the list header names
  it, and its songs are the rows.

## Pagination and whole playlists (added 2026-10-06)
- Search lists paginate (page controls with a count, Page Up/Down); "see all" keeps infinite
  scroll. Later pages are fetched from the engine, not sliced from the first answer.
- Opening a playlist or album loads every song, from any platform (Spotify, YouTube/YouTube Music,
  SoundCloud, Bandcamp, Deezer, Apple Music albums and playlists): no 200 cap; pages are fetched
  until `hasMore` is false, with progress shown and an upper bound that is reported, never silent.

## One row per unique track, every platform (added 2026-10-06)
- The music tab's search covers every platform reachable keylessly (hub/companion: iTunes, Deezer,
  MusicBrainz, YouTube/YouTube Music, SoundCloud, Bandcamp if workable; browser-only: iTunes,
  Deezer via JSONP, MusicBrainz). Spotify, Tidal, Qobuz and Amazon appear as badges via ISRC links.
- The same song on different platforms is one row with every platform's badge; versions (live,
  remix, acoustic, instrumental, edits, sped up, covers) stay separate rows; no song repeats across
  pages.

## The music list's silver search/filter bar
- When the list shows an album or a playlist (from search, a pasted link or the library), the bar
  offers a star to save that album or playlist to the user's music library (and un-star it). Saved
  collections appear in the library menu (Playlists / Albums) and sync through the hub like other
  library state.

## Every app
- The player PWA, the hub admin GUI and the Windows companion each get the search, with the same
  rules. The mockups regenerate, and the ux-rules, coverage and tests follow AGENTS.md.

## Third round in the hub and the companion (2026-10-09; DEC-040, UX-SEARCH-007…012)

The owner's third-round words (given for the player, `2026-10-06-player-search-ui.md`) now hold in
the hub's admin GUI and the companion. Both apps share the behaviour through
`@now-playing/domain/catalog` (`view.ts`: `OVERVIEW_ROWS`, `TYPE_PAGE_ROWS`, `SEARCH_TYPES`,
`seeAllText`, `typeCount`, `thatsAllText`, `sectionPages` ("Page N of M+"), `playlistLine`,
`savedMatching`; `CatalogResults` now folds `playlists`).

- **Overview, no pager** (UX-SEARCH-007): Songs 5, Artists 3, Albums 3, Playlists 3, each with
  "See all N"; the services' line under them. The numbered eight-row pager is gone.
- **One type per page** (UX-SEARCH-009): `TypePage` in each `Search.tsx` — heading and Back, the
  count, its own field (`sections=<type>`, offset 0, 25 or 12), a `.seg` tab list, the services'
  line, the list (`data-page` per row), infinite scroll (an IntersectionObserver near the end, and the
  keys reaching the last rows), "That's all N …", and a sticky `.srch__foot` with ‹ › and
  "Page N of M" (Page Up/Down too) that fetch first and land on the page's first row.
- **Playlists** (UX-SEARCH-010): Deezer's public playlists from the engine's section; the starred
  playlists matching the words first under "In your library".
- **Centred** (UX-SEARCH-011): `.srch { max-width: 720px; margin-inline: auto }` in both apps.
- **Row menu** (UX-SEARCH-012): `lib/menu.tsx` (hub) and `renderer/menu.tsx` (companion) draw the
  window kit's new `.menu`. Up Next: hub `POST /groups/:id/requests`; companion `hub:groups` and
  `hub:request` through `HubClient` (no queue of its own). Library: a download with a rights basis
  (hub `catalog/download`; companion `catalog:download`). Neither app keeps playlists of its own, so
  Add to Playlist… says so and adds to the library.
- Stock: `catalog-stock.json` gained 14 Deezer playlists and a second page of 22 songs (31 in all).
- Tests: `docker-container/tests/dom/search.dom.test.tsx`, `docker-container/tests/e2e/search.spec.ts`,
  `windows-companion/tests/dom/companion-search.dom.test.tsx`,
  `windows-companion/tests/contract/catalog-ipc.test.ts`,
  `windows-companion/tests/integration/companion-and-hub.test.ts` ("Up Next from Search"),
  `packages/domain/tests/unit/catalog-view.test.ts`. Mockups: states `search-row-menu`,
  `search-see-all`, `search-playlists` in `airwave-hub.html` and `airwave-companion.html`.

Not done here: the hub admin and the companion cannot file a catalog song into a player's playlist
(they hold no playlist store of their own); a song from search joins the library instead and says so.
Long-press to open the menu on touch is the player's; the companion's touch path is the 44px "…".
