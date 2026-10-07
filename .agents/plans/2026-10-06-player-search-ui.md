# The player's music search on the catalog (DEC-039, NP-FIND-001..008)

**Branch:** `claude/airwave-oneshot-build` from `c7da4ac`. **Scope:** the player PWA only (the hub's admin GUI and
the companion get theirs from another agent). Requirements: `2026-10-06-search-ui-requirements.md`; endpoints:
`2026-10-06-catalog-engine.md`.

## Where it lives

- `music-player/src/shell/search/` — a lazy chunk the bridge loads once the shell has run (`loadSearch` in
  `bridge.ts`; an Enter pressed before it lands is replayed). `client.ts` picks who answers, `view.ts` draws rows,
  badges, the status line, details and the mosaic, `index.ts` is the popover (views, keys, previews, hold-to-hear,
  filter, advanced fields, see-all, details, pasted links) and hands albums and playlists to the music list.
- `music-player/scripts/make-shell.py`, "the catalog search" — the popover's markup and styles, the filter sheet,
  the silver bar's star, and the music list's side (`window.NP_LIST`: a catalog list as `focus.rows`, paged in;
  `SavedCollection`s in `library:state.collections`; the library menu's kept Playlists and Albums; the Download key
  for a song on show; `window.NP_FETCH`). The old inline search (and `findLinks` / `.srch__pf`) is gone.

## The shape (owner, 2026-10-07, third round) — NP-FIND-003/004/005/006/009/010

The owner's words: "The search list pagination should have arrows and let the user infinite scroll the search bar
list, go to the next or previous page. Also don't show pagination for the search list until the user clicks See
all for songs, albums, playlists or artists; these should have a separate search list page where the user can
search for specifically that type of music media, instead of having songs, playlists, albums, artists and other
stuff in the same search modal, it feels too hectic. Update the search modal UI and UX to be centered under the
search bar. Also ensure the user can add songs from search to their Now Playing queue, playlist, or music library."

- **Overview, no pager.** Enter draws Songs (five), Artists (three), Albums (three), Playlists (three), each with
  "See all N" (N+ while more may exist), the per-service line, and no footer; Page Up/Down do nothing there. Rows
  still upsert live, one row per song.
- **One type per page.** "See all" pushes a `type` view: the heading with the count, a field of its own
  (`#srchTypeQ`, prefilled; Enter searches `sections=<type>` from offset 0), a segmented control
  (`.srch__segbtn[data-type]`) that re-searches the new type for the page's words, the status line and the list.
  From "See all" the page is seeded with the overview's rows and reads on from `res.next[type]`; `PAGE_ROWS` is 25
  for songs and 12 for the rest (bounded by `CATALOG_MAX_LIMIT`/`CATALOG_PAGE_MAX`).
- **Pagination on the type pages only: arrows and infinite scroll together.** Scrolling near the end (or the keys
  reaching the last rows) fetches the next page (`extend`); the end note "That’s all N …" stays. The footer
  (`#srchFoot`) has ‹ › and "Page N of M" (M+ while more); each of the type's rows carries `data-page`, so ‹ ›
  and Page Up/Down scroll to page N's first row and make it hot (`showPage`), fetching first when it is not there
  (`turnPage` waits for a scroll's fetch rather than racing it); the count follows the scroll (`pageFromScroll`;
  at the very end the last page is the one on show).
- **Playlists as a type** (UX-CAT-005; `2026-10-06-catalog-engine.md`, "Playlists as a section"): `playlistRowHTML`
  with the picture (or a mosaic when `covers` has four); choosing one is `showInList` on its source url (resolve
  pages it). The Playlists page lists `window.NP_LIST.saved()`'s playlists first under "In your library"
  (`savedRowHTML`, opened through `api.openSaved`). The filter sheet gains a Playlists box.
- **Centred under the field.** `place()` sets `--srch-shift` on `#srch` from the field's centre, the window's
  width and `min(560px, 100vw − 20px)`, re-run on resize; the stylesheet (make-shell.py, "the search redrawn")
  centres the card and draws the caret at the field's centre. Details and type pages open inside the same card.
- **The row menu.** `view.ts` gives every song row a `…` (`.srch__menu[data-menu]`); `index.ts` opens the shell's
  menu on it, on `contextmenu` and on a 500 ms touch press (`openRowMenu` → `window.NP_SONG_MENU.open(subject)`),
  where `subject` carries the song as a library row would be written (`songFor`), what the search can do
  (download, audition) and callbacks. The shell (make-shell.py, "the search's song menu") builds the menu —
  Add to Up Next, Add to Playlist ▸ (ticked, New Playlist…), Add to Library, Download…, Audition — and runs the
  filing: `catEnsure` finds the library row by title and artist or adds one through `library:add` with
  `quiet: true` (new: nothing plays, `detail.row` hands the row back) and keeps it in `state.kept`, then queues or
  files it with the HUD. `window.NP_SONG_MENU.run('cat-next', subject)` is Shift+Enter's queue. The popover's
  focus-out and outside-click guards treat `#ctx` and `#sheet` as its own.
- Tests: `tests/e2e/np/catalog-search.spec.ts` (carried forward) and `tests/e2e/np/search-pages.spec.ts` (type
  pages, pager, Playlists, the menu, centring at 390/820/1280). Mockup: `scripts/mockups` — states `search`,
  `search-see-all` (a type page), `search-playlists`, `search-row-menu`; stock playlists in
  `fixtures/search-catalogue.json`.

## Paging (owner, 2026-10-06, second round) — superseded above for the overview; the fetch stays

- A page beyond what arrived is fetched per section from its next offset (`done.page[section].offset + limit`);
  "See all" uses the same fetch and keeps its infinite scroll. The overview's own pager is gone (third round).
- An album or playlist opened in the music list loads every song: `catalog/resolve` (or `catalog/album` for Deezer and
  Apple albums) in pages of 200 from the next offset until `hasMore` is false — no 200 cap in the player. The bar says
  "Loading 400 of 1,250…" meanwhile and the rows on show stay usable. The engine's whole-playlist paging is the
  hub/companion agent's (see `2026-10-06-catalog-engine.md`); the player relies only on offset/limit/total/hasMore.
  Until servers drop the old cap, a capped answer still says "(the first N)".

## Who answers

1. The paired hub: `/api/v1/catalog/*`, `Authorization: Bearer <credentialId>.<secret>` (as `hubSearch` did). A hub
   without the catalog (404 on `catalog/search`) still answers its older `/api/v1/search?scope=songs`, rows mapped to
   catalog tracks, iTunes lending clips.
2. The companion's helper, `window.COMPANION` (found by Settings ▸ Sources ▸ Connect, or the page it served):
   `/helper/v1/catalog/*`, plus `x-helper-token` when the page carries the helper's token meta.
3. This browser: `CatalogEngine` from `@now-playing/domain/catalog`, with a fetch that sends only `Accept`. Measured
   2026-10-06: iTunes, MusicBrainz and LRCLIB send `Access-Control-Allow-Origin: *`; Deezer sends none but answers
   JSONP (`output=jsonp&callback=`). It searches Apple Music, Deezer and MusicBrainz, opens Deezer and Apple albums
   and artists, resolves Deezer and Apple links, and finds lyrics and enrichment. It cannot search YouTube or
   SoundCloud or read their links, Bandcamp's or Spotify's (yt-dlp and spotDL are the servers'): the status line
   says "needs yt-dlp", and a YouTube or SoundCloud link is named by its oEmbed instead.

A server that cannot be reached is passed over for the next; a refusal (400, 422) is shown as it is.

## Follow-ups (not done here)

- **Sync of kept albums and playlists.** The player keeps `SavedCollection`s in `library:state` on this device. It
  has no path that syncs library state through the hub today (the hub holds a profile's *shared* playlists as CSV,
  by choice, per playlist). The hub agent added `/api/v1/catalog/saved` (GET/PUT/DELETE) in the same shape, but it
  is admin-only (cookie), and the player holds a device credential: wiring it needs a device scope on that route
  (or a per-device copy) first. Not invented here.
- **Downloading through the hub.** "Download…" in a song's details does what the player does today: the song joins
  the library with its best download link and the helper's fetch sheet fetches it. The hub's
  `POST /api/v1/catalog/download` (YouTube Music → YouTube → SoundCloud → Bandcamp → spotDL, tags, lyrics) is not
  wired into the player yet.
- Songs of a catalog list on show are visitors in the music list: playing one chooses it (no sound unless it is
  fetched), and the row menu's playlist actions file their ids like any other row.
