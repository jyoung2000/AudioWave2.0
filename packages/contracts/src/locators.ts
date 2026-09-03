import { z } from 'zod';
import { ProviderId, Uuid } from './common.js';

/**
 * Where media bytes can be obtained. A locator is resolved only by the
 * device/service that owns it. Raw filesystem paths never appear here.
 */
export const MediaLocator = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('browser-handle'), deviceId: Uuid, handleId: z.string().min(1) }),
  z.object({ kind: z.literal('opfs'), deviceId: Uuid, objectId: z.string().min(1) }),
  z.object({ kind: z.literal('windows-file'), deviceId: Uuid, fileId: z.string().min(1) }),
  z.object({ kind: z.literal('hub-blob'), hubId: Uuid, blobId: z.string().min(1) }),
  z.object({
    kind: z.literal('provider'),
    provider: ProviderId,
    providerTrackId: z.string().min(1),
    canonicalUrl: z.string().url().optional(),
  }),
]);
export type MediaLocator = z.infer<typeof MediaLocator>;
export type MediaLocatorKind = MediaLocator['kind'];

export const LocatorAvailability = z.enum(['available', 'needs-permission', 'offline', 'missing', 'requires_auth', 'unknown']);
export type LocatorAvailability = z.infer<typeof LocatorAvailability>;
