#!/usr/bin/env node
/**
 * The living mockups' commands (design/decisions.md DEC-038; AGENTS.md, "Living mockups"):
 *
 *   pnpm mockups:build  [player|hub|companion …] [--out <dir>]   render them from the apps
 *   pnpm mockups:diff   [player|hub|companion …] [--check]        what an edited mockup changes
 *   pnpm mockups:export <dir>                                     copy the three somewhere else
 *
 * Run through tsx, so the tooling can read the contracts' TypeScript (routes and IPC schemas).
 */
const [command, ...rest] = process.argv.slice(2);
const commands = {
  build: () => import('./build.mjs'),
  diff: () => import('./diff.mjs'),
  export: () => import('./export.mjs'),
};
if (!commands[command]) {
  console.error('usage: mockups build|diff|export …');
  process.exit(2);
}
try {
  const { main } = await commands[command]();
  process.exitCode = (await main(rest)) ?? 0;
} catch (error) {
  console.error(`mockups ${command}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
}
