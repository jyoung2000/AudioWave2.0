# Music catalog — engine, contracts and server endpoints (DEC-039)

**Branch:** worktree of `claude/airwave-oneshot-build` from `2022f53`. **Scope of this part:** the shared
engine, the contracts and the hub/helper endpoints. The search UI in the player, the hub's admin GUI and
the companion comes next, from other agents, on top of this. Rules: UX-CAT-001/002/003
(`design/ux-rules.json`); decision: DEC-039 (`design/decisions.md`); hosts: `docs/SECURITY.md`.

## Plan (done)

1. Contracts — `packages/contracts/src/api/catalog.ts` (schemas, `HELPER_CATALOG_ROUTES`, host lists),
   hub routes in `routes.ts`, `DownloadTags` gains `isrc`/`label`/`lyrics`, `HelperResolvedTrack` gains
   `isrc`/`matchUrl`. `pnpm generate` (OpenAPI, JSON Schema, Android `AllowedHosts.kt`).
2. Engine — `packages/domain/src/catalog/` (import `@now-playing/domain/catalog`). Pure TS; network
   (`CatalogFetch`) and processes (`ToolSearchRunner`, `LinkReader`) injected; no Node APIs.
3. Hub — `docker-container/src/catalog/service.ts`, `src/api/routes/catalog.ts`; yt-dlp/spotDL through
   `ExternalToolAdapter` (`catalogSearch`, `probe(…, { match })`); download through the queue; tags in
   `downloads/finalise.ts`.
4. Helper — `local-helper/src/catalog.ts` + routes in `server.ts`; yt-dlp/spotDL through `resolve.ts`.
5. Ledgers — DEC-039, UX-CAT-001..003, SECURITY.md hosts, this file.

## For the UI agents

### Endpoints

Same shapes on both servers. Hub: `/api/v1/catalog/*`, device credential (`search:use`; download needs
`downloads:request`) or admin cookie, rate class `search` (download: `write`). Helper:
`/helper/v1/catalog/*` (`HELPER_CATALOG_ROUTES`), a page the helper vetted (same origin / allowed origin /
loopback page for the companion) or `x-helper-token`; never reachable from the LAN. Errors: hub
`application/problem+json` (`detail`), helper `{ error, message }`; 400 validation, 404, 422 unsupported,
429 with `Retry-After`, 503 upstream.

| Route | Query / body | Answer |
| --- | --- | --- |
| `GET catalog/search` | `q` and/or `track`,`artist`,`album`; `sections=tracks,artists,albums,playlists`; `providers=itunes,deezer,musicbrainz,youtube,soundcloud`; `offset` (≤1000), `limit` (1–50, default 25); `stream=0` | NDJSON of `CatalogSearchChunk` (`application/x-ndjson`), or one `CatalogSearchAggregate` with `stream=0` |
| `GET catalog/album` | `id=platform:id` (`deezer:…`, `apple-music:…`), `offset` (≤10,000), `limit` (≤200 a page) | `CatalogAlbumDetail` `{ album, page, collection }` |
| `GET catalog/artist` | `id`, `albumsOffset`, `albumsLimit`, `topLimit` | `CatalogArtistDetail` `{ artist, topTracks, albums, albumsPage }` |
| `GET catalog/resolve` | `url`, `offset` (≤10,000), `limit` (≤200 a page; page on for every song) | `CatalogResolveResult` |
| `GET catalog/lyrics` | `title`, `artist`, `album?`, `durationSec?` | `CatalogLyrics` |
| `GET catalog/enrich` | `isrc` or `title`+`artist` (+`durationSec`), `links=0/1` | `CatalogEnrichment` |
| `POST catalog/download` (hub) | `{ track: CatalogTrack, authorization, target }` | 201 `{ job: DownloadJob, source, embedded }` |
| `GET/PUT catalog/settings` (hub, admin) | `{ embedLyrics?, providers?, odesliKey? }` (key write-only, `""` clears) | `CatalogSettingsView` |

Reading the stream: `readCatalogStream(response.body)` in `@now-playing/domain/catalog` yields parsed
chunks as bytes arrive. Cancel by aborting the fetch: the server stops the services still being asked.

### Chunks (live feed)

- `seq 0`: `results`, `provider: null`, no rows, every service's starting `status` (`pending`, or
  `skipped`/`cooling-down` with `error` and `retryAt`). Draw the per-service status row from this.
- One `results` chunk per service as it answers: `provider`, and the rows it **added or changed**.
  **Upsert by `id`**: a later chunk can carry a row already shown, now merged with another service's
  copy (more `sources`, better title/artwork). Sort by `rank` (desc), ties by arrival.
- Zero to two `results` with `provider: null` and a track or two: the best rows' other homes
  (Spotify, YouTube Music, Tidal… from MusicBrainz, `matchedBy: 'musicbrainz'`).
- One more `results` with `provider: null`, when anything was learned: the page's rows **filled in**
  with their facts (UX-CAT-006, below) — bpm, contributors, ISRC, explicit, the full date, the store's
  cover — under the ids they arrived with. Upsert them like any chunk.
- Last: `done` — final `status`, `page.{tracks,artists,albums}` `{ offset, limit, hasMore }` (null for a
  section not asked), `totals`, and `resolve`: a pasted link is **not searched** — `done` arrives alone with
  `resolve: <url>`; call `catalog/resolve`.

Example (trimmed, from the fixtures):

```json
{"type":"results","seq":2,"provider":"itunes","query":{"kind":"text","text":"daft punk get lucky","track":null,"artist":null,"album":null,"isrc":null,"url":null},
 "tracks":[{"id":"youtube:5NV6Rdv1a3I","title":"Get Lucky","artist":"Daft Punk, Pharrell Williams & Nile Rodgers","artists":["Daft Punk","Pharrell Williams","Nile Rodgers"],
   "album":"Random Access Memories","albumArtist":"Daft Punk","durationMs":369629,"isrc":null,
   "artworkUrl":"https://is1-ssl.mzstatic.com/…/600x600bb.jpg","releaseDate":"2013-04-19","year":2013,"trackNumber":8,"discNumber":1,"bpm":null,"explicit":false,"genre":"Pop","label":null,
   "sources":[{"platform":"youtube","id":"5NV6Rdv1a3I","url":"https://www.youtube.com/watch?v=5NV6Rdv1a3I","previewUrl":null,"matchedBy":"search"},
              {"platform":"youtube-music","id":"4D7u5KF7SP8","url":"https://music.youtube.com/watch?v=4D7u5KF7SP8","previewUrl":null,"matchedBy":"search"},
              {"platform":"apple-music","id":"617154366","url":"https://music.apple.com/us/album/get-lucky/617154241?i=617154366","previewUrl":"https://audio-ssl.itunes.apple.com/…/mzaf_….m4a","matchedBy":"search"}],
   "rank":132}],
 "artists":[],"albums":[],
 "status":[{"provider":"itunes","state":"ok","count":2,"latencyMs":310,"error":null,"retryAt":null},
           {"provider":"deezer","state":"pending","count":0,"latencyMs":null,"error":null,"retryAt":null},
           {"provider":"musicbrainz","state":"pending","count":0,"latencyMs":null,"error":null,"retryAt":null},
           {"provider":"youtube","state":"ok","count":2,"latencyMs":2400,"error":null,"retryAt":null},
           {"provider":"soundcloud","state":"failed","count":0,"latencyMs":30000,"error":"yt-dlp is not on this hub yet. …","retryAt":null}]}
{"type":"done","seq":7,"query":{…},"status":[…],"page":{"tracks":{"offset":0,"limit":2,"hasMore":true},"artists":null,"albums":null},"totals":{"tracks":3,"artists":0,"albums":0},"resolve":null}
```

### Playlists as a section (owner, 2026-10-07; UX-CAT-005)

- `sections` takes a fourth value, `playlists`. The request type is `CatalogSearchSection`
  (`tracks | artists | albums | playlists`); `CatalogSection` stays the three item sections the hub's
  admin GUI and the companion draw today, so their `Record<CatalogSection, …>` tables keep typechecking
  until a later pass aligns them.
- Each `results` chunk carries `playlists: CatalogPlaylist[]` — `{ id, title, owner, trackCount,
  pictureUrl, covers, sources, rank }` — and `done.page.playlists` / `done.totals.playlists` page them
  like the rest. All of it defaults (empty array, null, 0), so a chunk from a server without the
  section still parses, and an older client ignores what it does not draw.
- **Deezer alone lists playlists**, keylessly: `/search/playlist?q=&index=&limit=` (checked by hand on
  2026-10-07; JSONP works for a page too). `pictureUrl` is the playlist's `picture_xl`; `covers` stays
  empty because a listing carries no songs and a mosaic would cost a call per row — the picture stands
  for it (NP-FIND-009 draws the mosaic only when `covers` has four). A playlist with `public: false` is
  never a row. iTunes, MusicBrainz and yt-dlp say `skipped` ("It has nothing in the sections asked
  for") when only `playlists` is asked. The merger keeps playlists one row by id.
- **Opening one** is `resolve` on its source's url (`https://www.deezer.com/playlist/<id>`): the
  collection with every song, page by page (UX-CAT-004). The player shows it in the music list like
  an album, with the star (NP-FIND-007/008).
- Fixture: `tests/fixtures/catalog/deezer-search-playlist.json` (three rows, usernames replaced);
  tests in `catalog-engine.test.ts` ("lists public playlists from Deezer…").

### What a row says (UX-CAT-003)

- Every track/artist/album has `sources: [{ platform, id, url, previewUrl, matchedBy }]` — show each
  platform (`CATALOG_PLATFORM_LABELS`: Apple Music, Deezer, MusicBrainz, YouTube, YouTube Music,
  SoundCloud, Spotify, Bandcamp, Tidal, Qobuz, Amazon Music). Never offer "search on YouTube".
- Previews: `previewUrl` on Apple Music and Deezer sources (30 s, DRM-free). Deezer's are signed and
  expire after a while — re-fetch the row (or the album) when one 403s.
- `matchedBy`: `search` (that service's own search), `isrc`, `metadata` (artist+title+duration), `musicbrainz`
  (an editor's link), `spotdl` (spotDL's YouTube Music match), `odesli`, `link` (the pasted link itself).
- **Spotify**: a pasted Spotify track resolves through spotDL with `sources: [{platform:'spotify',
  matchedBy:'link'}, {platform:'youtube-music', matchedBy:'spotdl'}]` → "Spotify · plays from YouTube
  Music" (play/download the second). Albums/playlists/artists list every song (Spotify sources only; the
  YouTube Music match is per song, at download time — spotDL does it). Search rows show Spotify only when
  MusicBrainz (or SongLink with a key) links them. **There is no Spotify free-text search**, by decision.

### Every result carries its facts (owner, 2026-10-07; UX-CAT-006)

The stores' search rows carry no tempo and no contributors (Deezer's `/search/track` has neither;
iTunes and MusicBrainz never give BPM; MusicBrainz rows have no cover), so until now every song
arrived with `bpm: null`, features only when yt-dlp parsed them from a title, and the player filled BPM
by itself with a JSONP lookup per row. Now the engine fills every page (`hydrateTracks`,
`catalog/hydrate.ts`), and the three apps draw what it sends.

- **After** every service's chunk and the cross-links, **before** `done`: the page's rows that still
  lack a fact (`needsFacts`), the top 25 by rank, are looked up with at most **8 in flight** and
  **6 s** for the whole page (`HYDRATE_CONCURRENCY`, `HYDRATE_BUDGET_MS`; `hydrateBudgetMs` in the
  options; `hydrate: false` turns it off). The first chunk never waits. What was learned goes out as one
  `results` chunk, `provider: null`, rows under the ids they arrived with; `?stream=0` folds it in.
  `album()` and `artist()` fill their songs the same way within 4 s.
- **Where each fact comes from**, per row, in order:
  1. a Deezer source → `GET /track/{id}`: `bpm`, `contributors` → `artists`, `isrc`, `explicit_lyrics`,
     `release_date`, `album.cover_xl`, `track_position`, `disk_number`, `album.title`, the preview;
  2. else an ISRC → `GET /track/isrc:{isrc}` (the same record; the Deezer source joins the row with
     `matchedBy: 'isrc'`);
  3. else one exact Deezer search, `/search/track?q=<main artist> <title>&limit=5`, taken only for a hit
     that is the same recording by the merger's own `sameRecording` (names, version, ±3 s) → its
     `/track/{id}` (`matchedBy: 'metadata'`);
  4. a MusicBrainz-only row still without a cover → the Cover Art Archive,
     `GET /release/{first release mbid}/front-500` with redirects **unfollowed**: 307 means the cover
     exists (the address is kept as `artworkUrl`; an `<img>` follows the hop to archive.org), 404 means
     none. The release id is remembered beside the row when MusicBrainz's search is parsed
     (`releaseOfRecording`). Measured 2026-10-07: the archive answers CORS too.
  iTunes rows keep their 600 px artwork and their own credit line; `fillTrack` fills **only nulls**, the
  fuller date wins, the credit list grows only when the detail names more people, and a video or upload
  thumbnail (YouTube, YouTube Music, SoundCloud as the row's only platforms) gives way to the store's
  square cover, as the merger's rule has it.
- **Caching and quota**: a day, keyed by `deezer:<id>`, `isrc:<ISRC>` and the name searched
  (`factsCache`, 3000 entries; the Cover Art Archive by release id, `coverCache`). A detail is kept under
  its ISRC too, so a later row that knows only the ISRC asks nothing. Deezer's quota error (code 4)
  ends the page's Deezer lookups and rests the service as a search would (`health.restUntil`); a
  service switched off, cooling down or left out of the search's `providers` is not asked.
- `CatalogRequestInit.redirect: 'manual'` is new: the hub's `SafeHttpClient` honours it with
  `followRedirects: false`, the helper's guarded fetch returns the 3xx as the answer, the player's
  browser fetch maps an `opaqueredirect` to a 307.
- **What the apps draw**: `creditLine(track)` (`catalog/view.ts`) — the main artist, then "feat. A & B"
  from `artists[1..]` when the artist line does not already name them, four at most then "& others" —
  on the row and the song page of all three; a small "E" beside an explicit song's title (the player's
  `.srch__x`; the hub and companion already had `.cap--x`). The player's own tempo lookup
  (`enrichTempo`) runs only once the search is `done`, for rows still without a BPM.
- Tests: `catalog-hydrate.test.ts` (fixtures `deezer-track.json` and `deezer-isrc.json` are
  `/track/{id}` answers recorded 2026-10-06/07 and trimmed; the archive's 307/404 answered inline),
  the hub's `catalog.test.ts` ("a page's rows carry bpm…"), the player's `catalog-search.spec.ts`
  ("the engine's last chunk fills a row in place…"), and both DOM suites' credit line on "Harbour Wall".

### Resolve, collections and saving (owner requirements)

`CatalogResolveResult.kind`: `track` | `album` | `playlist` | `artist` | `unavailable` | `unsupported`; the
last two carry `reason` in words — show it as is (e.g. "Spotify would not list this playlist. It is
private, or one Spotify made itself … spotDL said: …"; "Apple Music playlists are not in Apple's public
API…"; Tidal/Qobuz/Amazon without a SongLink key; a Deezer short link).

An album/playlist comes as `collection: CatalogCollection`:

- `ref: { platform, kind: 'album'|'playlist', id, url, title, owner }` — stable; store it when the person
  stars the list. `SavedCollection { ref, savedAt, artworkUrl, covers, trackCount }` is the one shape the
  player, the hub's sync and the companion share (contract only so far — nobody persists it yet).
- `artworkUrl`: the list's own cover when the platform has one (Deezer, Apple, Spotify album, YouTube
  playlist thumbnail); `covers`: up to four song artworks in list order for a 2×2 mosaic. Lists whose
  entries have no artwork (SoundCloud sets) get their first four looked up eagerly by the server (two at a
  time); YouTube entries use the video's own thumbnail.
- `page: { tracks, offset, limit, total, hasMore, capped }` — the whole ordered list is loadable page by page
  (`offset` ≤ 10,000, `limit` ≤ `CATALOG_PAGE_MAX` 200; see "Paging a list" above); `capped` only past 10,000.
  Open it in the music list the way an album opens.
- A Spotify **artist** link answers `kind: 'artist'` with `artist` and a `collection` of their songs.

### One song, one row — on every page (owner requirement, 2026-10-06)

- **Merge identity** (`recordingKey`, `sameRecording` in `merge.ts`): ISRC when both rows have one;
  otherwise the main artist and the title with the noise gone ("feat.", "(Official Music Video)",
  "[Lyrics]", "HD", "Remastered", an uploader's "Artist - Title", "- Topic" and VEVO channels) **and the
  same version** (`versionOf`: live, remix, acoustic, instrumental, demo, radio edit, extended, sped up,
  slowed, karaoke, cover, reprise — each stays its own row), and durations within ±3 s. When one side has
  no duration, names and version must match exactly and that side must be an **official upload**
  (YouTube Music Topic, the artist's own or a VEVO channel, or a title saying "Official"); a stranger's
  re-upload never joins on names. So iTunes + Deezer + a YouTube official video + a Topic upload +
  SoundCloud is **one row with five badges**.
- **No repeats across pages.** The server keeps each query's rows (same words and services, any
  sections) for 15 minutes. On a later `offset`, a song that is the same recording as one an earlier page
  sent comes back **with that earlier row's id** (an upsert: more badges on the row already shown), never
  as a new row. Fold later pages by id and you never show a song twice. If the session lapsed (15 min,
  a server restart), keep dropping rows by id and `sameRecording` client-side (`appendTracks` does).
- **`done.linkedOnly`**: platforms on the rows that were not searched but only linked (Spotify, Tidal,
  Qobuz, Amazon Music from MusicBrainz, Deezer's ISRC lookup or SongLink with a key). The status line
  says which were searched (`status`) and which only contributed links (this).
- **Bandcamp search is not workable keylessly**: its public search page answers a bot "Client
  Challenge" that needs JavaScript (checked 2026-10-06), and yt-dlp has no Bandcamp search. Bandcamp
  stays link-only (pasted album and track links resolve through yt-dlp). Spotify, Tidal, Qobuz and
  Amazon stay link-only too, by decision: badges come from MusicBrainz, Deezer's ISRC lookup and the
  optional SongLink key; no scraped tokens.

### Paging a list: every song, no 200 cap (owner requirement, 2026-10-06, later the same day)

The 200-song cap is gone. **`CATALOG_COLLECTION_CAP` is now 10,000** (the bound a runaway list stops at)
and **`CATALOG_PAGE_MAX` is 200** (the most one page carries). If you used `CATALOG_COLLECTION_CAP` as a
`limit`, use `CATALOG_PAGE_MAX` — a `limit` above 200 is now a 400.

- `GET catalog/resolve?url=&offset=&limit=` (and `catalog/album?id=&offset=&limit=`) answers **any page**:
  `offset` 0…10,000, `limit` 1…200. `page.total` is the platform's own count when it gives one (Deezer,
  Spotify through spotDL, YouTube/SoundCloud through yt-dlp, Apple's playlist page); `page.hasMore` is
  true until `offset + tracks.length` reaches the end. `capped` is true **only** when the list is longer
  than 10,000 and the rest can never be opened — say so; nothing is cut silently.
- **To load a whole list in order**, page until `hasMore` is false: `collectAllPages(page, { max, pageSize })`
  in `@now-playing/domain/catalog` does exactly that over any `resolve`-shaped call (pass a function that
  fetches `catalog/resolve` with `offset`/`limit`); it returns `{ first, tracks, total, capped }`. The
  engine's own `resolveAll(url)` is the same over itself. Use `pageSize: CATALOG_PAGE_MAX`.
- The server reads a tool-read list (Spotify via `spotdl save`, YouTube/YouTube Music playlists and
  Bandcamp albums via yt-dlp's flat listing, SoundCloud sets) **once**, whole, up to the bound, and serves
  pages from that read for 10 minutes; the first page of a long playlist can take a minute or more.
- Per platform: Deezer albums and playlists page with Deezer's own `index`/`limit` (100 a call); Apple
  Music albums come whole from iTunes lookup; **Apple Music playlists** are read from their public page
  (`music.apple.com`, the songs it embeds — no token). When that page carries fewer songs than the
  playlist holds, `total` is the real count, `hasMore` ends at what was read, and `reason` says so in
  words ("…lists its first 100 of 340 songs…"); a page whose shape changed answers `unavailable` with a
  plain reason. **SoundCloud sets** list most songs as bare ids: each page you ask for is described in
  one run of yt-dlp (`--playlist-items`), so its rows have titles, artists and artwork.
- The mosaic's `covers` are the first four songs' artwork, as before.

### Details

`album`/`artist` take the `id` of a result row (`deezer:6575789`, `apple-music:617154241`). Other platforms'
albums are opened by resolving their link. Artist pictures come from Deezer; Apple has none (the first
album's cover stands in).

### Lyrics, enrichment, download

- `lyrics`: `{ found, synced (LRC "[mm:ss.xx] line" per line), plain, instrumental, durationSec }`; synced
  preferred within 5 s of the song; `found:false` is an answer, not an error.
- `enrich`: `{ genre, genres, label, year, releaseDate, musicbrainzRecordingId, sources }` — MusicBrainz is
  paced at 1 request/s, so this takes 1–3 s; cached a day. Use it for a row the person opens, not for
  every row.
- `download` (hub): picks YouTube Music → YouTube → SoundCloud → Bandcamp → Spotify (spotDL) from the
  row's sources, else MusicBrainz links, else a YouTube search that must be the same recording; 404 in
  words when the song is only in a store. Tags: ISRC, genre, label, year/date, track/disc, cover, and
  LRCLIB lyrics when `embedLyrics` (default on). `embedded` says which made it.

### Limits and behaviour to design for

- iTunes ~20 calls/min (a text search with three sections is three calls) → `cooling-down` with `retryAt`.
- MusicBrainz 1 req/s; Deezer quota 50/5 s; SongLink 10/min (key only); yt-dlp searches share two slots
  with link lookups, 30 s timeout, 100 results deep at most.
- Two failures rest a service 30 s, doubling to 10 min; a `Retry-After` is honoured at once.
- Paging: each service is asked for `offset`/`limit` per section; merging happens within a page, so a
  song can reappear on a later page from another service — dedupe by `id` and by `sameRecording`
  (exported from the engine) client-side if it matters.
- Deezer's `artist:"…"` filter matched nothing on 2026-10-06; advanced fields fall back to plain words.
- SongLink/Odesli **closed keyless access** (401 `PUBLIC_API_ACCESS_DEPRECATED`, 2026-10-06): optional key.

## Checked against the real services (2026-10-10)

Run from the engine with the hub's own presets and parsers (`TOOL_PRESETS`, `fromYtDlp`/`fromSpotdl`,
`probeToLinkRead`, `HubCatalogService.tagsFor`, `planFinalise`) over Node's `fetch`, yt-dlp 2026.08.19
and spotDL 4.5.2 from PyPI, and FFmpeg 9.0. **The hub image itself was not run**: Docker Desktop's
engine would not start on the machine that day. Latencies are one run each.

| What | Result | Time |
| --- | --- | --- |
| `ytsearch10`/`scsearch10` "daft punk get lucky" | 10 + 10 real rows: titles, lengths, thumbnails; the artist's "Official Audio", a stranger's "Official Video" and a lyric upload (±3 s) are one row; no Topic upload came up | yt 1.5 s, sc 2.7–3.6 s |
| All five services, tracks | 40 rows; cross-links (Spotify, Tidal, Qobuz from MusicBrainz); hydration filled bpm 116.1, contributors, ISRC, dates; five CAA 307s | first chunk 0.27 s, `done` 7.5 s |
| SoundCloud set (Forss, Soulhack, 11) | every song filled by one `--playlist-items` run | 21 s (items run 14 s) |
| Spotify track, `--preload` | spotDL wrote `[null]` (its YouTube Music search found no song, its yt-dlp could not open the video it fell back to); read again without the match | 26 s and 176 s failing; 18 s without |
| Spotify playlist (Today's Top Hits, 50) | listed, `total` 50 | 184 s → 106 s with `--lyrics` |
| Apple album (iTunes lookup) / playlist page | 14 songs / 50 of 50, owner and cover right | 0.9 s / 0.3 s |
| Deezer `/track/isrc:`, enrich, LRCLIB, CAA | 200; genre/label/year + links; 78 synced lines; 307 with `Location`, 404 for none | 0.28 s, 4.7 s, 0.28 s, 0.6 s |
| Downloads (CC BY-NC-SA "Code Monkey (Live 2014)" from Jonathan Coulton's SoundCloud; "Code Monkey" through spotDL) | M4A/MP3/FLAC/Opus tagged; MP3 USLT + TSRC | yt-dlp 6.6 s, spotDL 33 s |

What changed because of it: SoundCloud Go+ snips (exactly 30 s) are not rows, and a page whose rows
were left out still counts as full; a tool-read entry is its page, never the signed stream address a
full entry carries; a SoundCloud set's bare `api-v2` source gives way to the described page; a Spotify
song is read again without the match when `--preload` fails or passes `matchBudgetMs` (60 s);
`spotdl save` gets `--lyrics` with no provider; a Spotify playlist's owner and picture stay unknown
(spotDL's save file names neither); an MP3's lyrics are a USLT frame the hub writes after FFmpeg
(`writeId3Lyrics`), its ISRC goes to FFmpeg as `TSRC`. Real yt-dlp answers, trimmed:
`ytdlp-ytsearch-live.json`, `ytdlp-scsearch-live.json`.

## Not done here (for later)

- UI in the three apps; persisting `SavedCollection` (player store, hub sync, companion).
- Apple Music playlists past what their public page embeds (reported in `reason`). Tidal/Qobuz/Amazon links without a SongLink key.
- M4A downloads carry no ISRC or label: FFmpeg's MP4 writer has no atom for them (a freeform
  `----:com.apple.iTunes:ISRC` atom would need another writer). FFmpeg also files the source URL of an
  MP3 as `TXXX:comment` rather than COMM.
- The hub image's spotDL (the release's own build, with its own bundled yt-dlp) was not run on
  2026-10-10; whether its `--preload` and downloads still reach YouTube Music needs the container.
- The local helper has its own `fromSpotdl`/resolve path (`local-helper/src`), not changed here: its
  Spotify playlist owner and its spotDL `save` arguments still behave as before.
- The engine runs in a page, but a browser can only reach a service that sends CORS headers for it;
  not checked per service here. Until it is, the player should use the hub or the helper.
