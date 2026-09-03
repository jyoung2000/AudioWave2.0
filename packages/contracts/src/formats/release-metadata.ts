import { z } from 'zod';
import { IsoDateTime, SCHEMA_VERSIONS, Sha256Hex } from '../common.js';

/** Machine-readable `latest.json` published by the Windows CI workflow and consumed by the PWA download link. */
export const ReleaseArtifact = z.object({
  kind: z.enum(['installer', 'portable', 'checksums']),
  arch: z.enum(['x64', 'arm64']),
  filename: z.string().min(1).max(200),
  url: z.string().url(),
  sizeBytes: z.number().int().positive(),
  sha256: Sha256Hex,
});

export const ReleaseMetadata = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.releaseMetadata),
  product: z.literal('windows-companion'),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  releasedAt: IsoDateTime,
  channel: z.enum(['stable', 'beta', 'dev']).default('stable'),
  signed: z.boolean().describe('True only when the artifacts were code-signed in CI'),
  minimumWindows: z.string().default('Windows 10 1809+'),
  notesUrl: z.string().url().optional(),
  artifacts: z.array(ReleaseArtifact).min(1),
});
export type ReleaseMetadata = z.infer<typeof ReleaseMetadata>;
