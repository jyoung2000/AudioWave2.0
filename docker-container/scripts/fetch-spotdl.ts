/**
 * Fetch spotDL into the image, through the same verified installer the companion and the hub use
 * (`@now-playing/domain/tool-install`): the latest release of spotDL/spotify-downloader, read once
 * through the GitHub API, the Linux build checked against the SHA-256 GitHub publishes for it, and
 * asked for its version before it is moved into place.
 *
 * Like yt-dlp (scripts/fetch-yt-dlp.mjs), not pinned and not fatal when there is no network: an
 * image that refuses to build because an optional extra could not be reached is a worse trade than
 * one that says what it lacks — the provider's Test button and the Providers row both say spotDL
 * is not there. A wrong answer is different: a download that does not match its published digest,
 * or a release that publishes none, fails the build.
 *
 * spotDL publishes one Linux build, for x64, linked against glibc 2.38 — which is why the image is
 * based on Debian trixie (glibc 2.41) rather than bookworm (2.36), where it cannot start.
 *
 * Usage: tsx scripts/fetch-spotdl.ts <output-directory>
 */
import { mkdirSync } from 'node:fs';
import { installTool, latestRelease, toolSource } from '@now-playing/domain/tool-install';

const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: tsx scripts/fetch-spotdl.ts <output-directory>\n');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const source = toolSource('spotdl', 'linux', process.arch);
if (!source) {
  process.stdout.write(`spotDL publishes no Linux build for ${process.arch}; the image ships without it.\n`);
  process.exit(0);
}

// Reaching GitHub at all is the "offline" question; it is asked separately so that only a missing
// network is forgiven, and every answer after it is held to the installer's rules.
try {
  await latestRelease(source.repo);
} catch (error) {
  process.stdout.write(`spotDL could not be looked up (${error instanceof Error ? error.message : String(error)}); the image ships without it.\n`);
  process.exit(0);
}

const outcome = await installTool('spotdl', { toolsDir: out, platform: 'linux' });
if (outcome.installed) {
  process.stdout.write(`Verified ${outcome.verified?.asset ?? 'spotDL'} (sha256 ${outcome.verified?.sha256 ?? '?'}) from ${outcome.tag ?? 'the latest release'}: ${outcome.version}\n`);
  process.exit(0);
}

const reason = outcome.reason ?? 'it could not be set up';
// Integrity refusals are wrong answers, not missing extras — and so is a verified build that will
// not start on this base image, which would otherwise ship as a file that cannot run.
if (/SHA-256/.test(reason) || /pointed somewhere other than GitHub/.test(reason) || /would not report a version/.test(reason)) {
  process.stderr.write(`spotDL was refused: ${reason}\n`);
  process.exit(1);
}
process.stdout.write(`spotDL could not be set up (${reason}); the image ships without it.\n`);
