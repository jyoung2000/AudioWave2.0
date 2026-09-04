/**
 * Turn the files electron-builder produced into the `latest.json` the hub and the PWA read.
 *
 * The shape is `ReleaseMetadata` from @now-playing/contracts. This file cannot import that package
 * — it runs under plain `node` in CI, and the package is TypeScript source — so the manifest is
 * built by the pure function below and a contract test parses that function's output with the real
 * schema. The schema stays the single source of truth; the test is what keeps this file honest.
 *
 * `signed` is computed, never assumed: it is true only when CI actually held a certificate. An
 * unsigned build that claimed to be signed would talk a person past the SmartScreen warning that
 * is, for an unsigned build, entirely correct.
 *
 * Usage: node scripts/release-metadata.mjs --dir release --base-url https://…  [--channel stable]
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_METADATA_SCHEMA_VERSION = 1;

/**
 * Map a produced filename to the artifact kind and architecture the schema uses.
 * Returns null for files that are not release artifacts (blockmaps, unpacked directories, logs).
 */
export function classifyArtifact(filename) {
  const arch = /arm64/i.test(filename) ? 'arm64' : 'x64';
  if (/\.(blockmap|yml|yaml|log)$/i.test(filename)) return null;
  if (/^SHA256SUMS\.txt$/i.test(filename) || /\.sha256$/i.test(filename)) return { kind: 'checksums', arch };
  if (/portable/i.test(filename) && /\.exe$/i.test(filename)) return { kind: 'portable', arch };
  if (/\.exe$/i.test(filename)) return { kind: 'installer', arch };
  return null;
}

/**
 * Build the manifest from already-hashed inputs. Pure, so the contract test can check the exact
 * object this script writes against the canonical Zod schema without touching a filesystem.
 */
export function buildReleaseManifest({ version, releasedAt, channel = 'stable', signed = false, minimumWindows = 'Windows 10 1809+', notesUrl = null, baseUrl, files }) {
  const base = baseUrl.replace(/\/$/, '');
  const artifacts = [];
  for (const file of files) {
    const classified = classifyArtifact(file.filename);
    if (!classified || file.sizeBytes <= 0) continue;
    artifacts.push({ ...classified, filename: file.filename, url: `${base}/${encodeURIComponent(file.filename)}`, sizeBytes: file.sizeBytes, sha256: file.sha256 });
  }
  return {
    schemaVersion: RELEASE_METADATA_SCHEMA_VERSION,
    product: 'windows-companion',
    version,
    releasedAt,
    channel,
    signed,
    minimumWindows,
    ...(notesUrl ? { notesUrl } : {}),
    artifacts,
  };
}

/**
 * Read a setting from `--flag value`, then from the environment, then fall back.
 *
 * CI passes these as environment variables (a workflow expression is awkward to splice into a
 * command line), while a person running the script by hand reaches for a flag. Both work.
 */
function arg(name, envName, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  const flag = index >= 0 ? process.argv[index + 1] : undefined;
  if (flag && !flag.startsWith('--')) return flag;
  const fromEnv = process.env[envName];
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : fallback;
}

/** Only run the CLI when invoked directly, so the test can import the functions above. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dir = join(root, arg('dir', 'NP_RELEASE_DIR', 'release'));
  const baseUrl = arg('base-url', 'NP_RELEASE_BASE_URL', `https://github.com/jyoung2000/AudioWave2.0/releases/download/v${pkg.version}`);
  const channel = arg('channel', 'NP_RELEASE_CHANNEL', 'stable');
  const notesUrl = arg('notes-url', 'NP_RELEASE_NOTES_URL', null);
  // Signed only when CI actually held a certificate. Never inferred, never defaulted to true.
  const signed = (process.env['NP_RELEASE_SIGNED'] ?? '').toLowerCase() === 'true';

  const files = [];
  for (const filename of readdirSync(dir).sort()) {
    const full = join(dir, filename);
    const stat = statSync(full);
    if (!stat.isFile()) continue;
    if (!classifyArtifact(filename)) continue;
    files.push({ filename, sizeBytes: stat.size, sha256: createHash('sha256').update(readFileSync(full)).digest('hex') });
  }

  const manifest = buildReleaseManifest({ version: pkg.version, releasedAt: new Date().toISOString(), channel, signed, notesUrl, baseUrl, files });
  if (manifest.artifacts.length === 0) {
    process.stderr.write(`No installer or portable build found in ${dir}. Run \`pnpm package\` first.\n`);
    process.exit(1);
  }

  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // A plain checksums file next to it, so a download can be verified without a JSON parser.
  writeFileSync(join(dir, 'SHA256SUMS.txt'), `${manifest.artifacts.map((a) => `${a.sha256}  ${a.filename}`).join('\n')}\n`);
  process.stdout.write(`Wrote ${join(dir, 'latest.json')} with ${manifest.artifacts.length} artifact(s); signed=${signed}\n`);
}
