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
  by choice, per playlist), so nothing was invented: the hub needs a library-state or saved-collections route
  first, then the player sends these.
- **Downloading through the hub.** "Download…" in a song's details does what the player does today: the song joins
  the library with its best download link and the helper's fetch sheet fetches it. The hub's
  `POST /api/v1/catalog/download` (YouTube Music → YouTube → SoundCloud → Bandcamp → spotDL, tags, lyrics) is not
  wired into the player yet.
- Songs of a catalog list on show are visitors in the music list: playing one chooses it (no sound unless it is
  fetched), and the row menu's playlist actions file their ids like any other row.
