# Plan: Music metadata and shared stars across Hub, Companion, and Player

## Decisions from the user
- “Feature” means featured-artist credits (`feat. X`), not audio analysis features.
- Stars are one shared, editable list across Hub, Windows Companion, and Music Player.
- Starring never implies copying audio. Hub and Companion get an opt-in automatic-download preference.
- Downloads remain gated by explicit, per-item authorization; when no basis is recorded, sync the star but do not queue audio.
- Do not adopt MusicSearch as a runtime dependency; its Flask API is not AudioWave-compatible and the GitHub repository has no detected license file.

## Implementation slices
- [x] **Direct-link metadata** — reuse AudioWave’s existing catalog hydration and confidence checks when resolving individual tracks. Keep fields null when no reliable match exists; expose featured artists from credited artist lists as `feat.`. Verified with focused domain and Hub/helper integration tests, three search DOM suites, PWA catalog-search E2E, typecheck, generated contracts, and styleguide gates.
- [ ] **Shared saved-item contract** — extend the typed catalog bookmark model for songs while retaining album/playlist compatibility. Store a single per-Hub shared set with stable identities, saved timestamps, and deletion tombstones; authorize writes only for admin or paired devices with `library:sync`.
- [ ] **Three-client sync** — wire Hub, Companion, and PWA star/unstar controls to that shared contract. Preserve offline retries and tombstones; catalog favorites are metadata/links only, never audio copies.
- [ ] **Auto-download preferences** — add explicit opt-in settings in Hub and Companion (default off). When enabled, starring a song asks once for its rights basis; starring an album/playlist asks once for a basis that applies to every track in that collection. If the person cancels or no source can download it, the star remains and no audio is queued. Never infer rights from provider availability.
- [ ] **Verification and generated views** — unit/integration/IPC/browser tests for cross-client add/remove and offline conflict cases; typecheck, builds, `pnpm verify`, regenerate affected mockups/styleguide artifacts.

## Acceptance criteria
- Resolved music links populate year, album, genre, primary artist, and featured credits when the catalog can confidently match them; unmatched videos or ambiguous recordings remain explicitly incomplete rather than receiving guessed metadata.
- A star or unstar performed in any of the three apps converges to the same Hub-backed song/album/playlist set, including after temporary offline use.
- No audio is downloaded merely because an item was starred. Auto-download is opt-in and requires a per-item authorization basis.
- Existing saved albums/playlists continue to parse and migrate without loss.
- The MusicSearch repository is not embedded or exposed as a service.

## Risks / checks
- Preserve existing Hub auth scopes and avoid publishing local file paths or locators in shared favorites.
- Stable song identity prefers ISRC/MusicBrainz IDs, then provider IDs, then a local content hash; title-only guesses must not merge distinct recordings.
- The Hub’s current admin/device star separation is intentionally changed only for this shared list; unrelated library ownership and playlist-folder permissions remain unchanged.
