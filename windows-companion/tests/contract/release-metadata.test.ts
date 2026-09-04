/**
 * The `latest.json` the Windows workflow publishes.
 *
 * The release script cannot import the contracts package — it runs under plain `node` in CI, and
 * the package is TypeScript source — so this test is what keeps the two in step: it feeds the
 * script's own builder the filenames electron-builder actually produces and parses the result with
 * the canonical schema. A field renamed in the schema fails here rather than on a download page.
 */
import { describe, expect, it } from 'vitest';
import { ReleaseMetadata } from '@now-playing/contracts';
// @ts-expect-error — a plain .mjs build script, deliberately dependency-free.
import { buildReleaseManifest, classifyArtifact } from '../../scripts/release-metadata.mjs';

const FILES = [
  { filename: 'Now Playing Companion Setup 0.1.0 x64.exe', sizeBytes: 82_000_000, sha256: 'a'.repeat(64) },
  { filename: 'Now Playing Companion Setup 0.1.0 arm64.exe', sizeBytes: 79_000_000, sha256: 'b'.repeat(64) },
  { filename: 'Now Playing Companion Portable 0.1.0 x64.exe', sizeBytes: 90_000_000, sha256: 'c'.repeat(64) },
  // Files electron-builder leaves beside the artifacts and that must not be published as downloads.
  { filename: 'Now Playing Companion Setup 0.1.0 x64.exe.blockmap', sizeBytes: 90_000, sha256: 'd'.repeat(64) },
  { filename: 'latest.yml', sizeBytes: 300, sha256: 'e'.repeat(64) },
  { filename: 'builder-debug.yml', sizeBytes: 900, sha256: 'f'.repeat(64) },
];

function build(overrides: Record<string, unknown> = {}) {
  return buildReleaseManifest({ version: '0.1.0', releasedAt: '2026-01-01T00:00:00.000Z', baseUrl: 'https://example.com/releases/v0.1.0', files: FILES, ...overrides });
}

describe('release manifest', () => {
  it('parses against the canonical schema', () => {
    expect(() => ReleaseMetadata.parse(build())).not.toThrow();
  });

  it('publishes the installers and the portable build, and nothing else from the directory', () => {
    const manifest = ReleaseMetadata.parse(build());
    expect(manifest.artifacts.map((a) => `${a.kind}:${a.arch}`).sort()).toEqual(['installer:arm64', 'installer:x64', 'portable:x64']);
  });

  it('ignores blockmaps and builder metadata', () => {
    expect(classifyArtifact('Now Playing Companion Setup 0.1.0 x64.exe.blockmap')).toBeNull();
    expect(classifyArtifact('latest.yml')).toBeNull();
    expect(classifyArtifact('builder-debug.yml')).toBeNull();
  });

  it('percent-encodes the spaces in the filenames, so the URLs are usable', () => {
    const manifest = ReleaseMetadata.parse(build());
    for (const artifact of manifest.artifacts) {
      expect(artifact.url).not.toContain(' ');
      expect(decodeURIComponent(artifact.url.split('/').pop()!)).toBe(artifact.filename);
    }
  });

  it('reports an unsigned build as unsigned', () => {
    // The whole point of the field: an unsigned build must not claim otherwise, because a person
    // deciding whether to click past SmartScreen is relying on this.
    expect(ReleaseMetadata.parse(build()).signed).toBe(false);
    expect(ReleaseMetadata.parse(build({ signed: true })).signed).toBe(true);
  });

  it('carries a checksum for every artifact', () => {
    for (const artifact of ReleaseMetadata.parse(build()).artifacts) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('refuses a version that is not a release version', () => {
    expect(() => ReleaseMetadata.parse(build({ version: 'nightly' }))).toThrow();
  });
});
