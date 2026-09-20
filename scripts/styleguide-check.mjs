#!/usr/bin/env node
/**
 * `pnpm styleguide:check` — is the design authority intact?
 *
 * Sources and evidence exist, rule IDs are unique, every screen the products declare is in the
 * coverage ledger, tokens.json agrees with the stylesheets (exceptions are listed, not hidden), and
 * docs/design/styleguide.html was built from the sources as they are now. `--no-freshness` skips
 * the last one, for running before a build.
 */
import { fileURLToPath } from 'node:url';
import { runChecks } from './styleguide-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const freshness = !process.argv.includes('--no-freshness');
const { errors, notes, summary } = runChecks(root, { freshness });

console.log('Styleguide check');
console.log(`  ${summary.rules} rules · ${summary.surfaces} surfaces (${summary.mockups} with mockups, ${summary.runtimeVerified} seen at runtime) · ${summary.flows} journeys`);
console.log(`  ${summary.discovered} surfaces discovered from product navigation · ${summary.discordCommands} Discord commands`);
console.log(`  ${summary.tokensChecked} tokens compared with the stylesheets · ${summary.tokenExceptions} recorded exceptions`);
if (summary.fingerprint) console.log(`  source fingerprint ${summary.fingerprint}`);
for (const note of notes) console.log(`  note: ${note}`);
if (errors.length) {
  console.error(`\n${errors.length} problem${errors.length === 1 ? '' : 's'}:`);
  for (const error of errors) console.error(`  ✗ ${error}`);
  process.exit(1);
}
console.log('\n  ✓ all checks pass');
