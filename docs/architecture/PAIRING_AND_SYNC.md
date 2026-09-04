# Pairing and sync

## Hub identity vs pairing session
- **Hub identity** is stable: `hubId` (UUIDv7), an Ed25519 keypair under `/data/keys`, and a fingerprint (`AB12-CD34-…`). Every QR/deep link and every device record carries it.
- **Pairing session** is short-lived and single-use: a 10-character Crockford Base32 code (50 bits of entropy), default TTL 10 minutes, at most 5 claim attempts, one claim at a time, stored only as `sha256("pairing-code:v1:" + hubId + ":" + code)`.

## Flow
1. An authenticated admin (or a device with `group:admin`) chooses device kind and scopes → `POST /api/v1/pairing/sessions` → code, expiry, deep link `nowplaying://pair#<base64url JSON {v, code, endpoint, hubId, fp, exp}>`, QR SVG. When the hub has no known endpoint the response says `endpointKnown: false` and the UI explains that code-only entry works only in apps that already know the hub.
2. The joining device presents `code`, its name, an ephemeral public key, app and protocol version → `POST /api/v1/pairing/claim` (rate-limited per IP; wrong codes count attempts and revoke at the limit) → `claimSecret`, `verificationFingerprint` (SHA-256 over both public keys + session id), hub fingerprint/name.
3. Both sides display the verification fingerprint. An authorized user confirms in the admin GUI (`…/confirm`), comparing what the device shows.
4. The device polls `/pairing/status` and then calls `/pairing/complete` once; the session is consumed atomically and a `Device` + `DeviceCredential` (secret hashed at rest) are created. The secret is returned exactly once; replaying `complete` returns 409.
5. Devices authenticate with `Authorization: Bearer <credentialId>.<secret>` (or the same in the WebSocket subprotocol). Admin can list, re-scope and revoke; revocation closes live sockets with a `device.revoked` event.

Tests: brute force, expiry (injected clock), replay, revocation, rate limit (`docker-container/tests/integration/pairing*.test.ts`, `packages/domain/tests/unit/pairing.test.ts`).

## Remote reality
A short code cannot locate a private machine on the internet. The deep link/QR carries the endpoint; code-only entry works only when the app already knows the hub or a configured rendezvous directory can resolve the hub id. Without a reachable hub, companion ↔ player pairing is same-network only over an authenticated TLS transport. See `docs/REMOTE_ACCESS.md`.

## Sync protocol (companion ↔ hub, player ↔ hub)
- **Manifest exchange** (`POST /sync/manifest`): per-collection `{count, maxUpdatedAt, digest}` where the digest is SHA-256 over sorted `(id, updatedAt, deleted)` tuples. Collections with equal digests are skipped.
- **Delta exchange** (`POST /sync/delta`): the requester pushes changes since its per-collection cursor and receives the peer's changes. Each change has a `changeId` (UUIDv7); applying the same changeId twice is a no-op (idempotent retries). Tombstones are changes with `deleted: true` and no body.
- **Merge rules** (`packages/domain/src/sync.ts`): tombstone-wins over older/equal updates; otherwise last-writer-wins by `updatedAt`; exact ties break on the lexically larger `changeId` so both sides converge; conflicts are reported (`kept-local | kept-remote | kept-both | tombstone-wins`).
- **Never synced**: absolute paths, provider secrets, Solo queue/history (unless the `history:events` scope is granted for hub-side personalisation), full IPs.
- **Files**: content-addressed (`/files/:sha256`) chunked uploads with offset/total, `.partial` staging, checksum verification on completion, atomic rename. Transfers between devices route through hub blobs; `both` completes only when both destinations verified the checksum; a verified-only copy is never deleted by sync.
- **Tombstone compaction**: after 30 days and only when every known peer's cursor has passed the tombstone (`tombstonesToCompact`).
- **Protocol mismatch**: `SyncManifest.protocolVersion` outside the supported range → 426 with an upgrade-required state; nothing is applied.

Tests: offline edits on both sides, reconnect, tombstones, duplicate changes, mismatch, interrupted file transfer (`docker-container/tests/integration/sync*.test.ts`, `windows-companion/tests/integration/sync*.test.ts`).
