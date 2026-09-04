import type { Logger } from 'pino';
import type { HubIdentity } from '@now-playing/contracts';
import { CONTRACTS_VERSION, WS_MIN_SUPPORTED_PROTOCOL_VERSION, WS_PROTOCOL_VERSION } from '@now-playing/contracts';
import type { HubConfig } from './config.js';
import type { Clock, FfmpegInfo, HubDeps, RandomSource } from './deps.js';
import type { Db } from './db/connection.js';
import type { Repositories } from './db/repositories/index.js';
import type { Sealer } from './crypto/seal.js';
import type { HubLogging } from './observability/logger.js';
import type { MetricsRegistry } from './metrics/registry.js';
import type { NetworkService } from './network/service.js';
import type { RateLimiter } from './api/register.js';
import type { AuthService } from './auth/service.js';
import type { DeviceAuthService } from './auth/device-auth.js';
import type { AuditService } from './auth/audit.js';
import type { PairingService } from './pairing/service.js';
import type { DeviceService } from './pairing/devices.js';
import type { GroupService } from './group/service.js';
import type { RealtimeServer } from './realtime/server.js';
import type { CommandService } from './group/command-service.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { SearchService } from './providers/search-service.js';
import type { RateLimitManager } from './providers/rate-limit-manager.js';
import type { DownloadService } from './downloads/service.js';
import type { LibraryService } from './library/service.js';
import type { SyncService } from './sync/service.js';
import type { FileStore } from './sync/files.js';
import type { TransferService } from './sync/transfers.js';
import type { ShareService } from './shares/service.js';
import type { MetricsService } from './metrics/service.js';
import type { BackupService } from './backup/service.js';
import type { ReleaseService } from './releases/service.js';
import type { JobScheduler } from './jobs/scheduler.js';
import type { DiscordService } from './discord/service-interface.js';
import type { AccountsService } from './providers/accounts.js';
import type { RecommendationService } from './providers/recommendations.js';
import type { PlatformSyncService } from './providers/platform-sync.js';

export interface HubIdentityState {
  hubId: string;
  name: string;
  publicKey: string;
  privateKeyPem: string;
  fingerprint: string;
}

export type LifecycleState = 'starting' | 'ok' | 'stopping';

export interface HubContext {
  deps: HubDeps;
  config: HubConfig;
  clock: Clock;
  random: RandomSource;
  fetch: typeof globalThis.fetch;
  dnsLookup: (hostname: string) => Promise<string[]>;
  version: string;
  startedAt: number;
  db: Db;
  dbFile: string;
  repos: Repositories;
  installKey: Uint8Array;
  sealer: Sealer;
  identity: HubIdentityState;
  logging: HubLogging;
  log: Logger;
  metrics: MetricsRegistry;
  /** Per-IP token buckets for the HTTP API's rate-limit classes (distinct from the provider budgets). */
  httpRateLimiter: RateLimiter;
  lifecycle: { state: LifecycleState; migrationVersion: number };
  ffmpeg: () => Promise<FfmpegInfo>;
  network: NetworkService;
  audit: AuditService;
  auth: AuthService;
  deviceAuth: DeviceAuthService;
  pairing: PairingService;
  devices: DeviceService;
  groups: GroupService;
  realtime: RealtimeServer;
  commands: CommandService;
  providers: ProviderRegistry;
  search: SearchService;
  rateLimiter: RateLimitManager;
  accounts: AccountsService;
  recommendations: RecommendationService;
  platformSync: PlatformSyncService;
  downloads: DownloadService;
  library: LibraryService;
  sync: SyncService;
  files: FileStore;
  transfers: TransferService;
  shares: ShareService;
  metricsService: MetricsService;
  backup: BackupService;
  releases: ReleaseService;
  jobs: JobScheduler;
  discord: DiscordService;
}

export function nowIso(ctx: Pick<HubContext, 'clock'>): string {
  return new Date(ctx.clock.now()).toISOString();
}

/**
 * The hub's self-description, served unauthenticated at `/api/v1/hub` and embedded in the metrics
 * overview. It carries the public key and fingerprint (a device confirms the fingerprint out of
 * band during pairing) but nothing secret.
 */
export function hubIdentity(ctx: HubContext): HubIdentity {
  const network = ctx.network.current;
  return {
    hubId: ctx.identity.hubId,
    name: ctx.identity.name,
    version: ctx.version,
    contractsVersion: CONTRACTS_VERSION,
    protocolVersion: WS_PROTOCOL_VERSION,
    minSupportedProtocolVersion: WS_MIN_SUPPORTED_PROTOCOL_VERSION,
    publicKey: ctx.identity.publicKey,
    fingerprint: ctx.identity.fingerprint,
    bindMode: network.bindMode,
    publicEndpoint: network.publicEndpoint,
    setupComplete: ctx.auth.setupComplete(),
    codeOnlyPairingAvailable: ctx.network.codeOnlyPairingAvailable(),
  };
}
