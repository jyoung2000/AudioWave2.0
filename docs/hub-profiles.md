# Claude Code prompt — profiles on the hub (docker-container)

Paste this into Claude Code at the root of the AudioWave2.0 repo.

---

Add **user profiles** to the hub in `docker-container`, so a paired player can keep a username, a
picture and shared playlists on the hub, and find other people's. The Airwave player already
calls these routes (Settings ▸ Profile, and people results in search); until they exist it tells the
user the container "doesn't keep profiles yet". Follow AGENTS.md: contracts first, then server,
migration, tests, admin GUI, docs; run `pnpm styleguide:check`, `pnpm styleguide:build` and
`pnpm styleguide:pdf` if you touch the admin GUI.

## Contract (packages/contracts)

Add to `api/routes.ts`, all under `/api/v1`, `auth: 'device'`:

| Route | Body / query | Response | Scope |
|---|---|---|---|
| `GET /profiles/me` | — | `ProfileView` | `profile:read` |
| `PATCH /profiles/me` | `{ displayName }` | `ProfileView`; **409** if the name is taken | `profile:write` |
| `GET /profiles/available?name=` | name | `{ available: boolean }` | `profile:read` |
| `PUT /profiles/me/avatar` | raw `image/png`, `image/jpeg` or `image/webp`, ≤ 512 × 512, ≤ 1 MB | `Ok` | `profile:write` |
| `DELETE /profiles/me/avatar` | — | `Ok` | `profile:write` |
| `GET /profiles/:id/avatar` | — | the image, `Cache-Control: private, max-age=300` | `profile:read` |
| `PUT /profiles/me/playlists/:playlistId?name=` | raw `text/csv`, ≤ 2 MB, ≤ 5,000 rows | `Ok` | `profile:write` |
| `DELETE /profiles/me/playlists/:playlistId` | — | `Ok` | `profile:write` |
| `GET /profiles?q=&limit=` | name contains q, case-insensitive, limit ≤ 20 | `{ items: ProfileSummary[] }` (never includes the caller) | `profile:read` |
| `GET /profiles/:id` | — | `ProfileView` | `profile:read` |
| `GET /profiles/:id/playlists/:playlistId.csv` | — | `text/csv; charset=utf-8` | `profile:read` |

```ts
ProfileSummary = { id: Uuid, displayName: DisplayName, avatarUrl: string | null, playlistCount: number }
ProfileView    = { id: Uuid, displayName: DisplayName, avatarUrl: string | null,
                   playlists: { id: string, name: string, tracks: number, updatedAt: IsoDateTime }[] }
```

- `avatarUrl` is the hub-relative path `/api/v1/profiles/:id/avatar`, or null.
- Add `'profile:read'` and `'profile:write'` to `Scope` in `common.ts`, and to the player's default
  pairing scopes in the admin GUI's Devices view.
- A profile belongs to the **HubUser** behind the device credential (`HubUser.displayName` and
  `HubUser.avatar` already exist — reuse them rather than adding a parallel table).

## Rules the server enforces

- **Usernames are unique** per hub, compared case-insensitively after Unicode NFC normalisation and
  trimming. Enforce it with a unique index on the normalised name, not only a check in code, so two
  simultaneous saves can't both win. 3–40 characters: letters, numbers, spaces, `.`, `_`, `-`;
  must start and end with a letter or number. `admin` and names that differ from an existing one only
  by case are taken.
- Avatars: verify the bytes are really PNG/JPEG/WebP (magic numbers), re-encode server-side to
  256 × 256 WebP, strip metadata, store in the data volume as a blob (`Avatar.kind = 'image'`).
- Playlists: parse the CSV (header `title,artist,album,seconds`; RFC 4180 quoting), store it
  normalised, and serve it back re-serialised — never echo the uploaded bytes. Strip leading `=`, `+`,
  `-`, `@` from cells when serving CSV (spreadsheet formula injection).
- Search and profile reads are available only to paired devices with `profile:read`; no anonymous
  access. The first-run gate applies: nothing here works until the admin password is changed.
- Rate-limit writes like other device writes; log with the configured IP logging mode.

## Server, storage, tests

- Migration: `profile_playlists (user_id, playlist_id, name, csv, tracks, updated_at)`, primary key
  `(user_id, playlist_id)`; unique index on `lower(normalised display_name)`.
- `docker-container/src/profiles/service.ts` + routes in `src/api/routes/profiles.ts`.
- Include avatars and profile playlists in `./nowplaying backup` / Backup ▸ Export.
- Integration tests: name uniqueness (including a race of two PATCHes), 409 body, avatar type
  sniffing and re-encoding, CSV round-trip with quoted commas, formula-cell stripping, scope checks,
  search excludes the caller, first-run gate.
- Admin GUI: a **Profiles** view under Hub (name, picture, playlist count, last change) with Rename and
  Remove picture for moderation.
- Docs: add the routes to `docs/API.md`, and a line to `docs/PRIVACY.md` saying profiles are visible to
  every device paired with the same hub.
