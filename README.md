# Now Playing

Three music applications that work on their own and work better together.

|  | What it is | Runs on |
| --- | --- | --- |
| [**music-player**](music-player/README.md) | An offline-first player for the music already on your device. A web app you can install — or [one HTML file you double-click](docs/LOCAL_FILE.md), with no server at all. | Any modern browser |
| [**docker-container**](docker-container/README.md) | A self-hosted hub: your library on every device, group listening in sync, pairing, shared links, a Discord bot. | One `docker compose` command |
| [**windows-companion**](windows-companion/README.md) | A desktop app for the one thing a web page cannot do — read a folder of files off a Windows disk and keep watching it. | Windows 10 1809+ |

Each is independently useful. The player needs no hub and no account. The hub is useful with nothing
but a browser pointed at it. The companion is useful with no hub at all. Pairing them adds features;
it never becomes a requirement.

## Start with one

```sh
pnpm install

pnpm build:local    # one file: music-player/dist-local/now-playing.html — open it, no server needed

pnpm dev:player     # the player, on http://localhost:5173
pnpm dev:hub        # the hub API plus its admin GUI
pnpm dev:windows    # the companion, in Electron
```

Or, for the hub as it is actually meant to run:

```sh
cd docker-container && ./nowplaying install
```

## What this software will not do

These are design constraints, not disclaimers, and they are enforced in code and checked by tests:

- **It reports what it can actually do.** No button appears for something that will fail. Where a
  provider allows streaming but not downloading, the interface says so rather than offering a
  download that errors. A stream URL is never treated as a download link.
- **It does not bypass anything.** No DRM circumvention, no scraping, no reading a browser's
  cookies, no working around a provider's terms.
- **Nothing is sent anywhere you did not ask for.** No analytics, no telemetry, no crash reporting.
  The player works with the network off and never contacts a server you have not paired with.
- **Filesystem paths stay on the device that owns them.** Synced records carry a device id and a
  relative path; the absolute path never leaves. Enforced in one place per product, and checked by
  reading the hub's database after a real sync.
- **The hub never opens a port for you.** No UPnP, no NAT hole punching, no relay service. What
  works from where is a table in [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md), including the
  cases that do not work.
- **`admin` / `admin` works exactly once**, on a fresh install, and unlocks nothing until it is
  changed. Pairing, providers, group listening, the Discord bot and remote access all stay off
  until then — enforced by the server, not by the interface hiding buttons.

## How it is put together

```
packages/
  contracts/         one canonical Zod schema per concept; JSON Schema and OpenAPI are generated
  domain/            pure logic shared by all three: ids, queue, EQ precedence, retune, sync, metrics
  aqua-ui/           the component library, built to the Aqua spec in docs/design/
  audio-core/        the Web Audio graph: EQ, level-matched bypass, headroom, retune worklet
  recommendations/   the deterministic recommender and its offline evaluation
  test-fixtures/     generated audio and library fixtures, shared by every test suite
```

One schema is the source of truth for every wire format. Types, 71 JSON Schema documents and an
OpenAPI description of 119 operations across 97 paths are generated from it, and a contract test
asserts every route the contracts declare has a handler.

The interface follows `docs/design/APPLE_AQUA_2009_2010_UI_DESIGN_SPEC.md` under the profile
`AQUA_PROFILE=snow-leopard-itunes-9`. Its MUST items are release gates, each mapped to the test that
would fail in [docs/AQUA_CONFORMANCE.md](docs/AQUA_CONFORMANCE.md); where the implementation departs
from the spec, the reason is written down in [docs/DEVIATIONS.md](docs/DEVIATIONS.md).

## Documentation

**Start here**
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) — what was built, in what order, and why
- [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) — what is done, what is partial, what is not built
- [docs/architecture/OVERVIEW.md](docs/architecture/OVERVIEW.md) — how the three products fit together

**Behaviour**
- [docs/PRIVACY.md](docs/PRIVACY.md) — what is stored, where, and what leaves a device
- [docs/SECURITY.md](docs/SECURITY.md) — the threat model and the controls
- [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md) — the truth table for reaching a hub
- [docs/PROVIDER_CAPABILITIES.md](docs/PROVIDER_CAPABILITIES.md) — what each provider actually permits
- [docs/DOWNLOADS_AND_LEGAL.md](docs/DOWNLOADS_AND_LEGAL.md) — when a download is offered and when it is not
- [docs/PWA_AND_CAR.md](docs/PWA_AND_CAR.md) — installing, offline, lock screens, and Android Auto
- [docs/LOCAL_FILE.md](docs/LOCAL_FILE.md) — the single file you open with no server, and what a `file://` page can and cannot do
- [docs/DISCORD_BOT.md](docs/DISCORD_BOT.md) — the bot, and how slash and prefix commands stay identical

**Detail**
- [docs/API.md](docs/API.md) · [docs/DATA_MODEL.md](docs/DATA_MODEL.md) ·
  [docs/architecture/](docs/architecture/) · [docs/adr/](docs/adr/) ·
  [docs/TESTING.md](docs/TESTING.md) · [docs/DEVIATIONS.md](docs/DEVIATIONS.md) ·
  [docs/AQUA_CONFORMANCE.md](docs/AQUA_CONFORMANCE.md) ·
  [LICENSES.md](LICENSES.md)

## Verifying it

```sh
pnpm verify
```

Runs every release gate available on the machine it is run on — generation, formatting, linting,
typechecking, unit, DOM, contract, integration and security tests, the builds, the performance
budgets, accessibility and end-to-end suites, and the Docker image build. Gates that cannot run on
this platform (Windows packaging; Docker when the daemon is unavailable) are reported as **skipped**,
never as passed.

[docs/TESTING.md](docs/TESTING.md) explains what each suite covers and how to run one at a time.

## Licence

MIT. Third-party licences are collected in [LICENSES.md](LICENSES.md), generated from the installed
production dependencies by `node scripts/licenses.mjs`.
