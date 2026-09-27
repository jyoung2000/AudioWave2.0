#!/usr/bin/env node
/**
 * `pnpm verify` — runs every non-destructive release gate available on the current platform and prints a table.
 * Gates that cannot run here (Windows packaging off Windows, Docker when the daemon is unavailable) are reported as skipped, never as passed.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

const results = [];
const start = Date.now();
const only = process.argv.slice(2);

/**
 * Spawn a command the same way on every platform.
 *
 * `pnpm` and `npx` are `.cmd` shims on Windows, and since Node 20.12 `spawnSync` refuses to run a
 * `.cmd` without a shell (the fix for CVE-2024-27980). It does not throw: it returns `status: null`,
 * so every gate in this file reported "exit null" and `pnpm verify` failed completely on Windows
 * while saying nothing about why. Arguments are quoted here because a shell is doing the parsing.
 */
function spawnPortable(cmd, args, options = {}) {
  if (process.platform !== 'win32') return spawnSync(cmd, args, options);
  const quoted = args.map((arg) => (arg.includes(' ') || arg.includes('"') ? `"${arg.split('"').join('\\"')}"` : arg));
  return spawnSync(cmd, quoted, { ...options, shell: true });
}

/**
 * Where a failed gate's Playwright output is kept. Every suite writes `playwright-report/` and
 * `test-results/` beside its config and overwrites them on the next run, so by the time a one-off
 * failure is looked into the evidence has usually been replaced by a green run. A gate that names
 * `artifacts` has those directories copied here when it fails — one folder per verify run, one per
 * gate — and the summary says where.
 */
const ARTIFACTS_ROOT = join(process.cwd(), '.verify-artifacts', new Date().toISOString().replace(/[:.]/g, '-'));

function keepArtifacts(name, dirs) {
  const kept = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    // Gate names carry colons (test:e2e), which Windows refuses in a folder name.
    const dest = join(ARTIFACTS_ROOT, name.replace(/[:*?"<>|]/g, '-'), dir.replace(/[/\\]/g, '__'));
    mkdirSync(dest, { recursive: true });
    cpSync(dir, dest, { recursive: true });
    kept.push(dest);
  }
  return kept;
}

function run(name, cmd, args, { optional = false, skipIf = null, env = {}, artifacts = [] } = {}) {
  if (only.length && !only.includes(name)) return;
  if (skipIf) {
    const reason = skipIf();
    if (reason) {
      results.push({ name, status: 'SKIPPED', detail: reason, ms: 0 });
      console.log(`\n== ${name}: skipped (${reason})`);
      return;
    }
  }
  console.log(`\n== ${name}: ${cmd} ${args.join(' ')}`);
  const t = Date.now();
  const r = spawnPortable(cmd, args, { stdio: 'inherit', env: { ...process.env, CI: process.env.CI ?? '1', ...env } });
  const ok = r.status === 0;
  const kept = ok ? [] : keepArtifacts(name, artifacts);
  const detail = ok ? '' : kept.length ? `exit ${r.status}; report kept at ${kept.join(', ')}` : `exit ${r.status}`;
  results.push({ name, status: ok ? 'PASS' : optional ? 'WARN' : 'FAIL', detail, ms: Date.now() - t });
}

/**
 * A gate that runs a check in-process and reports like the spawned ones. `fn` returns null when the
 * gate passes and a one-line reason when it does not.
 */
function check(name, fn) {
  if (only.length && !only.includes(name)) return;
  console.log(`
== ${name}`);
  const t = Date.now();
  let detail;
  try {
    detail = fn();
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }
  if (detail) console.log(detail);
  results.push({ name, status: detail ? 'FAIL' : 'PASS', detail: detail ?? '', ms: Date.now() - t });
}

/**
 * What the unpacked Windows build must contain: the executable under the product's own name, the
 * app archive, and — when this machine built the streaming server — the sidecar beside it. The
 * identity itself (appId = the runtime AppUserModelID) is pinned by
 * windows-companion/tests/contract/app-identity.test.ts; this checks the build carried it out.
 */
function windowsPackageContents() {
  const root = join('windows-companion', 'release', 'win-unpacked');
  const missing = [];
  for (const rel of ['Now Playing Companion.exe', join('resources', 'app.asar')]) if (!existsSync(join(root, rel))) missing.push(rel);
  const sidecarBuilt = existsSync(join('windows-companion', 'awsp-server', 'target', 'release', 'awsp-server.exe'));
  if (sidecarBuilt && !existsSync(join(root, 'resources', 'awsp-server.exe'))) missing.push(join('resources', 'awsp-server.exe'));
  return missing.length ? `${root} is missing: ${missing.join(', ')}` : null;
}

/**
 * LICENSES.md is generated from the installed production dependency graph, so it goes stale the
 * moment a dependency is added, removed or bumped. Rendered to a temp file and compared, so the
 * gate never leaves the working tree dirty.
 */
function licensesUpToDate() {
  const dir = mkdtempSync(join(tmpdir(), 'np-licenses-'));
  try {
    const fresh = join(dir, 'LICENSES.md');
    const r = spawnSync(process.execPath, ['scripts/licenses.mjs', fresh], { stdio: 'inherit' });
    if (r.status !== 0) return `scripts/licenses.mjs exited ${r.status}`;
    const committed = existsSync('LICENSES.md') ? readFileSync('LICENSES.md', 'utf8') : '';
    if (readFileSync(fresh, 'utf8') !== committed) return 'LICENSES.md is stale — run `node scripts/licenses.mjs`';
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The installable app icons are rendered from the committed SVGs. They are build outputs that
 * happen to be committed (a web app manifest cannot point at an SVG for Android's maskable icon),
 * so editing an SVG without re-running the renderer leaves the app wearing the old artwork. That
 * happened: `icon.svg` was re-centred and all four PNGs stayed a day behind it.
 *
 * Rendered to a temp directory and compared byte for byte, so the gate never dirties the tree.
 * Skipped rather than failed when there is no browser to render with.
 */
function iconsUpToDate() {
  const dir = mkdtempSync(join(tmpdir(), 'np-icons-'));
  try {
    const r = spawnPortable('pnpm', ['--filter', '@now-playing/music-player', 'icons', dir], { stdio: 'inherit' });
    if (r.status !== 0) return `the icon renderer exited ${r.status}`;
    const stale = readdirSync(dir).filter((name) => !readFileSync(join('music-player', 'public', name)).equals(readFileSync(join(dir, name))));
    if (stale.length) return `${stale.join(', ')} differ from the SVGs - run \`pnpm --filter @now-playing/music-player icons\``;
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The helper is a single file people are told to download and run. `dist/` is git-ignored and
 * nothing published it, so that instruction pointed at a file no one could reach; the bundle is
 * therefore committed at `local-helper/now-playing-helper.mjs`, exactly as `now-playing.html` is
 * committed at the root. Rebuilt to a temp directory and compared, so the gate leaves no mess.
 */
function helperUpToDate() {
  const dir = mkdtempSync(join(tmpdir(), 'np-helper-'));
  try {
    const r = spawnPortable('pnpm', ['--filter', '@now-playing/local-helper', 'build', dir], { stdio: 'inherit' });
    if (r.status !== 0) return `the helper build exited ${r.status}`;
    const committed = join('local-helper', 'now-playing-helper.mjs');
    if (!existsSync(committed)) return `${committed} is missing - run \`pnpm build:helper\``;
    if (!readFileSync(join(dir, 'now-playing-helper.mjs')).equals(readFileSync(committed))) {
      return `${committed} is stale - run \`pnpm build:helper\``;
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The AWSP streaming server is Rust (windows-companion/awsp-server). Cargo is found on PATH or in
 * the rustup default location; without it the gate reports SKIPPED, never PASS.
 */
const cargoBin = (() => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const local = `${home}/.cargo/bin/cargo${process.platform === 'win32' ? '.exe' : ''}`;
  if (spawnPortable('cargo', ['--version'], { stdio: 'ignore' }).status === 0) return 'cargo';
  if (home && existsSync(local)) return `"${local}"`;
  return null;
})();
const hasCargo = () => (cargoBin ? null : 'cargo not installed');

const hasDocker = () => {
  if (process.env.NP_SKIP_DOCKER === '1') return 'NP_SKIP_DOCKER=1';
  const r = spawnPortable('docker', ['info'], { stdio: 'ignore' });
  return r.status === 0 ? null : 'docker daemon unavailable';
};
/**
 * Whether there is a browser to drive.
 *
 * Asked of Playwright itself rather than by spawning `npx`: `npx` is `npx.cmd` on Windows and
 * `spawnSync` will not run a `.cmd` without a shell, so that check failed on every Windows machine
 * and quietly skipped four real gates (`test:local`, `test:a11y`, `test:e2e`, `styleguide:pdf`) on
 * a box that could have run all of them. A gate that skips when it could have run is worse than one
 * that fails, because nobody goes looking.
 */
const hasChromium = () => {
  const explicit = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (explicit && existsSync(explicit)) return null;
  try {
    const { chromium } = require('playwright');
    const binary = chromium.executablePath();
    return binary && existsSync(binary) ? null : 'playwright browsers not installed (run `pnpm exec playwright install chromium`)';
  } catch (err) {
    return `playwright is not usable here (${err instanceof Error ? err.message : String(err)})`;
  }
};

run('generate', 'pnpm', ['generate']);
run('generated-up-to-date', 'git', ['diff', '--exit-code', '--', 'packages/contracts/generated', 'packages/test-fixtures/generated']);
check('licenses-up-to-date', licensesUpToDate);
if (hasChromium()) results.push({ name: 'icons-up-to-date', status: 'SKIPPED', detail: hasChromium(), ms: 0 });
else check('icons-up-to-date', iconsUpToDate);
run('format', 'pnpm', ['format:check']);
run('lint', 'pnpm', ['lint']);
run('typecheck', 'pnpm', ['typecheck']);
run('test:unit', 'pnpm', ['test:unit']);
run('test:dom', 'pnpm', ['test:dom']);
run('test:contracts', 'pnpm', ['test:contracts']);
run('test:integration', 'pnpm', ['test:integration']);
run('test:security', 'pnpm', ['test:security']);
run('build', 'pnpm', ['build']);
// After the build, because the budgets are measured from the files it produced.
run('test:perf', 'pnpm', ['test:perf']);
// The single-file build, the check that the committed copy matches it, and the suite that opens
// it from the filesystem. The build is deterministic, so a diff here means the source moved on
// without `pnpm build:local` being run.
run('build:local', 'pnpm', ['build:local']);
run('local-file-up-to-date', 'git', ['diff', '--exit-code', '--', 'now-playing.html']);
check('helper-up-to-date', helperUpToDate);
run('test:local', 'pnpm', ['test:local'], { skipIf: hasChromium, artifacts: ['music-player/test-results-local', 'music-player/playwright-report-local'] });
// The styleguide is built from the products' own components and stylesheets, so the committed copy
// goes stale the moment either moves — same shape as the single-file player above, and the same
// reason: it is opened straight from the repository, by people who are not running a toolchain.
run('build:styleguide', 'pnpm', ['build:styleguide']);
run('styleguide-up-to-date', 'git', ['diff', '--exit-code', '--', 'docs/design/styleguide.html']);
// Sources, coverage against the products' navigation, tokens against the stylesheets, and freshness.
run('styleguide:check', 'pnpm', ['styleguide:check']);
run('styleguide:pdf', 'pnpm', ['styleguide:pdf'], { skipIf: hasChromium });
run('test:a11y', 'pnpm', ['test:a11y'], { skipIf: hasChromium, artifacts: ['music-player/test-results', 'music-player/playwright-report'] });
run('test:e2e', 'pnpm', ['test:e2e'], { skipIf: hasChromium, artifacts: [...['music-player/test-results', 'music-player/playwright-report'], ...['docker-container/test-results', 'docker-container/playwright-report']] });
// The only test in which the hub and the player meet: both real, side by side (tests/journey/).
run('test:journey', 'pnpm', ['test:journey'], { skipIf: hasChromium, artifacts: ['test-results', 'playwright-report'] });
run('test:awsp', cargoBin ?? 'cargo', ['test', '--release', '--manifest-path', 'windows-companion/awsp-server/Cargo.toml'], { skipIf: hasCargo });
run('docker-build', 'docker', ['build', '-t', 'now-playing-hub:verify', '-f', 'docker-container/Dockerfile', '.'], { skipIf: hasDocker });
// Windows packaging, for real, on Windows: an unpacked build (the installer's contents without the
// NSIS wrapping, minutes faster) and a look inside it. This gate used to print "SEE build:windows"
// and pass nothing — which is how a missing app identity reached an installed build (the pin that
// did not stick) with every gate green.
const notWindows = () => (process.platform === 'win32' ? null : 'Windows-only; produced by .github/workflows/windows-companion.yml');
run('windows-package', 'pnpm', ['--filter', '@now-playing/windows-companion', 'package:dir'], { skipIf: notWindows });
if (process.platform === 'win32' && results.at(-1)?.name === 'windows-package' && results.at(-1)?.status === 'PASS') check('windows-package-contents', windowsPackageContents);

console.log('\n\nVerification summary');
console.log('-'.repeat(72));
for (const r of results) console.log(`${r.status.padEnd(8)} ${r.name.padEnd(24)} ${String(r.ms ? Math.round(r.ms / 1000) + 's' : '').padEnd(6)} ${r.detail}`);
console.log('-'.repeat(72));
console.log(`Total ${(Math.round((Date.now() - start) / 1000))}s`);
const failed = results.filter((r) => r.status === 'FAIL');
process.exit(failed.length ? 1 : 0);
