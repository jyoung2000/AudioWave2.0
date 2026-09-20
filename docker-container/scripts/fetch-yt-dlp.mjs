/**
 * Fetch yt-dlp into the image, verified.
 *
 * Deliberately not pinned. Pinning is usually the careful choice, and for this one tool it is the
 * opposite: yt-dlp works by keeping up with sites that change, so a frozen copy does not age into
 * something safer, it ages into something that fails on site after site for reasons nobody can
 * diagnose. What is kept instead is *integrity* — the binary is checked against the `SHA2-256SUMS`
 * file published in the same release, so the bytes are the ones that project published even though
 * the version floats.
 *
 * A build with no network still succeeds, without the tool. The provider is off by default, its
 * `test()` reports "Binary not found" plainly, and an image that refuses to build because an
 * optional extra could not be downloaded would be a worse trade than one that says what it lacks.
 * A checksum *mismatch* is different and fails the build: that is not a missing extra, it is a
 * wrong answer.
 *
 * The release tag is resolved **once** and both files are then fetched from that exact tag. Asking
 * `/releases/latest/download/...` twice is two independent resolutions, and yt-dlp releases often:
 * a release landing between the two requests pairs one version's binary with the next version's
 * checksum file, and the build then fails on a mismatch that means nothing. The integrity property
 * is unchanged -- still checked against what the project published -- but now against one release.
 *
 * Usage: node scripts/fetch-yt-dlp.mjs <output-directory>
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'https://github.com/yt-dlp/yt-dlp';

/** `.../releases/tag/<version>` in the redirect that `releases/latest` answers with. */
const TAG_IN_LOCATION = /\/tag\/([^/?#]+)/;

const ASSETS = { x64: 'yt-dlp_linux', arm64: 'yt-dlp_linux_aarch64', arm: 'yt-dlp_linux_armv7l' };

const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: node scripts/fetch-yt-dlp.mjs <output-directory>\n');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const asset = ASSETS[process.arch];
if (!asset) {
  process.stdout.write(`yt-dlp publishes no Linux build for ${process.arch}; the image ships without it.\n`);
  process.exit(0);
}

/**
 * The tag `latest` currently points at.
 *
 * The redirect is preferred over the API: `releases/latest` answers 302 to `.../tag/<version>` with
 * no authentication and no rate limit, while the JSON API is limited per IP and CI runners share
 * addresses. The API is the fallback for the case where the redirect shape changes.
 */
async function resolveTag() {
  const redirect = await fetch(`${REPO}/releases/latest`, { redirect: 'manual' });
  const location = redirect.headers.get('location');
  const fromRedirect = location && TAG_IN_LOCATION.exec(location)?.[1];
  if (fromRedirect) return decodeURIComponent(fromRedirect);

  const api = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'now-playing-hub-build' } });
  if (!api.ok) throw new Error(`could not resolve the latest tag (redirect gave ${redirect.status}, API gave ${api.status})`);
  const tag = (await api.json()).tag_name;
  if (typeof tag !== 'string' || !tag) throw new Error('the latest release has no tag name');
  return tag;
}

let binary;
let sums;
let tag;
try {
  tag = await resolveTag();
  // Both files from the one tag, so the checksum always describes the binary beside it.
  const base = `${REPO}/releases/download/${encodeURIComponent(tag)}`;
  const [binaryResponse, sumsResponse] = await Promise.all([fetch(`${base}/${asset}`, { redirect: 'follow' }), fetch(`${base}/SHA2-256SUMS`, { redirect: 'follow' })]);
  if (!binaryResponse.ok || !sumsResponse.ok) throw new Error(`${binaryResponse.status}/${sumsResponse.status}`);
  binary = Buffer.from(await binaryResponse.arrayBuffer());
  sums = await sumsResponse.text();
} catch (error) {
  process.stdout.write(`yt-dlp could not be downloaded (${error.message}); the image ships without it.\n`);
  process.exit(0);
}

const expected = sums
  .split(/\r?\n/)
  .map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim()))
  .find((match) => match && match[2] === asset)?.[1]
  ?.toLowerCase();

if (!expected) {
  process.stderr.write(`Release ${tag} publishes no checksum for ${asset}. Refusing to ship an unverified binary.\n`);
  process.exit(1);
}

const actual = createHash('sha256').update(binary).digest('hex');
if (actual !== expected) {
  // Both files came from one tag, so this is a real integrity failure, not a release race.
  process.stderr.write(`Checksum mismatch for ${asset} in release ${tag}: expected ${expected}, got ${actual}.\n`);
  process.exit(1);
}

const target = join(out, 'yt-dlp');
writeFileSync(target, binary);
chmodSync(target, 0o755);
process.stdout.write(`Verified ${asset} from ${tag} (${Math.round(binary.length / 1024)}KB) into ${target}\n`);
