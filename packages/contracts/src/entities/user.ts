import { z } from 'zod';
import { DeviceKind, DisplayName, IsoDateTime, Scope, SyncedEntityBase, Uuid } from '../common.js';

export const Avatar = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), iconId: z.string().regex(/^[a-z0-9-]{1,32}$/) }),
  z.object({
    kind: z.literal('image'),
    blobId: z.string().min(1).describe('Locally stored image blob id'),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    width: z.number().int().positive().max(512),
    height: z.number().int().positive().max(512),
  }),
]);
export type Avatar = z.infer<typeof Avatar>;

export const UserProfile = SyncedEntityBase.extend({
  displayName: DisplayName,
  avatar: Avatar.default({ kind: 'builtin', iconId: 'headphones' }),
  /** Local-only preference: whether the profile may be shared with paired hubs (name + avatar only). */
  shareWithHubs: z.boolean().default(false),
});
export type UserProfile = z.infer<typeof UserProfile>;

export const Device = SyncedEntityBase.extend({
  kind: DeviceKind,
  name: DisplayName,
  platform: z.string().max(80).optional().describe('e.g. "Chrome 130 on Windows", "Windows 11 x64"'),
  publicKeyFingerprint: z.string().min(8).max(128).describe('Fingerprint of the device public key'),
  publicKey: z.string().max(4096).optional().describe('Base64url public key (Ed25519)'),
  appVersion: z.string().max(40),
  protocolVersion: z.number().int().positive(),
  scopes: z.array(Scope).default([]),
  lastSeenAt: IsoDateTime.nullable().default(null),
  revokedAt: IsoDateTime.nullable().default(null),
  hubUserId: Uuid.optional().describe('Hub-side user identity this device authenticates as'),
});
export type Device = z.infer<typeof Device>;

/** Server-side credential record. The secret itself is stored only as a hash. */
export const DeviceCredential = z.object({
  id: Uuid,
  deviceId: Uuid,
  hubId: Uuid,
  secretHash: z.string().min(16),
  scopes: z.array(Scope),
  issuedAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable().default(null),
  lastUsedAt: IsoDateTime.nullable().default(null),
  revokedAt: IsoDateTime.nullable().default(null),
  label: z.string().max(80).optional(),
});
export type DeviceCredential = z.infer<typeof DeviceCredential>;

/** Client-side credential material returned exactly once at pairing completion. */
export const DeviceCredentialSecret = z.object({
  credentialId: Uuid,
  deviceId: Uuid,
  hubId: Uuid,
  hubName: z.string(),
  hubFingerprint: z.string(),
  endpoint: z.string().url().describe('HTTPS (or loopback HTTP) base URL of the hub'),
  secret: z.string().min(32),
  scopes: z.array(Scope),
  issuedAt: IsoDateTime,
});
export type DeviceCredentialSecret = z.infer<typeof DeviceCredentialSecret>;

/** Hub-side user account (one per paired person; multi-user recommendations key on this). */
export const HubUser = SyncedEntityBase.extend({
  displayName: DisplayName,
  role: z.enum(['admin', 'member']).default('member'),
  avatar: Avatar.optional(),
});
export type HubUser = z.infer<typeof HubUser>;
