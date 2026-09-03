import { z } from 'zod';
import { ProviderCapabilities } from '../capabilities.js';
import { IsoDateTime, ProviderId, SyncedEntityBase, Uuid } from '../common.js';

export const ProviderAccountStatus = z.enum(['connected', 'expired', 'revoked', 'error', 'pending']);

/** A user's connection to a provider. Token material is stored separately and encrypted; never in this schema. */
export const ProviderAccount = SyncedEntityBase.extend({
  provider: ProviderId,
  ownerUserId: Uuid.describe('Hub user or local profile that owns the connection'),
  ownerDeviceId: Uuid.nullable().default(null),
  externalUserId: z.string().max(200).nullable().default(null),
  displayName: z.string().max(200).nullable().default(null),
  scopes: z.array(z.string().max(120)).default([]),
  status: ProviderAccountStatus.default('pending'),
  expiresAt: IsoDateTime.nullable().default(null),
  lastSyncAt: IsoDateTime.nullable().default(null),
  lastError: z.string().max(400).nullable().default(null),
  importCursor: z.string().max(2000).nullable().default(null),
  tokenLast4: z.string().max(4).nullable().default(null),
});
export type ProviderAccount = z.infer<typeof ProviderAccount>;

/** Persisted capability record for a provider (configuration-driven, reviewed). */
export const ProviderCapability = z.object({
  provider: ProviderId,
  capabilities: ProviderCapabilities,
  reviewedAt: IsoDateTime,
  docsUrl: z.string().url().optional(),
  notes: z.string().max(2000).optional(),
});
export type ProviderCapability = z.infer<typeof ProviderCapability>;

/** Application-level credentials configured once by the administrator (write-only via API). */
export const ProviderAppConfigInput = z.object({
  provider: ProviderId,
  enabled: z.boolean().default(true),
  clientId: z.string().max(400).optional(),
  clientSecret: z.string().max(400).optional().describe('Write-only; never returned'),
  apiKey: z.string().max(400).optional().describe('Write-only; never returned'),
  applicationId: z.string().max(400).optional(),
  redirectUri: z.string().url().optional(),
  contactEmail: z.string().email().optional().describe('Used in descriptive user agents (MusicBrainz)'),
  extra: z.record(z.string(), z.string().max(400)).optional(),
});
export type ProviderAppConfigInput = z.infer<typeof ProviderAppConfigInput>;

/** Public view of the app configuration — secrets are replaced by a masked hint. */
export const ProviderAppConfigView = z.object({
  provider: ProviderId,
  enabled: z.boolean(),
  configured: z.boolean(),
  clientId: z.string().optional(),
  clientSecretHint: z.string().optional().describe('e.g. "••••1a2b"'),
  apiKeyHint: z.string().optional(),
  applicationId: z.string().optional(),
  redirectUri: z.string().optional(),
  contactEmail: z.string().optional(),
  updatedAt: IsoDateTime.optional(),
  missing: z.array(z.string()).default([]).describe('Names of required fields not yet provided'),
});
export type ProviderAppConfigView = z.infer<typeof ProviderAppConfigView>;

/** Sync checkpoint per user and platform for incremental imports. */
export const UserPlatformSync = z.object({
  userId: Uuid,
  provider: ProviderId,
  lastSyncAt: IsoDateTime.nullable().default(null),
  cursor: z.string().max(2000).nullable().default(null),
  snapshot: z.string().max(200).nullable().default(null).describe('e.g. Spotify playlist snapshot_id'),
  etag: z.string().max(200).nullable().default(null),
  status: z.enum(['idle', 'running', 'error', 'paused']).default('idle'),
  lastError: z.string().max(400).nullable().default(null),
});
export type UserPlatformSync = z.infer<typeof UserPlatformSync>;
