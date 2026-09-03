import { z } from 'zod';
import { ProviderId } from './common.js';

export const CapabilityState = z.enum([
  'available',
  'requires_auth',
  'restricted',
  'unsupported',
  'temporarily_unavailable',
]);
export type CapabilityState = z.infer<typeof CapabilityState>;

export const GroupSyncGrade = z.enum(['exact', 'near', 'best_effort', 'unsupported']);
export type GroupSyncGrade = z.infer<typeof GroupSyncGrade>;

/**
 * Every provider result carries capability *state*, never assumptions.
 * UI actions are rendered from this structure only.
 */
export const ProviderCapabilities = z.object({
  metadata: CapabilityState,
  search: CapabilityState,
  preview: CapabilityState,
  playback: CapabilityState,
  importLikes: CapabilityState,
  importPlaylists: CapabilityState,
  creatorDownload: CapabilityState,
  userOwnedDownload: CapabilityState,
  groupSync: GroupSyncGrade,
  eq: CapabilityState,
  reason: z.string().max(400).optional().describe('Human-readable explanation for "Why unavailable?"'),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>;

export const CAPABILITY_KEYS = [
  'metadata',
  'search',
  'preview',
  'playback',
  'importLikes',
  'importPlaylists',
  'creatorDownload',
  'userOwnedDownload',
  'eq',
] as const satisfies ReadonlyArray<keyof ProviderCapabilities>;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const ProviderHealth = z.object({
  provider: ProviderId,
  status: z.enum(['ok', 'degraded', 'down', 'unconfigured', 'disabled']),
  circuit: z.enum(['closed', 'open', 'half-open']),
  latencyMs: z.number().nonnegative().optional(),
  quota: z
    .object({
      used: z.number().nonnegative(),
      budget: z.number().positive(),
      resetsAt: z.string().optional(),
      unit: z.string().default('requests'),
    })
    .optional(),
  lastError: z.string().optional(),
  checkedAt: z.string(),
});
export type ProviderHealth = z.infer<typeof ProviderHealth>;

/** Static, reviewed description of what a provider adapter permits. */
export const ProviderDescriptor = z.object({
  provider: ProviderId,
  displayName: z.string(),
  role: z.enum(['audio-source', 'metadata-only', 'library', 'tool']),
  docsUrl: z.string().url().optional(),
  authType: z.enum(['none', 'api-key', 'oauth-pkce', 'oauth-client-credentials', 'device-credential', 'local']),
  authScopes: z.array(z.string()).default([]),
  attribution: z.string().optional(),
  rateStrategy: z.string().optional(),
  cachePolicy: z.string().optional(),
  groupCompatible: z.boolean(),
  discordCompatible: z.boolean(),
  reviewedAt: z.string(),
  limitations: z.array(z.string()).default([]),
  capabilities: ProviderCapabilities,
  enabled: z.boolean(),
  configured: z.boolean(),
});
export type ProviderDescriptor = z.infer<typeof ProviderDescriptor>;
