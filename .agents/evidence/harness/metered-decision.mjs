#!/usr/bin/env node
/**
 * §2.10 — run the companion's OWN shipped decision functions against the real lines Windows
 * produced on this machine.
 *
 * `windows-companion/src/main/network.ts` splits the problem in two: `COST_SCRIPT` asks Windows what
 * the connection costs (that half needs the OS, and needs the metered adapter to be the one actually
 * carrying traffic), and `classifyCost` + `streamingDecision` decide what to do with the answer (pure
 * functions). This exercises the second half with the exact strings the first half returned today,
 * so the product's behaviour is proven independently of which adapter Windows picked.
 *
 * The functions are extracted from windows-companion/dist/main/index.cjs - the shipped bundle - not
 * copied from source, so what runs here is the code the packaged app runs.
 *
 *   node .agents/evidence/harness/metered-decision.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLONE = process.env.NP_CLONE;
const SCRATCH = process.env.NP_SCRATCH;
const EVIDENCE = join(SCRATCH, 'evidence');
const lines = [];
const say = (m) => {
  console.log(m);
  lines.push(String(m));
};

const bundle = readFileSync(join(CLONE, 'windows-companion', 'dist', 'main', 'index.cjs'), 'utf8');
const take = (from, marker) => {
  const i = bundle.indexOf(marker, from);
  if (i < 0) throw new Error(`could not find ${marker} in the bundle`);
  let depth = 0;
  for (let j = bundle.indexOf('{', i); j < bundle.length; j++) {
    if (bundle[j] === '{') depth++;
    else if (bundle[j] === '}') {
      depth--;
      if (depth === 0) return bundle.slice(i, j + 1);
    }
  }
  throw new Error(`unterminated ${marker}`);
};
const at = (name) => bundle.indexOf(`function ${name}(`);
const src = [
  take(at('classifyCost'), 'function classifyCost('),
  take(at('streamingDecision'), 'function streamingDecision('),
  'export { classifyCost, streamingDecision };',
].join('\n');
const { classifyCost, streamingDecision } = await import(`data:text/javascript,${encodeURIComponent(src)}`);
say(`loaded classifyCost() and streamingDecision() out of the shipped bundle (${src.length} chars)\n`);

// The lines COST_SCRIPT actually returned on this machine, read by .agents/evidence/harness/metered-check.ps1.
const REAL = {
  'the profile Windows picked (Ethernet, the adapter carrying traffic)': 'Unrestricted|False|False|False',
  'the Wi-Fi profile you set to metered (HomeWiFi)': 'Fixed|False|False|False',
};
say('### classifyCost() on the two real lines this machine produced');
for (const [label, line] of Object.entries(REAL)) {
  say(`  "${line}"`.padEnd(48) + `-> ${label}`);
  say(`      classifyCost -> ${classifyCost(line)}`);
}

// The whole matrix, so the decision is shown and not merely asserted.
say('\n### the decision matrix (both switches in each state)');
const header = ['connection', 'metered-switch', 'wi-fi-switch', 'allowed', 'reason'];
say(`  ${header[0].padEnd(12)} ${header[1].padEnd(15)} ${header[2].padEnd(13)} ${header[3].padEnd(8)} reason`);
for (const [kindLine, kind] of [
  ['Fixed|False|False|False', 'metered'],
  ['Variable|False|False|False', 'metered'],
  ['Unrestricted|False|False|False', 'unmetered'],
  ['Unrestricted|False|False|True', 'metered'],
  ['none', 'offline'],
]) {
  for (const metered of [true, false]) {
    const decision = streamingDecision({ unmetered: true, metered }, kind);
    say(`  ${kind.padEnd(12)} ${String(metered).padEnd(15)} ${'true'.padEnd(13)} ${(decision.allowed ? 'yes' : 'NO').padEnd(8)} ${decision.reason ?? '-'}`);
  }
}

say('\n### the two sentences §2.10 asks for, produced by the shipped code');
const stopped = streamingDecision({ unmetered: true, metered: false }, 'metered');
const kept = streamingDecision({ unmetered: true, metered: true }, 'metered');
say(`  metered + "On metered connections" OFF -> allowed=${stopped.allowed}`);
say(`      "${stopped.reason}"`);
say(`  metered + "On metered connections" ON  -> allowed=${kept.allowed}, reason=${kept.reason}`);

writeFileSync(join(EVIDENCE, '92-metered-decision.txt'), lines.join('\n'));
say('\nevidence: evidence/92-metered-decision.txt');