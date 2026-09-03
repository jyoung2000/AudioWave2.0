import { z } from 'zod';
import { ProviderCapabilities, ProviderDescriptor, ProviderHealth } from '../capabilities.js';
import { API_PREFIX, Cursor, DeviceKind, IsoDateTime, ListeningMode, ProviderId, Scope, Uuid } from '../common.js';
import {
  AggregateTasteProfile,
  AuditEvent,
  Device,
  DeviceCredentialSecret,
  DiscordConfiguration,
  DiscordStatus,
  DiscordTemplate,
  DiscordTemplates,
  DISCORD_TEMPLATE_KEYS,
  DownloadAuthorizationBasis,
  DownloadDestination,
  DownloadJob,
  Group,
  GroupHistoryEntry,
  GroupMembership,
  GroupPlaybackState,
  GroupRole,
  GroupSettings,
  LibraryRoot,
  ListeningEvent,
  OutputFormat,
  PairingSession,
  ProviderAccount,
  ProviderAppConfigInput,
  ProviderAppConfigView,
  Queue,
  QueueCommand,
  Recommendation,
  RecommendationFeedback,
  RecommendationMode,
  Track,
  TrackIdentity,
  TransferJob,
  UserPlatformSync,
} from '../entities/index.js';
import { HistoryImportReport } from '../formats/history-csv.js';
import { ReleaseMetadata } from '../formats/release-metadata.js';
import { SyncDeltaRequest, SyncDeltaResponse, SyncManifest, SyncStatus } from '../formats/sync-manifest.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
export type RouteAuth = 'none' | 'admin' | 'device' | 'admin-or-device';
export type RateLimitClass = 'none' | 'default' | 'auth' | 'pairing' | 'search' | 'write';

export interface RouteContract<
  TParams extends z.ZodTypeAny = z.ZodTypeAny,
  TQuery extends z.ZodTypeAny = z.ZodTypeAny,
  TBody extends z.ZodTypeAny = z.ZodTypeAny,
  TResponse extends z.ZodTypeAny = z.ZodTypeAny,
> {
  method: HttpMethod;
  /** Path relative to the API prefix (or absolute when it starts with a slash and `absolute` is true). */
  path: string;
  absolute?: boolean;
  operationId: string;
  summary: string;
  tags: string[];
  auth: RouteAuth;
  /** Device scopes required when auth includes device. */
  scopes?: Scope[];
  /** Admin routes are blocked until the bootstrap password is replaced, unless this is false. */
  setupRequired?: boolean;
  rateLimit?: RateLimitClass;
  params?: TParams;
  query?: TQuery;
  body?: TBody;
  response: TResponse;
  responseStatus?: number;
  /** Non-JSON response (csv, binary, html). */
  responseContentType?: string;
  /** Multipart or raw request body. */
  requestContentType?: string;
}

export function defineRoute<
  TParams extends z.ZodTypeAny = z.ZodUndefined,
  TQuery extends z.ZodTypeAny = z.ZodUndefined,
  TBody extends z.ZodTypeAny = z.ZodUndefined,
  TResponse extends z.ZodTypeAny = z.ZodTypeAny,
>(route: RouteContract<TParams, TQuery, TBody, TResponse>): RouteContract<TParams, TQuery, TBody, TResponse> {
  return route;
}

export type RouteParams<R> = R extends RouteContract<infer P, z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny> ? z.infer<P> : never;
export type RouteQuery<R> = R extends RouteContract<z.ZodTypeAny, infer Q, z.ZodTypeAny, z.ZodTypeAny> ? z.infer<Q> : never;
export type RouteBody<R> = R extends RouteContract<z.ZodTypeAny, z.ZodTypeAny, infer B, z.ZodTypeAny> ? z.infer<B> : never;
export type RouteResponse<R> = R extends RouteContract<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny, infer S> ? z.infer<S> : never;

/* ---------- shared shapes ---------- */

export const Ok = z.object({ ok: z.literal(true) });
export const Paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: Cursor.nullable().default(null), total: z.number().int().nonnegative().optional() });
const PagingQuery = z.object({ cursor: Cursor.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });

export const HubIdentity = z.object({
  hubId: Uuid,
  name: z.string(),
  version: z.string(),
  contractsVersion: z.string(),
  protocolVersion: z.number().int(),
  minSupportedProtocolVersion: z.number().int(),
  publicKey: z.string(),
  fingerprint: z.string(),
  bindMode: z.enum(['localhost', 'lan', 'remote']),
  publicEndpoint: z.string().url().nullable(),
  setupComplete: z.boolean(),
  codeOnlyPairingAvailable: z.boolean().describe('True only when a reachable configured endpoint exists'),
});
export type HubIdentity = z.infer<typeof HubIdentity>;

export const SessionInfo = z.object({
  authenticated: z.boolean(),
  username: z.string().optional(),
  mustChangePassword: z.boolean().optional(),
  csrfToken: z.string().optional(),
  setupComplete: z.boolean(),
  expiresAt: IsoDateTime.optional(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const SearchScope = z.enum(['all', 'local', 'connected', 'artists', 'albums', 'songs', 'playlists']);
export type SearchScope = z.infer<typeof SearchScope>;

export const SearchResultBase = z.object({
  id: z.string().min(1).max(300).describe('Stable id within a response: provider:kind:providerId'),
  kind: z.enum(['track', 'album', 'artist', 'playlist']),
  provider: ProviderId,
  providerId: z.string().max(200),
  title: z.string().max(300),
  artistName: z.string().max(300).nullable().default(null),
  albumName: z.string().max(300).nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  artworkUrl: z.string().url().nullable().default(null),
  canonicalUrl: z.string().url().nullable().default(null),
  year: z.number().int().nullable().default(null),
  genre: z.string().max(60).nullable().default(null),
  capabilities: ProviderCapabilities,
  identity: TrackIdentity.prefault({}),
  attribution: z.string().max(200).nullable().default(null),
  cachedAt: IsoDateTime.nullable().default(null),
  stale: z.boolean().default(false),
  accessState: z.enum(['available', 'requires_auth', 'restricted', 'unsupported', 'temporarily_unavailable']),
  previewUrl: z.string().url().nullable().default(null),
  trackId: Uuid.nullable().default(null).describe('Local/hub track id when the result is a library item'),
});
export const SearchResult = SearchResultBase.extend({
  variants: z.array(SearchResultBase).default([]).describe('Other sources confidently matched to the same recording'),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const SearchResponse = z.object({
  query: z.string(),
  scope: SearchScope,
  results: z.array(SearchResult),
  partialFailures: z.array(z.object({ provider: ProviderId, error: z.string(), retryAfterSeconds: z.number().optional() })),
  sources: z.array(z.object({ provider: ProviderId, state: z.enum(['ok', 'failed', 'skipped', 'requires_auth', 'disabled']), count: z.number().int() })),
  nextCursor: Cursor.nullable().default(null),
  tookMs: z.number().nonnegative(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const ReleaseItem = z.object({
  releaseGroupId: z.string(),
  title: z.string(),
  artistName: z.string(),
  releaseType: z.string(),
  date: z.string().nullable(),
  isReissue: z.boolean(),
  isDeluxe: z.boolean(),
  sources: z.array(z.object({ provider: ProviderId, providerId: z.string(), url: z.string().url().nullable(), capabilities: ProviderCapabilities })),
  metadataSource: z.literal('musicbrainz'),
  fetchedAt: IsoDateTime,
  stale: z.boolean(),
});
export const LatestReleasesResponse = z.object({
  artist: z.object({ name: z.string(), musicbrainzArtistId: z.string().nullable() }),
  items: z.array(ReleaseItem),
  partialFailures: z.array(z.object({ provider: ProviderId, error: z.string() })),
  fetchedAt: IsoDateTime,
  cacheTtlSeconds: z.number().int(),
});

export const DeviceView = Device.extend({
  online: z.boolean(),
  latencyMs: z.number().nullable(),
  connectedGroupId: Uuid.nullable(),
  connectedAt: IsoDateTime.nullable(),
  ipDisplay: z.string().nullable(),
  syncDriftMs: z.number().nullable(),
  transferState: z.string().nullable(),
  credentialCount: z.number().int(),
});
export type DeviceView = z.infer<typeof DeviceView>;

export const PairingSessionView = PairingSession.omit({ codeHash: true }).extend({ deepLink: z.string().optional() });

export const GroupMemberView = GroupMembership.extend({ online: z.boolean(), latencyMs: z.number().nullable().default(null) });
export const GroupView = Group.extend({
  members: z.array(GroupMemberView),
  queueLength: z.number().int().nonnegative(),
  listenerCount: z.number().int().nonnegative(),
  playback: GroupPlaybackState.nullable(),
  currentTrackTitle: z.string().nullable(),
  myRole: GroupRole.nullable().default(null),
});
export type GroupView = z.infer<typeof GroupView>;

export const QueueCommandResult = z.object({
  accepted: z.boolean(),
  revision: z.number().int().nonnegative(),
  queue: Queue,
  playback: GroupPlaybackState,
  rejection: z.object({ code: z.string(), reason: z.string() }).nullable().default(null),
  idempotentReplay: z.boolean().default(false),
});

export const GroupAggregateView = z.object({
  groupId: Uuid,
  participantCount: z.number().int().nonnegative(),
  minimumParticipants: z.number().int().positive(),
  available: z.boolean(),
  reason: z.string().nullable(),
  sharedFavorites: z.array(z.object({ key: z.string(), kind: z.enum(['artist', 'album', 'genre']), participants: z.number().int(), weight: z.number() })),
  complementaryGenres: z.array(z.object({ key: z.string(), weight: z.number() })),
  overlap: z.object({ artists: z.number().min(0).max(1), albums: z.number().min(0).max(1), genres: z.number().min(0).max(1), eras: z.number().min(0).max(1) }).nullable(),
  comparison: z
    .object({
      overlapPercent: z.object({ artists: z.number(), albums: z.number(), genres: z.number(), eras: z.number() }),
      discoveryRate: z.object({ mine: z.number(), group: z.number() }),
      listeningPatternSimilarity: z.number().min(0).max(1),
      newToMe: z.array(z.object({ key: z.string(), kind: z.enum(['artist', 'album', 'genre']), weight: z.number() })),
      incompleteData: z.array(z.string()),
    })
    .nullable(),
  recommendationAcceptance: z.number().min(0).max(1).nullable(),
});

export const NetworkConfig = z.object({
  bindMode: z.enum(['localhost', 'lan', 'remote']),
  bindAddress: z.string(),
  port: z.number().int().positive(),
  publicEndpoint: z.string().url().nullable(),
  trustedProxyCidrs: z.array(z.string()),
  ipLogging: z.object({ mode: z.enum(['truncated', 'hashed', 'full']), retentionDays: z.number().int().min(1).max(365) }),
  tlsTerminatedByProxy: z.boolean(),
  restartRequired: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
});
export type NetworkConfig = z.infer<typeof NetworkConfig>;

export const OverviewMetrics = z.object({
  hub: HubIdentity,
  uptimeSeconds: z.number(),
  startedAt: IsoDateTime,
  connections: z.object({ active: z.number().int(), players: z.number().int(), companions: z.number().int(), historical: z.number().int(), reconnects: z.number().int(), wsErrors: z.number().int() }),
  pairing: z.object({ pending: z.number().int(), attempts: z.number().int(), failures: z.number().int() }),
  groups: z.array(z.object({ groupId: Uuid, name: z.string(), queueLength: z.number().int(), listeners: z.number().int(), status: z.string() })),
  providers: z.array(ProviderHealth),
  jobs: z.object({ queued: z.number().int(), running: z.number().int(), failed: z.number().int(), completed: z.number().int() }),
  discord: DiscordStatus,
  database: z.object({ migrationVersion: z.number().int(), sizeBytes: z.number().int(), lastBackupAt: IsoDateTime.nullable(), walMode: z.boolean() }),
  storage: z.object({ dataDir: z.string(), freeBytes: z.number().int().nullable(), totalBytes: z.number().int().nullable() }),
  alerts: z.array(z.object({ level: z.enum(['info', 'warning', 'error']), message: z.string() })),
  memoryRssBytes: z.number().int(),
});

export const ConnectionView = z.object({
  deviceId: Uuid,
  name: z.string(),
  kind: DeviceKind,
  appVersion: z.string(),
  protocolVersion: z.number().int(),
  scopes: z.array(Scope),
  groupId: Uuid.nullable(),
  connectedAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  latencyMs: z.number().nullable(),
  syncDriftMs: z.number().nullable(),
  transferState: z.string().nullable(),
  ipDisplay: z.string().nullable(),
  reconnects: z.number().int(),
});

export const FormatAvailability = z.object({
  format: OutputFormat,
  available: z.boolean(),
  lossy: z.boolean(),
  reason: z.string().nullable(),
  qualityNote: z.string(),
});

export const TasteProfileView = z.object({
  ownerId: Uuid,
  computedAt: IsoDateTime,
  eventCount: z.number().int(),
  dimensions: z.record(z.string(), z.array(z.object({ key: z.string(), weight: z.number() }))),
  contexts: z.array(z.object({ kind: z.string(), id: z.string(), name: z.string().nullable(), eventCount: z.number().int(), topArtists: z.array(z.object({ key: z.string(), weight: z.number() })) })),
  discoveryPreference: z.number(),
  popularityPreference: z.number(),
  coldStart: z.boolean(),
});

/* ---------- route table ---------- */

const groupParams = z.object({ groupId: Uuid });

export const routes = {
  /* health */
  healthz: defineRoute({ method: 'GET', path: '/healthz', absolute: true, operationId: 'healthz', summary: 'Liveness probe', tags: ['health'], auth: 'none', rateLimit: 'none', response: z.object({ status: z.literal('ok'), version: z.string() }) }),
  readyz: defineRoute({ method: 'GET', path: '/readyz', absolute: true, operationId: 'readyz', summary: 'Readiness probe', tags: ['health'], auth: 'none', rateLimit: 'none', response: z.object({ status: z.enum(['ok', 'starting', 'degraded', 'stopping']), checks: z.record(z.string(), z.enum(['ok', 'fail', 'skipped'])) }) }),
  version: defineRoute({ method: 'GET', path: '/version', operationId: 'getVersion', summary: 'Version and compatibility', tags: ['health'], auth: 'none', rateLimit: 'none', response: z.object({ version: z.string(), contractsVersion: z.string(), protocolVersion: z.number().int(), minSupportedProtocolVersion: z.number().int(), node: z.string(), ffmpeg: z.object({ available: z.boolean(), version: z.string().nullable() }) }) }),

  /* hub identity + auth */
  hubIdentity: defineRoute({ method: 'GET', path: '/hub', operationId: 'getHubIdentity', summary: 'Hub identity (stable id, fingerprint, bind mode)', tags: ['hub'], auth: 'none', response: HubIdentity }),
  authSession: defineRoute({ method: 'GET', path: '/auth/session', operationId: 'getSession', summary: 'Current admin session', tags: ['auth'], auth: 'none', setupRequired: false, response: SessionInfo }),
  authLogin: defineRoute({ method: 'POST', path: '/auth/login', operationId: 'login', summary: 'Admin login (bootstrap admin/admin works exactly once on fresh state)', tags: ['auth'], auth: 'none', setupRequired: false, rateLimit: 'auth', body: z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(512) }), response: SessionInfo }),
  authChangePassword: defineRoute({ method: 'POST', path: '/auth/change-password', operationId: 'changePassword', summary: 'Replace the admin password (required before any remote/provider feature)', tags: ['auth'], auth: 'admin', setupRequired: false, rateLimit: 'auth', body: z.object({ currentPassword: z.string().min(1).max(512), newPassword: z.string().min(12).max(512) }), response: SessionInfo }),
  authLogout: defineRoute({ method: 'POST', path: '/auth/logout', operationId: 'logout', summary: 'Logout and revoke session', tags: ['auth'], auth: 'admin', setupRequired: false, response: Ok }),
  securitySessions: defineRoute({ method: 'GET', path: '/security/sessions', operationId: 'listSessions', summary: 'Active admin sessions', tags: ['security'], auth: 'admin', response: z.object({ items: z.array(z.object({ id: z.string(), createdAt: IsoDateTime, lastSeenAt: IsoDateTime, expiresAt: IsoDateTime, ipDisplay: z.string().nullable(), userAgent: z.string().nullable(), current: z.boolean() })) }) }),
  securityRevokeSession: defineRoute({ method: 'DELETE', path: '/security/sessions/:sessionId', operationId: 'revokeSession', summary: 'Revoke an admin session', tags: ['security'], auth: 'admin', params: z.object({ sessionId: z.string() }), response: Ok }),
  securityAudit: defineRoute({ method: 'GET', path: '/security/audit', operationId: 'listAudit', summary: 'Security audit log', tags: ['security'], auth: 'admin', query: PagingQuery.extend({ action: z.string().optional() }), response: Paged(AuditEvent) }),

  /* pairing */
  pairingCreate: defineRoute({ method: 'POST', path: '/pairing/sessions', operationId: 'createPairingSession', summary: 'Create a short-lived single-use pairing session', tags: ['pairing'], auth: 'admin', rateLimit: 'write', body: z.object({ deviceKind: DeviceKind, scopes: z.array(Scope).min(1), ttlSeconds: z.number().int().min(60).max(3600).default(600) }), response: z.object({ sessionId: Uuid, code: z.string(), expiresAt: IsoDateTime, deepLink: z.string(), qrSvg: z.string(), hubFingerprint: z.string(), endpointKnown: z.boolean(), note: z.string() }), responseStatus: 201 }),
  pairingList: defineRoute({ method: 'GET', path: '/pairing/sessions', operationId: 'listPairingSessions', summary: 'List pairing sessions (no codes)', tags: ['pairing'], auth: 'admin', response: z.object({ items: z.array(PairingSessionView) }) }),
  pairingRevoke: defineRoute({ method: 'DELETE', path: '/pairing/sessions/:sessionId', operationId: 'revokePairingSession', summary: 'Revoke a pairing session', tags: ['pairing'], auth: 'admin', params: z.object({ sessionId: Uuid }), response: Ok }),
  pairingClaim: defineRoute({ method: 'POST', path: '/pairing/claim', operationId: 'claimPairing', summary: 'Joining device presents code, name and ephemeral public key', tags: ['pairing'], auth: 'none', rateLimit: 'pairing', body: z.object({ code: z.string().min(8).max(24), deviceName: z.string().min(1).max(80), deviceKind: DeviceKind, publicKey: z.string().min(16).max(4096), appVersion: z.string().max(40), protocolVersion: z.number().int().positive(), platform: z.string().max(80).optional() }), response: z.object({ sessionId: Uuid, claimSecret: z.string(), verificationFingerprint: z.string(), hubFingerprint: z.string(), hubId: Uuid, hubName: z.string(), expiresAt: IsoDateTime }) }),
  pairingConfirm: defineRoute({ method: 'POST', path: '/pairing/sessions/:sessionId/confirm', operationId: 'confirmPairing', summary: 'Authorized user confirms the verification fingerprint', tags: ['pairing'], auth: 'admin', params: z.object({ sessionId: Uuid }), body: z.object({ verificationFingerprint: z.string() }), response: Ok }),
  pairingStatus: defineRoute({ method: 'POST', path: '/pairing/status', operationId: 'pairingStatus', summary: 'Joining device polls for confirmation', tags: ['pairing'], auth: 'none', rateLimit: 'pairing', body: z.object({ sessionId: Uuid, claimSecret: z.string() }), response: z.object({ state: z.enum(['pending', 'claimed', 'confirmed', 'consumed', 'expired', 'revoked']) }) }),
  pairingComplete: defineRoute({ method: 'POST', path: '/pairing/complete', operationId: 'completePairing', summary: 'Exchange a confirmed session for a scoped, revocable device credential (single use)', tags: ['pairing'], auth: 'none', rateLimit: 'pairing', body: z.object({ sessionId: Uuid, claimSecret: z.string() }), response: DeviceCredentialSecret }),

  /* devices */
  devicesList: defineRoute({ method: 'GET', path: '/devices', operationId: 'listDevices', summary: 'Paired devices with connection state', tags: ['devices'], auth: 'admin', response: z.object({ items: z.array(DeviceView) }) }),
  devicesRevoke: defineRoute({ method: 'DELETE', path: '/devices/:deviceId', operationId: 'revokeDevice', summary: 'Revoke a device and all its credentials', tags: ['devices'], auth: 'admin', params: z.object({ deviceId: Uuid }), response: Ok }),
  devicesUpdate: defineRoute({ method: 'PATCH', path: '/devices/:deviceId', operationId: 'updateDevice', summary: 'Update device name or scopes', tags: ['devices'], auth: 'admin', params: z.object({ deviceId: Uuid }), body: z.object({ name: z.string().min(1).max(80).optional(), scopes: z.array(Scope).optional() }), response: Device }),
  devicesMe: defineRoute({ method: 'GET', path: '/devices/me', operationId: 'getMyDevice', summary: 'Device credential introspection', tags: ['devices'], auth: 'device', response: z.object({ device: Device, scopes: z.array(Scope), hub: HubIdentity, user: z.object({ id: Uuid, displayName: z.string() }) }) }),

  /* search + providers */
  search: defineRoute({ method: 'GET', path: '/search', operationId: 'search', summary: 'Aggregate search across enabled providers (partial results on failure)', tags: ['search'], auth: 'admin-or-device', scopes: ['search:use'], rateLimit: 'search', query: z.object({ q: z.string().min(1).max(200), scope: SearchScope.default('all'), providers: z.string().optional().describe('Comma-separated provider filter'), cursor: Cursor.optional(), limit: z.coerce.number().int().min(1).max(50).default(25) }), response: SearchResponse }),
  providersList: defineRoute({ method: 'GET', path: '/providers', operationId: 'listProviders', summary: 'Provider capability matrix and health', tags: ['providers'], auth: 'admin-or-device', setupRequired: false, response: z.object({ items: z.array(ProviderDescriptor), health: z.array(ProviderHealth) }) }),
  providersConfigGet: defineRoute({ method: 'GET', path: '/providers/:provider/config', operationId: 'getProviderConfig', summary: 'Application-level provider configuration (secrets masked)', tags: ['providers'], auth: 'admin', params: z.object({ provider: ProviderId }), response: ProviderAppConfigView }),
  providersConfigPut: defineRoute({ method: 'PUT', path: '/providers/:provider/config', operationId: 'putProviderConfig', summary: 'Set application credentials once (admin); never returned', tags: ['providers'], auth: 'admin', rateLimit: 'write', params: z.object({ provider: ProviderId }), body: ProviderAppConfigInput.omit({ provider: true }), response: ProviderAppConfigView }),
  providersTest: defineRoute({ method: 'POST', path: '/providers/:provider/test', operationId: 'testProvider', summary: 'Test provider connectivity/credentials', tags: ['providers'], auth: 'admin', params: z.object({ provider: ProviderId }), response: z.object({ ok: z.boolean(), latencyMs: z.number().nullable(), message: z.string() }) }),
  providersResolve: defineRoute({ method: 'GET', path: '/providers/resolve', operationId: 'resolveUrl', summary: 'Resolve a pasted URL or id to a capability-annotated result', tags: ['providers'], auth: 'admin-or-device', scopes: ['search:use'], rateLimit: 'search', query: z.object({ url: z.string().min(1).max(2048) }), response: SearchResult }),
  providersUsage: defineRoute({ method: 'GET', path: '/providers/usage', operationId: 'providerUsage', summary: 'Quota budgets, circuit state and request classes', tags: ['providers'], auth: 'admin', response: z.object({ items: z.array(z.object({ provider: ProviderId, health: ProviderHealth, budget: z.object({ perMinute: z.number(), perDay: z.number().nullable(), usedMinute: z.number(), usedDay: z.number(), shedding: z.array(z.string()) }), queueDepth: z.record(z.string(), z.number()), concurrency: z.object({ limit: z.number(), inFlight: z.number() }) })) }) }),
  artistReleases: defineRoute({ method: 'GET', path: '/artists/releases', operationId: 'latestReleases', summary: 'Latest releases from MusicBrainz plus enabled playback providers', tags: ['discovery'], auth: 'admin-or-device', scopes: ['search:use'], rateLimit: 'search', query: z.object({ mbid: z.string().optional(), name: z.string().optional(), refresh: z.coerce.boolean().default(false) }), response: LatestReleasesResponse }),

  /* per-user provider accounts */
  accountsList: defineRoute({ method: 'GET', path: '/accounts', operationId: 'listAccounts', summary: "The caller's connected provider accounts", tags: ['accounts'], auth: 'device', response: z.object({ items: z.array(ProviderAccount), available: z.array(z.object({ provider: ProviderId, configured: z.boolean(), reason: z.string().nullable() })) }) }),
  accountsConnectStart: defineRoute({ method: 'POST', path: '/accounts/:provider/connect', operationId: 'startAccountConnect', summary: 'Begin OAuth 2.0 authorization-code (+PKCE) flow', tags: ['accounts'], auth: 'device', rateLimit: 'write', params: z.object({ provider: ProviderId }), body: z.object({ returnTo: z.string().max(2048).optional() }), response: z.object({ authorizationUrl: z.string().url(), state: z.string(), scopes: z.array(z.string()) }) }),
  accountsCallback: defineRoute({ method: 'GET', path: '/accounts/:provider/callback', operationId: 'accountCallback', summary: 'OAuth redirect target (exchanges code server-side, redirects back)', tags: ['accounts'], auth: 'none', rateLimit: 'auth', params: z.object({ provider: ProviderId }), query: z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional() }), response: z.string(), responseContentType: 'text/html' }),
  accountsDisconnect: defineRoute({ method: 'DELETE', path: '/accounts/:provider', operationId: 'disconnectAccount', summary: 'Revoke and delete a provider connection', tags: ['accounts'], auth: 'device', params: z.object({ provider: ProviderId }), response: Ok }),
  accountsSync: defineRoute({ method: 'POST', path: '/accounts/:provider/sync', operationId: 'syncAccount', summary: 'Queue an incremental import of likes/playlists', tags: ['accounts'], auth: 'device', rateLimit: 'write', params: z.object({ provider: ProviderId }), response: z.object({ jobId: Uuid, status: z.string() }) }),
  accountsSyncStatus: defineRoute({ method: 'GET', path: '/accounts/:provider/sync', operationId: 'accountSyncStatus', summary: 'Import checkpoint status', tags: ['accounts'], auth: 'device', params: z.object({ provider: ProviderId }), response: UserPlatformSync }),

  /* groups */
  groupsList: defineRoute({ method: 'GET', path: '/groups', operationId: 'listGroups', summary: 'Groups visible to the caller', tags: ['groups'], auth: 'admin-or-device', response: z.object({ items: z.array(GroupView) }) }),
  groupsCreate: defineRoute({ method: 'POST', path: '/groups', operationId: 'createGroup', summary: 'Create a group', tags: ['groups'], auth: 'admin-or-device', scopes: ['group:member'], rateLimit: 'write', body: z.object({ name: z.string().min(1).max(80), settings: GroupSettings.partial().optional() }), response: GroupView, responseStatus: 201 }),
  groupsGet: defineRoute({ method: 'GET', path: '/groups/:groupId', operationId: 'getGroup', summary: 'Group detail', tags: ['groups'], auth: 'admin-or-device', params: groupParams, response: GroupView }),
  groupsUpdate: defineRoute({ method: 'PATCH', path: '/groups/:groupId', operationId: 'updateGroup', summary: 'Rename or change settings', tags: ['groups'], auth: 'admin-or-device', scopes: ['group:admin'], params: groupParams, body: z.object({ name: z.string().min(1).max(80).optional(), settings: GroupSettings.partial().optional() }), response: GroupView }),
  groupsArchive: defineRoute({ method: 'POST', path: '/groups/:groupId/archive', operationId: 'archiveGroup', summary: 'Archive a group', tags: ['groups'], auth: 'admin-or-device', scopes: ['group:admin'], params: groupParams, response: Ok }),
  groupsInvite: defineRoute({ method: 'POST', path: '/groups/:groupId/invites', operationId: 'createInvite', summary: 'Create an invite code', tags: ['groups'], auth: 'admin-or-device', scopes: ['group:admin'], rateLimit: 'write', params: groupParams, body: z.object({ ttlSeconds: z.number().int().min(60).max(86400).default(3600), role: GroupRole.exclude(['owner']).default('member') }), response: z.object({ inviteCode: z.string(), expiresAt: IsoDateTime }) }),
  groupsJoin: defineRoute({ method: 'POST', path: '/groups/join', operationId: 'joinGroup', summary: 'Join with an invite code', tags: ['groups'], auth: 'device', scopes: ['group:member'], rateLimit: 'pairing', body: z.object({ inviteCode: z.string().min(4).max(40), displayName: z.string().max(120).optional() }), response: GroupView }),
  groupsLeave: defineRoute({ method: 'POST', path: '/groups/:groupId/leave', operationId: 'leaveGroup', summary: 'Leave a group', tags: ['groups'], auth: 'device', params: groupParams, response: Ok }),
  groupsMemberRevoke: defineRoute({ method: 'DELETE', path: '/groups/:groupId/members/:memberId', operationId: 'revokeMember', summary: 'Remove a member', tags: ['groups'], auth: 'admin-or-device', scopes: ['group:admin'], params: groupParams.extend({ memberId: z.string() }), response: Ok }),
  groupsMemberRole: defineRoute({ method: 'PATCH', path: '/groups/:groupId/members/:memberId', operationId: 'setMemberRole', summary: 'Change a member role or sharing flag', tags: ['groups'], auth: 'admin-or-device', params: groupParams.extend({ memberId: z.string() }), body: z.object({ role: GroupRole.exclude(['owner']).optional(), shareAggregate: z.boolean().optional() }), response: GroupMemberView }),
  groupsQueueGet: defineRoute({ method: 'GET', path: '/groups/:groupId/queue', operationId: 'getGroupQueue', summary: 'Authoritative queue + playback', tags: ['groups'], auth: 'admin-or-device', params: groupParams, response: z.object({ queue: Queue, playback: GroupPlaybackState, serverTime: IsoDateTime }) }),
  groupsQueueCommand: defineRoute({ method: 'POST', path: '/groups/:groupId/queue/commands', operationId: 'groupQueueCommand', summary: 'Revisioned, idempotent queue command', tags: ['groups'], auth: 'admin-or-device', scopes: ['group:member'], rateLimit: 'write', params: groupParams, body: z.object({ idempotencyKey: z.string().min(1).max(120), baseRevision: z.number().int().nonnegative(), command: QueueCommand }), response: QueueCommandResult }),
  groupsHistoryList: defineRoute({ method: 'GET', path: '/groups/:groupId/history', operationId: 'listGroupHistory', summary: 'Group history (JSON)', tags: ['groups'], auth: 'admin-or-device', params: groupParams, query: PagingQuery, response: Paged(GroupHistoryEntry) }),
  groupsHistoryExportCsv: defineRoute({ method: 'GET', path: '/groups/:groupId/history.csv', operationId: 'exportGroupHistoryCsv', summary: 'RFC-4180 CSV export (UTF-8, schema_version column)', tags: ['groups'], auth: 'admin-or-device', params: groupParams, response: z.string(), responseContentType: 'text/csv; charset=utf-8' }),
  groupsHistoryExportJson: defineRoute({ method: 'GET', path: '/groups/:groupId/history.json', operationId: 'exportGroupHistoryJson', summary: 'Canonical JSON export', tags: ['groups'], auth: 'admin-or-device', params: groupParams, response: z.object({ schemaVersion: z.number().int(), groupId: Uuid, exportedAt: IsoDateTime, entries: z.array(GroupHistoryEntry) }) }),
  groupsHistoryImport: defineRoute({ method: 'POST', path: '/groups/:groupId/history/import', operationId: 'importGroupHistory', summary: 'Validate and import CSV/JSON history (dry run supported, idempotent by event_id)', tags: ['groups'], auth: 'admin-or-device', scopes: ['group:admin'], rateLimit: 'write', params: groupParams, query: z.object({ dryRun: z.coerce.boolean().default(false), format: z.enum(['csv', 'json']).default('csv') }), body: z.string().max(20 * 1024 * 1024), requestContentType: 'text/plain', response: HistoryImportReport }),
  groupsSync: defineRoute({ method: 'GET', path: '/groups/:groupId/sync', operationId: 'groupSyncInfo', summary: 'Timeline and drift information', tags: ['groups'], auth: 'admin-or-device', params: groupParams, response: z.object({ serverTime: IsoDateTime, playback: GroupPlaybackState, members: z.array(z.object({ memberId: z.string(), driftMs: z.number().nullable(), dspLatencyMs: z.number().nullable(), online: z.boolean() })) }) }),
  groupsAggregate: defineRoute({ method: 'GET', path: '/groups/:groupId/aggregate', operationId: 'groupAggregate', summary: 'Opt-in aggregate taste overlap for a group', tags: ['groups', 'recommendations'], auth: 'admin-or-device', params: groupParams, response: GroupAggregateView }),

  /* aggregate profiles + events + recommendations */
  aggregatePut: defineRoute({ method: 'PUT', path: '/aggregate-profiles/me', operationId: 'putAggregateProfile', summary: 'Share (opt-in) an aggregate taste vector; never raw history', tags: ['recommendations'], auth: 'device', scopes: ['history:aggregate'], rateLimit: 'write', body: AggregateTasteProfile, response: Ok }),
  aggregateDelete: defineRoute({ method: 'DELETE', path: '/aggregate-profiles/me', operationId: 'deleteAggregateProfile', summary: 'Revoke and delete shared aggregate', tags: ['recommendations'], auth: 'device', response: Ok }),
  aggregateGet: defineRoute({ method: 'GET', path: '/aggregate-profiles/me', operationId: 'getAggregateProfile', summary: 'Preview what is shared', tags: ['recommendations'], auth: 'device', response: z.object({ profile: AggregateTasteProfile.nullable() }) }),
  eventsIngest: defineRoute({ method: 'POST', path: '/listening-events', operationId: 'ingestListeningEvents', summary: 'Opt-in listening events for hub-side personalization (scope history:events)', tags: ['recommendations'], auth: 'device', scopes: ['history:events'], rateLimit: 'write', body: z.object({ events: z.array(ListeningEvent).min(1).max(1000) }), response: z.object({ accepted: z.number().int(), duplicates: z.number().int() }) }),
  recommendationsGet: defineRoute({ method: 'GET', path: '/recommendations', operationId: 'getRecommendations', summary: 'Ranked, diversified recommendations for a mode', tags: ['recommendations'], auth: 'device', query: z.object({ mode: RecommendationMode.default('for-you'), contextId: z.string().max(200).optional(), seeds: z.string().max(2000).optional().describe('Comma-separated canonical track/artist ids for similar mode'), limit: z.coerce.number().int().min(1).max(100).default(30), exploration: z.coerce.number().min(0).max(1).optional() }), response: z.object({ mode: RecommendationMode, items: z.array(Recommendation), generatedAt: IsoDateTime, fromCache: z.boolean(), coverage: z.object({ candidates: z.number().int(), sources: z.record(z.string(), z.number().int()), coldStart: z.boolean() }) }) }),
  recommendationsFeedback: defineRoute({ method: 'POST', path: '/recommendations/:recommendationId/feedback', operationId: 'recommendationFeedback', summary: 'Like / Not for me / Less from this artist / Already know it', tags: ['recommendations'], auth: 'device', rateLimit: 'write', params: z.object({ recommendationId: Uuid }), body: z.object({ feedback: RecommendationFeedback }), response: Ok }),
  recommendationsSeeds: defineRoute({ method: 'POST', path: '/recommendations/seeds', operationId: 'setRecommendationSeeds', summary: 'Cold-start seeds (artists, genres, starter likes)', tags: ['recommendations'], auth: 'device', rateLimit: 'write', body: z.object({ artists: z.array(z.string().max(200)).max(50).default([]), genres: z.array(z.string().max(60)).max(50).default([]), likedTrackIds: z.array(z.string().max(200)).max(50).default([]) }), response: Ok }),
  recommendationsProfile: defineRoute({ method: 'GET', path: '/recommendations/profile', operationId: 'getTasteProfile', summary: 'Inspectable taste profile (dimensions and contexts)', tags: ['recommendations'], auth: 'device', response: TasteProfileView }),
  recommendationsConfigGet: defineRoute({ method: 'GET', path: '/recommendations/config', operationId: 'getRecommendationConfig', summary: 'Weights, decay and diversity configuration', tags: ['recommendations'], auth: 'admin', response: z.record(z.string(), z.unknown()) }),
  recommendationsConfigPut: defineRoute({ method: 'PUT', path: '/recommendations/config', operationId: 'putRecommendationConfig', summary: 'Update recommendation configuration', tags: ['recommendations'], auth: 'admin', rateLimit: 'write', body: z.record(z.string(), z.unknown()), response: z.record(z.string(), z.unknown()) }),

  /* downloads */
  downloadsList: defineRoute({ method: 'GET', path: '/downloads', operationId: 'listDownloads', summary: 'Download jobs', tags: ['downloads'], auth: 'admin-or-device', response: z.object({ items: z.array(DownloadJob) }) }),
  downloadsCreate: defineRoute({ method: 'POST', path: '/downloads', operationId: 'createDownload', summary: 'Create an authorized download job (capability-gated)', tags: ['downloads'], auth: 'admin-or-device', scopes: ['downloads:request'], rateLimit: 'write', body: z.object({ source: DownloadJob.shape.source, authorization: z.object({ basis: DownloadAuthorizationBasis, evidence: z.string().max(500).optional(), acknowledged: z.literal(true) }), target: z.object({ destination: DownloadDestination.exclude(['ask']), directoryId: z.string().max(200).optional(), filenameTemplate: z.string().max(200).optional(), format: OutputFormat.default('original'), quality: z.string().max(40).optional() }) }), response: DownloadJob, responseStatus: 201 }),
  downloadsAction: defineRoute({ method: 'POST', path: '/downloads/:jobId/:action', operationId: 'downloadAction', summary: 'cancel | pause | resume | retry', tags: ['downloads'], auth: 'admin-or-device', params: z.object({ jobId: Uuid, action: z.enum(['cancel', 'pause', 'resume', 'retry']) }), response: DownloadJob }),
  downloadsFormats: defineRoute({ method: 'GET', path: '/downloads/formats', operationId: 'downloadFormats', summary: 'Output formats available from the bundled FFmpeg build', tags: ['downloads'], auth: 'admin-or-device', setupRequired: false, response: z.object({ formats: z.array(FormatAvailability), ffmpeg: z.object({ available: z.boolean(), version: z.string().nullable(), encoders: z.array(z.string()) }) }) }),
  downloadsStorage: defineRoute({ method: 'GET', path: '/downloads/storage', operationId: 'downloadStorage', summary: 'Storage and cleanup state', tags: ['downloads'], auth: 'admin', response: z.object({ dataDir: z.string(), freeBytes: z.number().int().nullable(), totalBytes: z.number().int().nullable(), usedByDownloadsBytes: z.number().int(), partialFiles: z.number().int(), cleanupPolicy: z.object({ keepFailedDays: z.number().int(), keepPartialHours: z.number().int() }), directories: z.array(z.object({ id: z.string(), name: z.string(), relativePath: z.string() })) }) }),

  /* hub-hosted library */
  libraryTracks: defineRoute({ method: 'GET', path: '/library/tracks', operationId: 'listLibraryTracks', summary: 'Hub-hosted and companion-exposed tracks', tags: ['library'], auth: 'admin-or-device', scopes: ['library:read'], query: PagingQuery.extend({ q: z.string().max(200).optional(), source: z.enum(['hub', 'companion', 'all']).default('all') }), response: Paged(Track) }),
  libraryRoots: defineRoute({ method: 'GET', path: '/library/roots', operationId: 'listLibraryRoots', summary: 'Hub library directories under /data', tags: ['library'], auth: 'admin', response: z.object({ items: z.array(LibraryRoot) }) }),
  libraryRootAdd: defineRoute({ method: 'POST', path: '/library/roots', operationId: 'addLibraryRoot', summary: 'Register a directory inside the mounted data volume', tags: ['library'], auth: 'admin', rateLimit: 'write', body: z.object({ relativePath: z.string().min(1).max(500), displayName: z.string().min(1).max(200) }), response: LibraryRoot, responseStatus: 201 }),
  libraryRootRemove: defineRoute({ method: 'DELETE', path: '/library/roots/:rootId', operationId: 'removeLibraryRoot', summary: 'Remove a root without deleting files', tags: ['library'], auth: 'admin', params: z.object({ rootId: Uuid }), response: Ok }),
  libraryScan: defineRoute({ method: 'POST', path: '/library/scan', operationId: 'scanLibrary', summary: 'Rescan hub roots', tags: ['library'], auth: 'admin', rateLimit: 'write', response: z.object({ jobId: Uuid, roots: z.number().int() }) }),
  libraryStream: defineRoute({ method: 'GET', path: '/library/stream/:trackId', operationId: 'streamTrack', summary: 'Range-capable audio stream of an authorized hub track', tags: ['library'], auth: 'admin-or-device', scopes: ['library:read'], params: z.object({ trackId: Uuid }), response: z.unknown(), responseContentType: 'audio/*' }),
  libraryArtwork: defineRoute({ method: 'GET', path: '/library/artwork/:artworkId', operationId: 'getArtwork', summary: 'Artwork bytes', tags: ['library'], auth: 'admin-or-device', params: z.object({ artworkId: z.string().max(200) }), response: z.unknown(), responseContentType: 'image/*' }),

  /* companion sync + files + transfers */
  syncManifest: defineRoute({ method: 'POST', path: '/sync/manifest', operationId: 'exchangeManifest', summary: 'Manifest exchange to decide which collections need deltas', tags: ['sync'], auth: 'device', scopes: ['library:share'], rateLimit: 'write', body: SyncManifest, response: z.object({ serverManifest: SyncManifest, needed: z.array(z.string()) }) }),
  syncDelta: defineRoute({ method: 'POST', path: '/sync/delta', operationId: 'exchangeDelta', summary: 'Idempotent delta exchange with tombstones and conflict resolution', tags: ['sync'], auth: 'device', scopes: ['library:share'], rateLimit: 'write', body: SyncDeltaRequest, response: SyncDeltaResponse }),
  syncStatus: defineRoute({ method: 'GET', path: '/sync/status', operationId: 'syncStatus', summary: 'Sync status for the calling device', tags: ['sync'], auth: 'device', response: SyncStatus }),
  filesHead: defineRoute({ method: 'HEAD', path: '/files/:contentHash', operationId: 'headFile', summary: 'Does the hub hold this content hash (and how many bytes)?', tags: ['files'], auth: 'device', scopes: ['transfers:receive'], params: z.object({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) }), response: z.unknown() }),
  filesPut: defineRoute({ method: 'PUT', path: '/files/:contentHash', operationId: 'putFileChunk', summary: 'Upload a chunk at an offset; final chunk verifies the checksum and renames atomically', tags: ['files'], auth: 'device', scopes: ['transfers:receive'], params: z.object({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) }), query: z.object({ offset: z.coerce.number().int().nonnegative(), total: z.coerce.number().int().positive(), trackId: Uuid.optional() }), body: z.unknown(), requestContentType: 'application/octet-stream', response: z.object({ receivedBytes: z.number().int(), complete: z.boolean(), verified: z.boolean() }) }),
  filesGet: defineRoute({ method: 'GET', path: '/files/:contentHash', operationId: 'getFile', summary: 'Download authorized bytes (range capable)', tags: ['files'], auth: 'device', scopes: ['transfers:receive'], params: z.object({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) }), response: z.unknown(), responseContentType: 'application/octet-stream' }),
  transfersList: defineRoute({ method: 'GET', path: '/transfers', operationId: 'listTransfers', summary: 'Transfer jobs involving the caller', tags: ['files'], auth: 'admin-or-device', response: z.object({ items: z.array(TransferJob) }) }),
  transfersCreate: defineRoute({ method: 'POST', path: '/transfers', operationId: 'createTransfer', summary: 'Schedule a device-to-device transfer through the hub', tags: ['files'], auth: 'device', scopes: ['transfers:receive'], rateLimit: 'write', body: z.object({ toDeviceId: Uuid, contentHash: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().nonnegative(), trackId: Uuid.optional(), policy: DownloadDestination.default('both') }), response: TransferJob, responseStatus: 201 }),
  transfersAction: defineRoute({ method: 'POST', path: '/transfers/:jobId/:action', operationId: 'transferAction', summary: 'cancel | pause | resume | retry', tags: ['files'], auth: 'admin-or-device', params: z.object({ jobId: Uuid, action: z.enum(['cancel', 'pause', 'resume', 'retry']) }), response: TransferJob }),

  /* metrics */
  metricsOverview: defineRoute({ method: 'GET', path: '/metrics/overview', operationId: 'metricsOverview', summary: 'Operational overview', tags: ['metrics'], auth: 'admin', setupRequired: false, response: OverviewMetrics }),
  metricsConnections: defineRoute({ method: 'GET', path: '/metrics/connections', operationId: 'metricsConnections', summary: 'Active and recent connections', tags: ['metrics'], auth: 'admin', response: z.object({ active: z.array(ConnectionView), recent: z.array(ConnectionView), counters: z.record(z.string(), z.number()) }) }),
  metricsRaw: defineRoute({ method: 'GET', path: '/metrics/raw', operationId: 'metricsRaw', summary: 'Counters and histograms (JSON)', tags: ['metrics'], auth: 'admin', response: z.object({ counters: z.record(z.string(), z.number()), histograms: z.record(z.string(), z.object({ count: z.number(), sum: z.number(), p50: z.number().nullable(), p95: z.number().nullable(), p99: z.number().nullable(), max: z.number().nullable() })), generatedAt: IsoDateTime }) }),

  /* discord */
  discordConfigGet: defineRoute({ method: 'GET', path: '/discord/config', operationId: 'getDiscordConfig', summary: 'Bot configuration (token masked)', tags: ['discord'], auth: 'admin', response: DiscordConfiguration }),
  discordConfigPut: defineRoute({ method: 'PUT', path: '/discord/config', operationId: 'putDiscordConfig', summary: 'Update bot configuration', tags: ['discord'], auth: 'admin', rateLimit: 'write', body: DiscordConfiguration.omit({ id: true, updatedAt: true, tokenSource: true, tokenLast4: true }).partial(), response: DiscordConfiguration }),
  discordTokenSet: defineRoute({ method: 'POST', path: '/discord/token', operationId: 'setDiscordToken', summary: 'Validate and store the bot token encrypted at rest (never returned)', tags: ['discord'], auth: 'admin', rateLimit: 'write', body: z.object({ token: z.string().min(20).max(200) }), response: z.object({ valid: z.boolean(), tokenLast4: z.string(), applicationId: z.string().nullable(), botUsername: z.string().nullable(), message: z.string() }) }),
  discordTokenClear: defineRoute({ method: 'DELETE', path: '/discord/token', operationId: 'clearDiscordToken', summary: 'Remove the stored token', tags: ['discord'], auth: 'admin', response: Ok }),
  discordAction: defineRoute({ method: 'POST', path: '/discord/actions/:action', operationId: 'discordAction', summary: 'start | stop | reconnect | test | register-commands', tags: ['discord'], auth: 'admin', rateLimit: 'write', params: z.object({ action: z.enum(['start', 'stop', 'reconnect', 'test', 'register-commands']) }), response: DiscordStatus }),
  discordStatus: defineRoute({ method: 'GET', path: '/discord/status', operationId: 'discordStatus', summary: 'Gateway/voice/command status', tags: ['discord'], auth: 'admin', setupRequired: false, response: DiscordStatus }),
  discordInviteUrl: defineRoute({ method: 'GET', path: '/discord/invite-url', operationId: 'discordInviteUrl', summary: 'Minimal-permission OAuth invite URL', tags: ['discord'], auth: 'admin', response: z.object({ url: z.string().url().nullable(), permissions: z.string(), scopes: z.array(z.string()), reason: z.string().nullable() }) }),
  discordTemplatesGet: defineRoute({ method: 'GET', path: '/discord/templates', operationId: 'getDiscordTemplates', summary: 'Response templates (export)', tags: ['discord'], auth: 'admin', response: DiscordTemplates }),
  discordTemplatesPut: defineRoute({ method: 'PUT', path: '/discord/templates', operationId: 'putDiscordTemplates', summary: 'Validate and save templates (import)', tags: ['discord'], auth: 'admin', rateLimit: 'write', body: DiscordTemplates, response: DiscordTemplates }),
  discordTemplatesPreview: defineRoute({ method: 'POST', path: '/discord/templates/preview', operationId: 'previewDiscordTemplate', summary: 'Render a template with sample variables', tags: ['discord'], auth: 'admin', body: z.object({ key: z.enum(DISCORD_TEMPLATE_KEYS), template: DiscordTemplate, sample: z.record(z.string(), z.string()).optional() }), response: z.object({ content: z.string(), embedTitle: z.string().nullable(), embedDescription: z.string().nullable(), warnings: z.array(z.string()), errors: z.array(z.string()), variablesUsed: z.array(z.string()) }) }),
  discordTemplatesReset: defineRoute({ method: 'POST', path: '/discord/templates/reset', operationId: 'resetDiscordTemplates', summary: 'Reset to defaults', tags: ['discord'], auth: 'admin', response: DiscordTemplates }),
  discordCommandTest: defineRoute({ method: 'POST', path: '/discord/commands/test', operationId: 'testDiscordCommand', summary: 'Run a command through the shared command service without Discord (fixture testing)', tags: ['discord'], auth: 'admin', body: z.object({ command: z.string().min(1).max(40), args: z.string().max(500).default(''), guildId: z.string(), channelId: z.string(), userId: z.string(), roleIds: z.array(z.string()).default([]), transport: z.enum(['slash', 'prefix']).default('slash') }), response: z.object({ ok: z.boolean(), templateKey: z.string(), content: z.string(), embedTitle: z.string().nullable(), embedDescription: z.string().nullable(), ephemeral: z.boolean() }) }),

  /* network, logs, diagnostics, backup, updates, releases */
  networkGet: defineRoute({ method: 'GET', path: '/network', operationId: 'getNetwork', summary: 'Bind mode and remote access configuration', tags: ['network'], auth: 'admin', setupRequired: false, response: NetworkConfig }),
  networkPut: defineRoute({ method: 'PUT', path: '/network', operationId: 'putNetwork', summary: 'Change bind mode / public endpoint / trusted proxies / IP logging (setup must be complete)', tags: ['network'], auth: 'admin', rateLimit: 'write', body: NetworkConfig.omit({ restartRequired: true, warnings: true, port: true, bindAddress: true }).partial(), response: NetworkConfig }),
  logsList: defineRoute({ method: 'GET', path: '/logs', operationId: 'listLogs', summary: 'Recent structured log lines (redacted)', tags: ['diagnostics'], auth: 'admin', query: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']).default('info'), limit: z.coerce.number().int().min(1).max(2000).default(200), since: IsoDateTime.optional() }), response: z.object({ items: z.array(z.object({ time: IsoDateTime, level: z.string(), msg: z.string(), correlationId: z.string().nullable(), module: z.string().nullable(), data: z.record(z.string(), z.unknown()) })) }) }),
  diagnosticsBundle: defineRoute({ method: 'GET', path: '/diagnostics/bundle', operationId: 'diagnosticsBundle', summary: 'Redacted diagnostics bundle (no tokens, full IPs, raw history, audio or user paths)', tags: ['diagnostics'], auth: 'admin', response: z.object({ schemaVersion: z.number().int(), generatedAt: IsoDateTime, redactions: z.array(z.string()), sections: z.record(z.string(), z.unknown()) }) }),
  backupCreate: defineRoute({ method: 'POST', path: '/backup', operationId: 'createBackup', summary: 'Consistent SQLite backup into the data volume', tags: ['backup'], auth: 'admin', rateLimit: 'write', response: z.object({ id: z.string(), createdAt: IsoDateTime, sizeBytes: z.number().int(), relativePath: z.string() }), responseStatus: 201 }),
  backupList: defineRoute({ method: 'GET', path: '/backup', operationId: 'listBackups', summary: 'Backups on the data volume', tags: ['backup'], auth: 'admin', response: z.object({ items: z.array(z.object({ id: z.string(), createdAt: IsoDateTime, sizeBytes: z.number().int(), relativePath: z.string() })) }) }),
  backupRestore: defineRoute({ method: 'POST', path: '/backup/:backupId/restore', operationId: 'restoreBackup', summary: 'Restore (a safety backup is taken first; restart required)', tags: ['backup'], auth: 'admin', rateLimit: 'write', params: z.object({ backupId: z.string() }), body: z.object({ confirm: z.literal(true) }), response: z.object({ ok: z.literal(true), safetyBackupId: z.string(), restartRequired: z.literal(true) }) }),
  exportAll: defineRoute({ method: 'GET', path: '/export', operationId: 'exportAll', summary: 'JSON export of groups, history, playlists, presets, devices (no secrets)', tags: ['backup'], auth: 'admin', response: z.object({ schemaVersion: z.number().int(), exportedAt: IsoDateTime, data: z.record(z.string(), z.unknown()) }) }),
  importAll: defineRoute({ method: 'POST', path: '/import', operationId: 'importAll', summary: 'Validate and import a JSON export (dry run supported)', tags: ['backup'], auth: 'admin', rateLimit: 'write', query: z.object({ dryRun: z.coerce.boolean().default(false) }), body: z.object({ schemaVersion: z.number().int(), data: z.record(z.string(), z.unknown()) }), response: z.object({ dryRun: z.boolean(), applied: z.record(z.string(), z.number().int()), errors: z.array(z.string()) }) }),
  updatesGet: defineRoute({ method: 'GET', path: '/updates', operationId: 'getUpdates', summary: 'Version compatibility matrix', tags: ['updates'], auth: 'admin', setupRequired: false, response: z.object({ currentVersion: z.string(), contractsVersion: z.string(), protocolVersion: z.number().int(), minSupportedProtocolVersion: z.number().int(), migrationVersion: z.number().int(), compatibility: z.array(z.object({ product: z.string(), minVersion: z.string(), protocolVersion: z.number().int() })), companionRelease: ReleaseMetadata.nullable() }) }),
  releasesWindowsLatest: defineRoute({ method: 'GET', path: '/releases/windows-companion/latest', operationId: 'getWindowsCompanionRelease', summary: 'Release metadata consumed by the PWA download link (404 when no release is configured)', tags: ['updates'], auth: 'none', setupRequired: false, response: ReleaseMetadata }),
  releasesWindowsPut: defineRoute({ method: 'PUT', path: '/releases/windows-companion/latest', operationId: 'putWindowsCompanionRelease', summary: 'Admin configures the release feed URL or metadata', tags: ['updates'], auth: 'admin', rateLimit: 'write', body: z.object({ feedUrl: z.string().url().nullable().optional(), metadata: ReleaseMetadata.nullable().optional() }), response: z.object({ feedUrl: z.string().url().nullable(), metadata: ReleaseMetadata.nullable(), lastFetchedAt: IsoDateTime.nullable(), lastError: z.string().nullable() }) }),

  /* listening mode helpers used by admin GUI */
  groupNowPlayingAdmin: defineRoute({ method: 'GET', path: '/groups/:groupId/now-playing', operationId: 'groupNowPlaying', summary: 'Now playing summary for admin views and Discord embeds', tags: ['groups'], auth: 'admin-or-device', params: groupParams, response: z.object({ mode: ListeningMode, groupId: Uuid, title: z.string().nullable(), artistName: z.string().nullable(), albumName: z.string().nullable(), artworkUrl: z.string().nullable(), source: ProviderId.nullable(), canonicalUrl: z.string().nullable(), durationMs: z.number().int().nullable(), positionMs: z.number().int(), requester: z.string().nullable(), syncGrade: z.string(), warning: z.string().nullable(), serverTime: IsoDateTime }) }),
} as const;

export type Routes = typeof routes;
export type RouteName = keyof Routes;

/** Absolute URL path for a route with params substituted. */
export function routePath(route: RouteContract, params: Record<string, string | number> = {}): string {
  const base = route.absolute ? route.path : `${API_PREFIX}${route.path}`;
  return base.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing route param ${name} for ${route.operationId}`);
    return encodeURIComponent(String(value));
  });
}

export const REALTIME_PATH = `${API_PREFIX}/realtime`;
