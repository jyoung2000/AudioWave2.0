#!/usr/bin/env node
/**
 * `pnpm verify` — runs every non-destructive release gate available on the current platform and prints a table.
 * Gates that cannot run here (Windows packaging, Docker when the daemon is unavailable) are reported as skipped, never as passed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const results = [];
const start = Date.now();
const only = process.argv.slice(2);

function run(name, cmd, args, { optional = false, skipIf = null, env = {} } = {}) {
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
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, CI: process.env.CI ?? '1', ...env } });
  const ok = r.status === 0;
  results.push({ name, status: ok ? 'PASS' : optional ? 'WARN' : 'FAIL', detail: ok ? '' : `exit ${r.status}`, ms: Date.now() - t });
}

const hasDocker = () => {
  if (process.env.NP_SKIP_DOCKER === '1') return 'NP_SKIP_DOCKER=1';
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return r.status === 0 ? null : 'docker daemon unavailable';
};
const hasChromium = () => {
  const p = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (p && existsSync(p)) return null;
  const r = spawnSync('npx', ['playwright', '--version'], { stdio: 'ignore' });
  return r.status === 0 ? null : 'playwright browsers not installed';
};

run('generate', 'pnpm', ['generate']);
run('generated-up-to-date', 'git', ['diff', '--exit-code', '--', 'packages/contracts/generated', 'packages/test-fixtures/generated']);
run('format', 'pnpm', ['format:check'], { optional: true });
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
run('test:a11y', 'pnpm', ['test:a11y'], { skipIf: hasChromium });
run('test:e2e', 'pnpm', ['test:e2e'], { skipIf: hasChromium });
run('docker-build', 'docker', ['build', '-t', 'now-playing-hub:verify', '-f', 'docker-container/Dockerfile', '.'], { skipIf: hasDocker });
results.push({ name: 'windows-package', status: process.platform === 'win32' ? 'SEE build:windows' : 'SKIPPED', detail: process.platform === 'win32' ? '' : 'Windows-only; produced by .github/workflows/windows-companion.yml', ms: 0 });

console.log('\n\nVerification summary');
console.log('-'.repeat(72));
for (const r of results) console.log(`${r.status.padEnd(8)} ${r.name.padEnd(24)} ${String(r.ms ? Math.round(r.ms / 1000) + 's' : '').padEnd(6)} ${r.detail}`);
console.log('-'.repeat(72));
console.log(`Total ${(Math.round((Date.now() - start) / 1000))}s`);
const failed = results.filter((r) => r.status === 'FAIL');
process.exit(failed.length ? 1 : 0);
