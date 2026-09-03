import { z } from 'zod';

/** Semantic version of the canonical contracts. Bump on any breaking schema change. */
export const CONTRACTS_VERSION = '1.0.0';
/** HTTP API version prefix. */
export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;
/** WebSocket envelope protocol version (integer, negotiated at handshake). */
export const WS_PROTOCOL_VERSION = 1;
/** Minimum WebSocket protocol version a server will still speak. */
export const WS_MIN_SUPPORTED_PROTOCOL_VERSION = 1;

/** Versions of every persisted or exchanged schema. Migrations key on these. */
export const SCHEMA_VERSIONS = {
  entities: 1,
  playlistJson: 1,
  eqPresetJson: 1,
  historyCsv: 1,
  historyJson: 1,
  syncManifest: 1,
  releaseMetadata: 1,
  listeningEvent: 1,
  discordTemplates: 1,
  diagnosticsBundle: 1,
} as const;

export const Uuid = z.uuid().describe('UUID (v7 preferred; stable across sync)');
export const IsoDateTime = z.iso
  .datetime({ offset: true })
  .describe('UTC ISO-8601 timestamp with offset, e.g. 2026-09-03T12:00:00.000Z');
export const NonEmptyString = z.string().trim().min(1);
export const DisplayName = z.string().trim().min(1).max(80);
export const Sha256Hex = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe('Lower-case hex SHA-256');
export const PositiveInt = z.number().int().nonnegative();
export const DurationMs = z.number().int().nonnegative().describe('Duration in milliseconds');
export const Percent = z.number().min(0).max(100);
export const Cursor = z.string().min(1).max(512).describe('Opaque pagination cursor');

/** Provider identifiers are lower-case slugs so new adapters can be configured without a schema change. */
export const ProviderId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,31}$/)
  .describe('Provider slug, e.g. local, hub, companion, musicbrainz, youtube, soundcloud, bandcamp, spotify, public-domain, external-tool');
export type ProviderId = z.infer<typeof ProviderId>;

export const KNOWN_PROVIDERS = [
  'local',
  'hub',
  'companion',
  'musicbrainz',
  'youtube',
  'soundcloud',
  'bandcamp',
  'spotify',
  'public-domain',
  'external-tool',
] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

export const ListeningMode = z.enum(['solo', 'group']);
export type ListeningMode = z.infer<typeof ListeningMode>;

/** Device credential scopes. Every privileged route declares the scopes it needs. */
export const Scope = z.enum([
  'library:read',
  'library:share',
  'playlists:sync',
  'eq:sync',
  'history:aggregate',
  'history:events',
  'group:member',
  'group:admin',
  'downloads:request',
  'transfers:receive',
  'files:serve',
  'search:use',
]);
export type Scope = z.infer<typeof Scope>;

export const DeviceKind = z.enum(['player', 'companion', 'hub']);
export type DeviceKind = z.infer<typeof DeviceKind>;

/** Tombstone-aware base for every synced entity. */
export const SyncedEntityBase = z.object({
  id: Uuid,
  schemaVersion: z.number().int().positive().default(SCHEMA_VERSIONS.entities),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: IsoDateTime.nullable().default(null).describe('Tombstone; retained per compaction policy'),
});
export type SyncedEntityBase = z.infer<typeof SyncedEntityBase>;

export const ProblemDetails = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: z.string().optional().describe('Machine-readable error code'),
  correlationId: z.string().optional(),
  retryAfterSeconds: z.number().int().optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;
