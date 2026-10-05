/**
 * Write the Android shell's copy of the helper host allow-list from the contract.
 *
 * `Tools.kt` carried the same eleven hostnames typed out again, under a comment saying the two
 * lists must not differ — which is a promise a comment cannot keep. Kotlin cannot import a
 * TypeScript constant, so the list is generated instead: one source, and a `pnpm generate` that
 * leaves a diff when someone edits only one side.
 *
 * Deliberately tiny and dependency-free. It reads the constant out of the TypeScript source rather
 * than importing it, so it needs no TypeScript loader to run.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/api/local-helper.ts', import.meta.url));
const target = fileURLToPath(new URL('../../../android/app/src/main/java/com/nowplaying/player/AllowedHosts.kt', import.meta.url));

const text = readFileSync(source, 'utf8');
const block = /export const HELPER_DEFAULT_HOSTS: readonly string\[\] = \[([\s\S]*?)\];/.exec(text);
if (!block) throw new Error(`HELPER_DEFAULT_HOSTS not found in ${source}`);

// One quoted entry per line; comment lines are skipped, so words in a comment never become hosts.
const hosts = block[1]
  .split('\n')
  .map((line) => /^\s*'([^']+)',?\s*$/.exec(line)?.[1])
  .filter((host) => host !== undefined);
if (hosts.length === 0) throw new Error('HELPER_DEFAULT_HOSTS is empty; refusing to emit an allow-list that allows nothing');
// A hostname has no quotes or backslashes in it. If one ever did, the emitted Kotlin would be
// malformed or — worse — quietly different from the contract.
for (const host of hosts) {
  // A plain hostname, or `*.` before one for its subdomains only (Tools.hostAllowed reads both).
  if (!/^(\*\.)?[a-z0-9.-]+$/i.test(host)) throw new Error(`Refusing to emit ${JSON.stringify(host)}: not a plain hostname`);
}

const kotlin = `package com.nowplaying.player

/**
 * The hosts a fetch may name.
 *
 * GENERATED FILE - do not edit. Written by \`packages/contracts/scripts/emit-android-hosts.mjs\`
 * from \`HELPER_DEFAULT_HOSTS\` in \`packages/contracts/src/api/local-helper.ts\`, which is the one
 * place this list lives. Change it there and run \`pnpm generate\`.
 *
 * This is not the gate that matters - the rights basis on every request is - but it stops a page
 * from pointing a subprocess at an arbitrary address, and it keeps the list of what this thing
 * touches short enough to read.
 */
object AllowedHosts {
  val hosts: List<String> = listOf(
${hosts.map((host) => `    "${host}",`).join('\n')}
  )
}
`;

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, kotlin);
process.stdout.write(`Generated AllowedHosts.kt with ${hosts.length} hosts\n`);
