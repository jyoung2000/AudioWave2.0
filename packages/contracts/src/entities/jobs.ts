import { z } from 'zod';
import { IsoDateTime, ProviderId, Sha256Hex, Uuid } from '../common.js';
import { MediaLocator } from '../locators.js';

export const JobState = z.enum(['queued', 'running', 'paused', 'retrying', 'completed', 'failed', 'cancelled']);
export type JobState = z.infer<typeof JobState>;

export const DownloadAuthorizationBasis = z.enum([
  'user-owned',
  'creator-download',
  'purchased-export',
  'public-domain',
  'licensed',
  'hub-hosted',
]);
export type DownloadAuthorizationBasis = z.infer<typeof DownloadAuthorizationBasis>;

export const DownloadDestination = z.enum(['ask', 'windows', 'player', 'both', 'hub']);
export type DownloadDestination = z.infer<typeof DownloadDestination>;

export const OutputFormat = z.enum(['original', 'mp3', 'aac', 'opus', 'flac']);
export type OutputFormat = z.infer<typeof OutputFormat>;

export const DownloadJob = z.object({
  id: Uuid,
  state: JobState,
  ownerId: z.string().max(200).describe('Device id or admin'),
  source: z.object({
    provider: ProviderId,
    providerTrackId: z.string().max(200).nullable().default(null),
    url: z.string().url().nullable().default(null),
    locator: MediaLocator.nullable().default(null),
    title: z.string().max(300).nullable().default(null),
    artistName: z.string().max(300).nullable().default(null),
  }),
  authorization: z.object({
    basis: DownloadAuthorizationBasis,
    evidence: z.string().max(500).nullable().default(null),
    acknowledgedAt: IsoDateTime,
  }),
  target: z.object({
    destination: DownloadDestination.exclude(['ask']),
    directoryId: z.string().max(200).nullable().default(null),
    filenameTemplate: z.string().max(200).default('{artist} - {title}'),
    format: OutputFormat.default('original'),
    quality: z.string().max(40).nullable().default(null),
  }),
  progress: z.object({
    bytesDone: z.number().int().nonnegative().default(0),
    bytesTotal: z.number().int().nonnegative().nullable().default(null),
    speedBps: z.number().nonnegative().nullable().default(null),
    percent: z.number().min(0).max(100).nullable().default(null),
    stage: z.enum(['preflight', 'downloading', 'verifying', 'converting', 'finalizing', 'transferring', 'done']).default('preflight'),
  }),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(5),
  nextRetryAt: IsoDateTime.nullable().default(null),
  checksumSha256: Sha256Hex.nullable().default(null),
  resultLocator: MediaLocator.nullable().default(null),
  resultSizeBytes: z.number().int().nonnegative().nullable().default(null),
  error: z.string().max(500).nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable().default(null),
});
export type DownloadJob = z.infer<typeof DownloadJob>;

export const TransferJob = z.object({
  id: Uuid,
  kind: z.enum(['file', 'metadata']),
  state: JobState,
  fromDeviceId: Uuid,
  toDeviceId: Uuid,
  contentHash: Sha256Hex,
  sizeBytes: z.number().int().nonnegative(),
  bytesDone: z.number().int().nonnegative().default(0),
  chunkSizeBytes: z.number().int().positive().default(1024 * 1024),
  resumeOffset: z.number().int().nonnegative().default(0),
  checksumVerified: z.boolean().default(false),
  policy: DownloadDestination.default('both'),
  attempts: z.number().int().nonnegative().default(0),
  error: z.string().max(500).nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable().default(null),
  trackId: Uuid.nullable().default(null),
});
export type TransferJob = z.infer<typeof TransferJob>;

export const DiscoveryJob = z.object({
  id: Uuid,
  state: JobState,
  userId: Uuid,
  kind: z.enum(['profile-refresh', 'discover-seeds', 'sync-library', 'token-refresh', 'new-releases']),
  priority: z.enum(['P0', 'P1', 'P2', 'P3', 'P4']).default('P3'),
  payload: z.record(z.string(), z.unknown()).default({}),
  attempts: z.number().int().nonnegative().default(0),
  nextRunAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  error: z.string().max(500).nullable().default(null),
});
export type DiscoveryJob = z.infer<typeof DiscoveryJob>;
