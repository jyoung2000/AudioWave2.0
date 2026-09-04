import { z } from 'zod';
import { IsoDateTime, Uuid } from '../common.js';

export const ShareKind = z.enum(['track', 'album', 'playlist', 'library']);
export type ShareKind = z.infer<typeof ShareKind>;

/** A revocable public link served by the hub. The token itself is stored only as a hash. */
export const ShareLink = z.object({
  id: Uuid,
  kind: ShareKind,
  targetId: z.string().min(1).max(200).describe('Track/album/playlist id, or the owner device id for a library share'),
  title: z.string().max(300),
  ownerId: z.string().max(200).describe('Device id or admin'),
  tokenHash: z.string().min(16),
  tokenHint: z.string().max(8).describe('Last characters shown in lists'),
  allowStream: z.boolean().default(true),
  allowDownload: z.boolean().default(false),
  expiresAt: IsoDateTime.nullable().default(null),
  maxAccesses: z.number().int().positive().nullable().default(null),
  accessCount: z.number().int().nonnegative().default(0),
  playCount: z.number().int().nonnegative().default(0),
  createdAt: IsoDateTime,
  revokedAt: IsoDateTime.nullable().default(null),
});
export type ShareLink = z.infer<typeof ShareLink>;

export const ShareLinkView = ShareLink.omit({ tokenHash: true }).extend({
  url: z.string().url().nullable().describe('Absolute URL when the hub has a reachable endpoint; null otherwise'),
  reachable: z.boolean().describe('False when the hub has no public endpoint or LAN bind, so the link only works locally'),
  warning: z.string().nullable(),
});
export type ShareLinkView = z.infer<typeof ShareLinkView>;

export const SharedItem = z.object({
  trackId: Uuid,
  title: z.string(),
  artistName: z.string(),
  albumName: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  artworkUrl: z.string().nullable(),
  /** Whether the hub can stream this item to anonymous visitors (hub-hosted/blob content only). */
  streamable: z.boolean(),
  downloadable: z.boolean(),
  /** For provider references: where to open it instead. */
  openAtSourceUrl: z.string().url().nullable(),
  availabilityNote: z.string().nullable(),
});

export const SharePayload = z.object({
  kind: ShareKind,
  title: z.string(),
  description: z.string().nullable(),
  ownerDisplayName: z.string(),
  artworkUrl: z.string().nullable(),
  items: z.array(SharedItem),
  totalItems: z.number().int().nonnegative(),
  expiresAt: IsoDateTime.nullable(),
  allowStream: z.boolean(),
  allowDownload: z.boolean(),
  hubName: z.string(),
});
export type SharePayload = z.infer<typeof SharePayload>;
