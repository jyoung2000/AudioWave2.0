# Privacy

Airwave is local-first. This page states what is stored where, what is shared, and how to inspect, export, delete or revoke it. The same rules are implemented as settings in the player (Settings → Privacy) and the hub (Security, Network, Recommendations).

## Data locations

| Data | Default location | Leaves the device? |
|---|---|---|
| Library index (titles, artists, albums, durations, content hashes), artwork thumbnails | Player: IndexedDB `now-playing-*`; Companion: SQLite in `%APPDATA%\now-playing-companion`; Hub: `/data/hub.sqlite` | Only through explicit sync/sharing scopes you grant a paired device |
| Directory handles / file paths | Player: IndexedDB (serialized handles); Companion: local SQLite | Never. Other devices only see opaque locator ids |
| Solo queue, Solo history | Player local storage | Never copied into a Group session or to friends |
| Listening events (append-only) | Player local; Companion local; Hub only when the `history:events` scope is granted for hub-side personalisation | Only with explicit scope |
| Aggregate taste profile (weights per artist/genre/album/era, hour-of-day histogram; no titles, no timestamps) | Computed locally; uploaded to a hub only after opting in per group (`history:aggregate`) | Only when opted in; preview before sharing; revoke/delete anytime |
| Profile name and avatar | Local; shared with a hub only when "Share with hubs" is on | Optional |
| Provider accounts / tokens | Hub (encrypted) or Companion (OS-protected). The player never holds provider tokens | Tokens are never returned to any client |
| IP addresses (hub) | Truncated form (`203.0.113.x`) retained 7 days by default; optional keyed hash; full IPs only when an admin explicitly enables it with a retention period and a warning | — |
| Shareable links | Hub: link metadata + uploaded item lists (titles/artists/durations) | Public to anyone with the link until revoked/expired |

## Scopes granted at pairing
`library:read`, `library:share`, `playlists:sync`, `eq:sync`, `history:aggregate`, `history:events`, `group:member`, `group:admin`, `downloads:request`, `transfers:receive`, `files:serve`, `search:use`, `shares:create`, `profile:read`, `profile:write`, `backup:read`. Every scope is visible on the device card and can be revoked by the hub admin; the device shows its own scopes under Settings → Devices.

## Profiles
A profile — username, picture and the playlists its owner chose to share — is visible to every device paired with the same hub, and to nobody else: there is no anonymous access and no public profile page. Pictures are re-encoded on the hub with their metadata removed (no EXIF location survives). An invite addressed to a profile shows the sender's name and the group's name and member count to its addressee, never the member list.

## Group aggregate sharing
- Off by default. Turning it on shows a preview of the exact aggregate that will be uploaded.
- Comparisons require a minimum cohort (default 3 opted-in members) and a minimum sample (20 meaningful listens); incomplete data is labelled.
- A hub admin sees group-level overlaps, not any member's raw timeline.

## Retention and deletion
- Listening history retention window is user-configurable (default 365 days; events older than the window are compacted into aggregates and deleted).
- "Export my data" produces JSON (events, playlists, presets, profile) from the player; the hub exports groups/history/playlists without secrets.
- "Delete listening history", "Reset metrics", "Forget hub", and "Revoke device" are immediate and local; the hub removes the device's credentials, shared aggregates and (if requested) ingested events.
- Tombstones for synced records are kept 30 days for convergence, then compacted.

## Telemetry
None is sent to the developer. Provider APIs receive only the requests needed for the feature you use (search terms, ids, OAuth flows) under their own privacy policies, which the About page links to.
