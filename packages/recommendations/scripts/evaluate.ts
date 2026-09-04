#!/usr/bin/env tsx
/**
 * Writes `evaluation/report.json` and prints a summary. Deterministic: the same fixtures, seeds and
 * configuration always produce the same numbers, so the file is committed and a change in the
 * recommender shows up as a diff in the report.
 *
 *   pnpm --filter @now-playing/recommendations evaluate
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateListeningEvents } from '@now-playing/test-fixtures';
import { catalogueFromEvents, cohortFromGenerator, evaluate, syntheticCatalogue } from '../src/index.js';

const USERS = 12;
const CATALOGUE_SIZE = 240;

const users = cohortFromGenerator((seed, deviceId) => generateListeningEvents({ seed, deviceId, days: 28 }), USERS);
const seedTracks = catalogueFromEvents(users.flatMap((u) => u.events));
const catalogue = syntheticCatalogue(seedTracks, { size: CATALOGUE_SIZE, seed: 11 });

const report = evaluate({ users, catalogue, k: 20, trainFraction: 0.7, seed: 42 });

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'evaluation');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'report.json');
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
process.stdout.write(`Now Playing recommender — offline evaluation\n`);
process.stdout.write(`${report.users} synthetic users, ${report.catalogueSize} canonical tracks, k=${report.k}, ${pct(report.trainFraction)} train split\n\n`);
process.stdout.write(`mode          users  hit@k   ndcg@k  artistDiv  coverage  novelty  skipPrec\n`);
for (const m of report.modes) {
  process.stdout.write(`${m.mode.padEnd(13)} ${String(m.users).padStart(5)}  ${pct(m.hitRate).padStart(6)}  ${m.ndcg.toFixed(3).padStart(6)}  ${m.artistDiversity.toFixed(3).padStart(9)}  ${pct(m.coverage).padStart(8)}  ${pct(m.novelty).padStart(7)}  ${pct(m.skipPrecision).padStart(8)}\n`);
}
process.stdout.write(`\n${report.notes.map((n) => `- ${n}`).join('\n')}\n\nWrote ${file}\n`);
