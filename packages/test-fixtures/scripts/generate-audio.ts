import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_DUPLICATE, FIXTURE_LIBRARY } from '../src/library.js';
import { makeToneWav } from '../src/wav.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'generated', 'audio');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const manifest: Array<{ path: string; sha256: string; bytes: number; title: string; artist: string }> = [];
for (const spec of FIXTURE_LIBRARY) {
  const dir = join(root, spec.folder);
  mkdirSync(dir, { recursive: true });
  const bytes = makeToneWav(spec.tone, spec.tags);
  const path = join(dir, spec.file);
  writeFileSync(path, bytes);
  manifest.push({ path: `${spec.folder}/${spec.file}`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, title: spec.tags.title, artist: spec.tags.artist });
}
const dupSource = FIXTURE_LIBRARY.find((s) => s.file === FIXTURE_DUPLICATE.source)!;
const dupBytes = readFileSync(join(root, dupSource.folder, dupSource.file));
mkdirSync(join(root, FIXTURE_DUPLICATE.folder), { recursive: true });
writeFileSync(join(root, FIXTURE_DUPLICATE.folder, FIXTURE_DUPLICATE.file), dupBytes);
manifest.push({ path: `${FIXTURE_DUPLICATE.folder}/${FIXTURE_DUPLICATE.file}`, sha256: createHash('sha256').update(dupBytes).digest('hex'), bytes: dupBytes.length, title: dupSource.tags.title, artist: dupSource.tags.artist });
// an intentionally unsupported "audio" file (not decodable) to exercise the unsupported-format state
writeFileSync(join(root, 'Loose Files', 'not-audio.ape'), new TextEncoder().encode('MAC this is not a real APE file; used to test unsupported-format reporting'));
manifest.push({ path: 'Loose Files/not-audio.ape', sha256: createHash('sha256').update('MAC this is not a real APE file; used to test unsupported-format reporting').digest('hex'), bytes: 72, title: '', artist: '' });
const manifestPath = join(root, 'manifest.json');
const json = JSON.stringify({ generatedBy: 'packages/test-fixtures/scripts/generate-audio.ts', deterministic: true, files: manifest }, null, 2) + '\n';
if (existsSync(manifestPath) && readFileSync(manifestPath, 'utf8') === json) console.log('audio fixtures unchanged');
writeFileSync(manifestPath, json);
console.log(`Generated ${manifest.length} fixture files under ${root}`);
