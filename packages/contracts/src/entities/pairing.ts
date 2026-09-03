import { z } from 'zod';
import { DeviceKind, IsoDateTime, Scope, Uuid } from '../common.js';

export const PairingState = z.enum(['pending', 'claimed', 'confirmed', 'consumed', 'expired', 'revoked']);
export type PairingState = z.infer<typeof PairingState>;

/** Server-side pairing session. Only a verifier/hash of the code is stored. */
export const PairingSession = z.object({
  id: Uuid,
  hubId: Uuid,
  deviceKind: DeviceKind,
  requestedScopes: z.array(Scope),
  codeHash: z.string().min(16),
  createdBy: z.string().max(200),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(5),
  state: PairingState.default('pending'),
  claimedDeviceName: z.string().max(80).nullable().default(null),
  claimedPublicKey: z.string().max(4096).nullable().default(null),
  claimedAppVersion: z.string().max(40).nullable().default(null),
  claimedProtocolVersion: z.number().int().nullable().default(null),
  verificationFingerprint: z.string().max(64).nullable().default(null),
  consumedAt: IsoDateTime.nullable().default(null),
  resultingDeviceId: Uuid.nullable().default(null),
});
export type PairingSession = z.infer<typeof PairingSession>;

/** Payload embedded in QR/deep links. Contains endpoint + hub fingerprint so code-only entry is not required. */
export const PairingLinkPayload = z.object({
  v: z.literal(1),
  code: z.string().min(8).max(20),
  endpoint: z.string().url(),
  hubId: Uuid,
  fp: z.string().min(8).max(128).describe('Hub public-key fingerprint'),
  exp: z.number().int().describe('Unix seconds expiry'),
});
export type PairingLinkPayload = z.infer<typeof PairingLinkPayload>;
