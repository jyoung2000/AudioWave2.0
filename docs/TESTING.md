# Testing

Every suite here runs against real code. Nothing is mocked at module level; what gets replaced is
only what would otherwise make a test slow, flaky or network-dependent — the clock, the random
source, outbound HTTP, DNS, and FFmpeg discovery. A test failing means something is genuinely broken,
not that a stub has drifted from the thing it stands in for.

## Everything at once

```sh
pnpm verify
```

Runs every release gate available on this machine and prints a table. Gates that cannot run on this
platform — Windows packaging, or Docker when the daemon is unavailable — are reported as **SKIPPED**,
never as passed.

## The suites

| Project | Where | What it covers | Count |
| --- | --- | --- | --- |
| `unit` | `packages/*/tests/unit`, `*/src/**/*.test.ts` | Pure logic: ids, the queue reducer, EQ precedence, retune maths, sync rules, CSV, metrics, the recommender, library scanning | ~200 |
| `dom` | `**/tests/dom`, `*.dom.test.tsx` | Components and app shells rendered in happy-dom, driven with real user events | ~30 |
| `contracts` | `packages/contracts/tests`, `**/tests/contract` | Every schema round-trips; every route the contracts declare has a handler; the release manifest parses | ~10 |
| `integration` | `**/tests/integration` | A real hub (real Fastify, real SQLite, real argon2) and, for the companion, its real client against that hub | ~100 |
| `security` | `**/tests/security` | The controls, as behaviour: the sanitiser, the channel allowlist, CSP, SSRF, rate limits, authorization | ~40 |
| `perf` | `tests/perf` | Bundle budgets measured from built output | 8 |
| e2e (Playwright) | `music-player/tests/e2e`, `docker-container/tests/e2e` | Real browsers against real production builds, including axe on every screen of both interfaces | 45 |

```sh
pnpm test               # unit + dom + contracts + integration
pnpm test:security
pnpm build && pnpm test:perf      # budgets need the build first
pnpm test:e2e           # player and hub, both against production builds
pnpm test:a11y          # the axe pass: nine player screens and thirteen admin views

pnpm exec vitest run --project unit windows-companion   # one project, one path
```

## What the awkward suites actually do

**The hub integration harness** (`docker-container/tests/helpers/hub.ts`) builds the whole
application and replaces five edges: a clock the test moves by hand, a seeded random source so
generated pairing codes and share tokens are reproducible, a `fetch` that fails loudly on any URL the
test did not register, a DNS stub, and FFmpeg discovery. Argon2 runs at its minimum work factor —
same algorithm, same code path, a millisecond instead of a second.

**The companion integration tests** run the companion's real `HubClient` and SQLite store against the
hub's real Fastify application, with only the transport replaced (`fetch` routed into the injector).
That is the only place the two products' agreement about pairing, sync and transfers is actually
checked. After a full sync they read the hub's database directly and assert no Windows path appears
anywhere in it — proving the privacy claim rather than trusting the sanitiser that implements it.

**The hub e2e suite** boots the built server against a fresh data directory and drives the admin GUI
in Chromium. It is split into a setup project that walks the first-run gate and saves a session, and
a test project that reuses it — because the hub rate-limits `/auth/login` to ten attempts, and a
suite that exhausts that would turn a working security control into a flaky test. The assertions that
matter most are made with `request`, straight at the API: a gate you can walk around by calling the
API directly is not a gate.

**The main-process test** boots the companion's Electron main process with Electron itself stubbed
but everything else real — the database is created on disk, the IPC handlers are the actual ones, and
requests and responses go through the same validation the packaged app uses.

**The performance budgets** parse the built `index.html`, add up what it actually references, and
compare against a number. They also check that expensive dependencies stayed out of the entry chunk,
because a budget that only counts bytes can be satisfied by moving code around rather than by loading
less of it.

## The ten acceptance flows

The plan's ten end-to-end flows each have a home, so a flow number resolves to a file rather than to
a claim:

| Flow | Where |
| --- | --- |
| 1. First run | `docker-container/tests/integration/setup-and-pairing.test.ts`, and in a browser in `tests/e2e/first-run.setup.ts` |
| 2. Pairing a device | `setup-and-pairing.test.ts`; the pairing screen in `tests/e2e/hub.spec.ts` |
| 3–5. Group listening, the authoritative queue, Discord parity | `groups-and-queue.test.ts`, `discord-parity.test.ts` |
| 6–8. Shared links, companion sync, device-to-device transfers | `shares-and-sync.test.ts`, and `windows-companion/tests/integration/companion-and-hub.test.ts` for the companion's half |
| 9. Discovery and recommendations | `discovery-engine.test.ts` |
| 10. Requesting a download | `tests/security/ssrf-and-downloads.test.ts` |

## Writing a test here

- **Assert behaviour, not implementation.** The three defects found while building this — history
  that reordered itself between reads, play restarting the current track, a sync that re-imported
  everything forever — were all invisible to tests of internals and obvious to tests of behaviour.
- **Make failure diagnosable.** Put the numbers in the message: `expect(kb(total), \`first load is
  ${kb(total)}KB against a ${budget}KB budget\`)`. A failure should say what to do.
- **Prove the test can fail.** After fixing a bug, revert the fix and watch the new test go red. A
  guard that passes either way is not a guard. Several tests here carry a comment naming the exact
  bug they were written against.
- **A flake is a bug until proven otherwise.** The group-history flake was a real ordering defect
  that would have shipped. Re-running until green teaches you nothing.

## In CI

[`ci.yml`](../.github/workflows/ci.yml) runs the Linux gates: generation, lint, typecheck, every
Vitest project, the builds, then Playwright for accessibility and e2e.
[`windows-companion.yml`](../.github/workflows/windows-companion.yml) runs on `windows-latest` and
additionally packages the installer and the portable build, writes `SHA256SUMS.txt` and
`latest.json`, and uploads them.
