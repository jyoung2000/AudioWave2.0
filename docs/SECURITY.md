# Security

This document is the threat model and the list of concrete mitigations for the Now Playing suite. Every mitigation names where it lives and how it is tested. Report vulnerabilities privately to the repository owner; do not open public issues for exploitable bugs.

## Trust boundaries

```text
┌──────────────────────┐   HTTPS/WSS (device credential)   ┌──────────────────────────┐
│ Player (browser PWA) │ ────────────────────────────────▶ │ Hub (Docker, port 4546)  │
│ owns: dir handles,   │ ◀──────────────────────────────── │ owns: admin auth, pairing│
│ Solo queue/history,  │      events, snapshots, files     │ provider secrets, groups,│
│ local metrics, EQ    │                                   │ downloads, Discord       │
└──────────────────────┘                                   └───────────┬──────────────┘
          ▲                                                            ▲
          │ pairing (QR/deep link, fingerprint confirm)                │ outbound HTTPS only
          ▼                                                            ▼
┌──────────────────────┐   HTTPS/WSS (device credential)   ┌──────────────────────────┐
│ Companion (Electron) │ ────────────────────────────────▶ │ Providers (official APIs)│
│ owns: filesystem,    │                                   │ YouTube, SoundCloud,     │
│ OAuth tokens (DPAPI) │                                   │ Spotify, MusicBrainz, …  │
└──────────────────────┘                                   └──────────────────────────┘
```

- The player never receives provider secrets or another user's raw history. It authenticates to a hub with a scoped device credential obtained through pairing.
- The hub is authoritative for group state and holds application-level provider credentials (admin-configured) and per-user tokens (encrypted with an installation key). It binds to loopback until the bootstrap password is replaced.
- The companion's renderer is sandboxed; every filesystem, credential, process and network operation is authorized in the main process behind a typed `contextBridge` API.
- Absolute filesystem paths never leave the device that owns them; other devices see opaque locator ids and user-approved bytes only.

## Threats and mitigations

| Threat | Mitigation | Where | Tests |
|---|---|---|---|
| Malicious search/resolve URLs, SSRF | Scheme + host allowlist per provider, private/link-local/metadata/CGNAT/mapped-IPv4/obfuscated-IP blocks, DNS-resolution check before connect, size/time caps, MIME sniffing | `packages/domain/src/security.ts` (`validateOutboundUrl`, `isPrivateAddress`, `isResolvedAddressAllowed`), hub `providers/http.ts` | `packages/domain/tests/unit/security.test.ts`, hub `tests/security` |
| DNS rebinding / local-network requests | Resolved addresses re-validated after lookup; hub CORS denies cross-origin; Origin checks on state changes; `Host` must match configured endpoints in remote mode | hub `providers/http.ts`, `auth/` | hub security tests |
| Path traversal, unsafe filenames | `isSafeRelativePath`, `joinInsideRoot`, `sanitizeFilename` (control chars, reserved names, separators, length), templates rendered through the sanitizer; hub roots must be inside `/data` | domain `security.ts`; hub `library/`, `downloads/`; companion `services/` | domain unit tests; hub security tests |
| Hostile media metadata / artwork | music-metadata parsed in workers/child scopes with size caps; artwork re-encoded to fixed sizes before display; titles escaped by React; no HTML from tags | player indexing worker; companion scanner; hub `library/` | player unit tests |
| Oversized files / decompression bombs | Streaming size caps (2 GB files skipped, 20 MB CSV/JSON imports, 16 MB artwork), gzip disabled for uploads, chunked file uploads with `total` bound | hub `sync/files`, imports | hub security tests |
| Malicious CSV/JSON imports | Header/type/size validation via contracts schemas, spreadsheet-formula prefix neutralisation on export and strip on import, dry run, idempotent event ids, no code execution on import (JSON preset import is data only) | domain `csv.ts`, `eq.ts`, `playlist-formats.ts` | domain unit tests; hub history round-trip tests |
| WebSocket hijacking / replay | Authenticated upgrade (credential in subprotocol/token or admin cookie), Origin check for cookie auth, per-message re-authorization, revision + idempotency keys, replay from acknowledged seq only, duplicate suppression, heartbeat timeouts | hub `realtime/` | hub integration tests (reconnect/replay/stale revision/duplicate) |
| Pairing-code brute force / replay | 50-bit Crockford codes, 10-minute TTL, 5 attempts per session then revoked, per-IP token bucket, only a salted hash stored, single-use `complete`, fingerprint confirmation by an authorized user, codes never logged | domain `pairing.ts`; hub `pairing/` | domain + hub pairing tests |
| Compromised device credential | Scoped (`Scope` enum), revocable (cascades and closes sockets), hashed at rest, last-used tracking, admin list/revoke; no permanent bearer from a code | hub `auth/`, `devices` | hub tests |
| CSRF / XSS / CORS / CSP | HttpOnly SameSite=Strict session cookie, double-submit CSRF token on every non-GET admin request, Origin/Referer checks, strict CSP (`default-src 'self'`, no inline scripts), `frame-ancestors 'none'`, React escaping, no `dangerouslySetInnerHTML`, no CDN | hub `auth/`, `app.ts` | hub security tests (cookie flags, CSP, CSRF) |
| Admin credential stuffing | Argon2id (64 MiB, t=3), login rate limit 10/min/IP, generic error messages, session rotation on password change, audit log | hub `auth/` | hub auth tests |
| Discord token leakage / command abuse | Token from env or encrypted with the installation key, never returned or logged (only last 4), permission checks in one shared command service, cooldowns, per-user limits, designated channel, mention escaping + `allowed_mentions: []`, template length limits | hub `discord/`, domain `permissions.ts`, `templates.ts` | domain tests; hub command-service parity tests |
| Provider token refresh/revocation | Refresh handled server-side; failures mark accounts `expired` and prompt re-auth; disconnect revokes remotely where the API allows and deletes locally | hub `providers/`, companion `services/providers` | hub tests with fixture adapters |
| FFmpeg / process injection, resource exhaustion | `execFile` with argument arrays only, allowlisted flags, timeouts, output size caps, bounded concurrency, disk-space preflight | hub `downloads/`, companion transcoding | hub tests |
| Electron IPC / navigation abuse | `contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity`, CSP, `setWindowOpenHandler` deny, `will-navigate` allowlist, one validated method per IPC channel (zod), no raw `ipcRenderer` exposure | companion `main/`, `preload/` | companion unit tests |
| Proxy / IP spoofing | `X-Forwarded-For` trusted only from configured CIDRs; IPs displayed truncated (default) or keyed-hash; full IPs only when explicitly enabled with retention | hub `network/` | hub tests |
| Log / diagnostic secret leakage | pino redaction paths + `redactSecrets` deep redaction; diagnostics bundle excludes tokens, full IPs, raw history, audio and user paths | hub `observability/`; domain `security.ts` | domain + hub tests |
| Supply chain / license | Pinned versions in lockfile, `pnpm audit` in CI (fails on high/critical), only allowlisted build scripts (`onlyBuiltDependencies`), `LICENSES.md` generated from installed packages, no CDN at runtime | root `pnpm-workspace.yaml`, `.github/workflows/ci.yml`, `scripts/licenses.mjs` | CI |
| Data integrity during migrations | Backup before migrating an existing database; migrations run in a transaction; restore takes a safety backup first | hub `db/`, `backup/` | hub tests |

## Cryptography
- Password hashing: Argon2id via `@node-rs/argon2` (memory 65536 KiB, iterations 3, parallelism 1, 16-byte random salt).
- Session ids, pairing claim secrets, credential secrets: 32 random bytes from `crypto.getRandomValues`/`randomBytes`, stored as SHA-256 hashes, compared in constant time.
- Secrets at rest (provider app secrets, user tokens, Discord token): AES-256-GCM with a per-installation key file (`<data>/keys/install.key`, mode 0600) — separate from the database so a database copy alone does not expose secrets.
- Hub identity: Ed25519 keypair; fingerprint = grouped SHA-256 prefix; pairing verification fingerprint mixes both public keys and the session id.
- Companion secrets: Electron `safeStorage` (Windows DPAPI). Limitation: any process running as the same Windows user can decrypt them; this is documented in the companion README.

## Transport
- Loopback HTTP is acceptable only for first setup on the same machine. LAN and remote modes require TLS termination (reverse proxy) and set `Secure` cookies; see `docs/REMOTE_ACCESS.md`.
- Direct player↔companion pairing on the same network uses the same authenticated TLS transport; nothing is exposed on a raw public port.

## What is deliberately not done
- No UPnP, no automatic port opening, no third-party tunnel provisioning.
- No browser-cookie extraction, no DRM circumvention, no scraping of services that prohibit it.
- No telemetry to the developer.
