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
| `GET catalog/search` | `q` and/or `track`,`artist`,`album`; `sections=tracks,artists,albums`; `providers=itunes,deezer,musicbrainz,youtube,soundcloud`; `offset` (≤1000), `limit` (1–50, default 25); `stream=0` | NDJSON of `CatalogSearchChunk` (`application/x-ndjson`), or one `CatalogSearchAggregate` with `stream=0` |
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

## Not done here (for later)

- UI in the three apps; persisting `SavedCollection` (player store, hub sync, companion).
- Apple Music playlists past what their public page embeds (reported in `reason`). Tidal/Qobuz/Amazon links without a SongLink key.
- MP3 lyrics land where FFmpeg puts the generic `lyrics` key (a TXXX frame rather than USLT); FLAC/Opus
  get LYRICS, M4A ©lyr. Not checked against a real FFmpeg here.
- The engine runs in a page, but a browser can only reach a service that sends CORS headers for it;
  not checked per service here. Until it is, the player should use the hub or the helper.
