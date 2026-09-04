/**
 * Composition root. Everything the hub is made of is constructed here, in dependency order, and
 * handed to the route layer as one `HubContext`.
 *
 * Two decisions are worth naming. First, every external dependency — the clock, randomness, fetch,
 * DNS, FFmpeg discovery, provider adapters — arrives through `HubDeps`, so tests build a real hub
 * with fake edges rather than mocking modules. Second, services never reach for each other through
 * imports: the wiring below (`attachSink`, `attachPresence`, `onChange`) is the only place the
 * graph is closed, which is what keeps the module dependency order acyclic.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { BRANDING } from '@now-playing/contracts';
import { DomainError, uuidv7 } from '@now-playing/domain';
import { registerAllRoutes } from './api/routes/index.js';
import { createRateLimiter } from './api/register.js';
import { installSecurity } from './api/security.js';
import { problem, PROBLEM_CONTENT_TYPE } from './api/problem.js';
import { AuditService } from './auth/audit.js';
import { DeviceAuthService } from './auth/device-auth.js';
import { AuthService } from './auth/service.js';
import { BackupService } from './backup/service.js';
import type { HubConfig } from './config.js';
import type { HubContext, HubIdentityState, LifecycleState } from './context.js';
import { createSealer, generateHubKeyPair, loadOrCreateInstallKey } from './crypto/index.js';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createRepositories } from './db/repositories/index.js';
import { systemClock, systemRandom, type FfmpegInfo, type HubDeps } from './deps.js';
import { DiscordService } from './discord/service-interface.js';
import { DownloadService } from './downloads/service.js';
import { CommandService } from './group/command-service.js';
import { GroupService } from './group/service.js';
import { JobScheduler } from './jobs/scheduler.js';
import { LibraryService } from './library/service.js';
import { MetricsRegistry } from './metrics/registry.js';
import { MetricsService } from './metrics/service.js';
import { NetworkService } from './network/service.js';
import { createHubLogging } from './observability/logger.js';
import { DeviceService } from './pairing/devices.js';
import { PairingService } from './pairing/service.js';
import { AccountsService } from './providers/accounts.js';
import { BandcampAdapter } from './providers/adapters/bandcamp.js';
import { ExternalToolAdapter } from './providers/adapters/external-tool.js';
import { CompanionLibraryAdapter, HubLibraryAdapter, PublicDomainAdapter } from './providers/adapters/local.js';
import { MusicBrainzAdapter } from './providers/adapters/musicbrainz.js';
import { SoundCloudAdapter } from './providers/adapters/soundcloud.js';
import { SpotifyAdapter } from './providers/adapters/spotify.js';
import { YouTubeAdapter } from './providers/adapters/youtube.js';
import { nodeDnsLookup, SafeHttpClient } from './providers/http.js';
import { PlatformSyncService } from './providers/platform-sync.js';
import { RateLimitManager } from './providers/rate-limit-manager.js';
import { RecommendationService } from './providers/recommendations.js';
import { ProviderRegistry } from './providers/registry.js';
import { SearchService } from './providers/search-service.js';
import { RealtimeServer } from './realtime/server.js';
import { ReleaseService } from './releases/service.js';
import { ShareService } from './shares/service.js';
import { FileStore } from './sync/files.js';
import { SyncService } from './sync/service.js';
import { TransferService } from './sync/transfers.js';
import { detectFfmpeg } from './media/ffmpeg.js';

const HUB_IDENTITY_KEY = 'hub.identity';

export interface HubApp {
  app: FastifyInstance;
  ctx: HubContext;
  /** Start background work and mark the hub ready. Split from construction so tests can control it. */
  start(): Promise<void>;
  close(): Promise<void>;
}

export async function buildApp(deps: HubDeps): Promise<HubApp> {
  const config: HubConfig = deps.config;
  const clock = deps.clock ?? systemClock;
  const random = deps.random ?? systemRandom;
  const version = deps.version ?? '0.1.0';
  const startedAt = deps.startedAt ?? clock.now();

  /* --------------------------------------------------------------- storage */

  const dbFile = config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'hub.sqlite');
  const db = openDatabase({ file: dbFile });
  const migration = migrate(db, {
    ...(deps.migrationsDir ? { migrationsDir: deps.migrationsDir } : {}),
    dbFile,
    ...(config.dataDir === ':memory:' ? {} : { backupDir: join(config.dataDir, 'backups') }),
    now: () => clock.now(),
  });
  const repos = createRepositories(db);

  /* -------------------------------------------------------------- identity */

  const installKey = loadOrCreateInstallKey(config.installKeyFile, random);
  const sealer = createSealer(installKey, random);
  const identity = loadOrCreateIdentity(repos, clock);

  /* ---------------------------------------------------- logging + metrics */

  const logging = createHubLogging({ level: config.logLevel, logDir: config.dataDir === ':memory:' ? null : join(config.dataDir, 'logs'), stdout: (deps.logDestination ?? 'stdout') === 'stdout' });
  const log = deps.logger ?? logging.logger;
  const metrics = new MetricsRegistry();
  const httpRateLimiter = createRateLimiter({ clock, deps });

  /* --------------------------------------------------------------- network */

  const network = new NetworkService(config, repos.settings, installKey, () => new Date(clock.now()).toISOString());
  const audit = new AuditService(repos.audit, network, clock, log, metrics);
  const auth = new AuthService(repos.admin, clock, random, audit, deps.passwordHashing);
  auth.ensureBootstrapAdmin();
  const deviceAuth = new DeviceAuthService(repos.devices, clock);

  /* ------------------------------------------------------------ outbound IO */

  const http = new SafeHttpClient({
    fetch: deps.fetch ?? globalThis.fetch,
    dnsLookup: deps.dnsLookup ?? nodeDnsLookup,
    userAgent: BRANDING.userAgent(version, repos.settings.get<string>('providers.contactEmail') ?? 'https://github.com/jyoung2000/AudioWave2.0'),
  });
  let ffmpegCache: FfmpegInfo | null = null;
  const ffmpeg = async (): Promise<FfmpegInfo> => {
    ffmpegCache ??= await (deps.ffmpegLocator ?? (() => detectFfmpeg(config.ffmpegPath)))();
    return ffmpegCache;
  };

  /* ------------------------------------------------------------- providers */

  const rateLimiter = new RateLimitManager(clock, metrics);
  const providers = new ProviderRegistry(repos.providers, sealer, rateLimiter, audit, clock, log);

  /* --------------------------------------------------------------- library */

  const library = new LibraryService(repos.library, config, identity.hubId, audit, metrics, clock, log);
  if (config.publicDomainDir && existsSync(config.publicDomainDir)) library.registerExternalRoot(config.publicDomainDir, 'Public domain fixtures', 'public-domain');

  /* ------------------------------------------------------- late-bound base URL */

  // The hub can be reached through several origins (localhost, a LAN address, a reverse proxy), so
  // adapters that build absolute URLs ask for the base at call time rather than capturing one.
  const baseUrlProvider = { baseUrl: (): string => network.reachableBaseUrl().url ?? `http://localhost:${config.port}` };

  providers.register(new HubLibraryAdapter(library, baseUrlProvider));
  providers.register(new PublicDomainAdapter(library, baseUrlProvider));
  providers.register(new CompanionLibraryAdapter(repos.sync, library, baseUrlProvider));
  const musicbrainz = new MusicBrainzAdapter(http, version);
  providers.register(musicbrainz);
  providers.register(new YouTubeAdapter(http));
  providers.register(new SoundCloudAdapter(http, clock));
  providers.register(new SpotifyAdapter(http, clock));
  providers.register(new BandcampAdapter((url) => musicbrainz.lookupUrl(url)));
  providers.register(new ExternalToolAdapter());
  for (const adapter of deps.extraAdapters ?? []) providers.register(adapter);
  for (const [id, adapter] of Object.entries(deps.replaceAdapters ?? {})) {
    void id;
    providers.register(adapter);
  }

  const search = new SearchService(providers, rateLimiter, repos.providers, clock, metrics);
  const accounts = new AccountsService(repos.providers, providers, rateLimiter, sealer, audit, metrics, clock);
  const recommendations = new RecommendationService(repos.canonical, repos.settings, library, metrics, clock, log);
  const platformSync = new PlatformSyncService(accounts, providers, rateLimiter, recommendations, repos.canonical, metrics, clock);

  /* ---------------------------------------------------------------- groups */

  const groups = new GroupService(repos.groups, repos.canonical, identity.hubId, audit, metrics, clock, { backgroundTimers: !deps.disableBackgroundJobs });
  groups.attachSyncGrader((track) => providers.syncGradeFor(track));
  const commands = new CommandService(groups, search, providers, clock, metrics);

  /* ------------------------------------------------------------- downloads */

  const downloads = new DownloadService(repos.downloads, repos.library, providers, rateLimiter, http, config, ffmpeg, audit, metrics, clock, random, log);
  const files = new FileStore(config, repos.library, repos.downloads, metrics, clock);
  const transfers = new TransferService(repos.downloads, repos.devices, files, audit, metrics, clock);

  /* ------------------------------------------------------------------ sync */

  const sync = new SyncService(repos.sync, audit, metrics, clock);
  const shares = new ShareService(repos.shares, library, repos.library, network, audit, metrics, clock, random, () => identity.name);

  /* --------------------------------------------------------------- devices */

  const devices = new DeviceService(repos.devices, repos.groups, repos.downloads, deviceAuth, audit, clock);
  const pairing = new PairingService(repos.pairing, repos.devices, devices, identity, network, audit, metrics, clock, random);

  /* --------------------------------------------------- late-bound services */

  const lifecycle: { state: LifecycleState; migrationVersion: number } = { state: 'starting', migrationVersion: migration.to };

  // Several services need the finished context. They receive a getter rather than the object so the
  // graph can be closed after every constructor has run.
  const ctxRef: { current: HubContext | null } = { current: null };
  const getCtx = (): HubContext => {
    if (!ctxRef.current) throw new DomainError('unavailable', 'The hub is still starting');
    return ctxRef.current;
  };

  const metricsService = new MetricsService(metrics, repos.metrics, clock, getCtx);
  const backup = new BackupService(db, dbFile, config, repos, audit, metrics, clock, migration.to);
  const releases = new ReleaseService(repos.settings, http, metrics, clock);
  const jobs = new JobScheduler(getCtx, clock, log, !deps.disableBackgroundJobs);
  const discord = new DiscordService(repos.settings, commands, sealer, http, config, audit, metrics, clock);

  const realtime = new RealtimeServer({ auth, deviceAuth, groups, devices, identity, clock, log, metrics, network, config, deps });
  groups.attachSink(realtime);
  groups.attachPresence(realtime);
  devices.attachPresence(realtime);
  downloads.attachSink((job) => realtime.notify('job.progress', job, { deviceId: job.ownerId }));
  transfers.onChange((job, deviceIds) => {
    for (const deviceId of deviceIds) realtime.notify('transfer.progress', job, { deviceId });
  });

  const ctx: HubContext = {
    deps,
    config,
    clock,
    random,
    fetch: deps.fetch ?? globalThis.fetch,
    dnsLookup: deps.dnsLookup ?? nodeDnsLookup,
    version,
    startedAt,
    db,
    dbFile,
    repos,
    installKey,
    sealer,
    identity,
    logging,
    log,
    metrics,
    httpRateLimiter,
    lifecycle,
    ffmpeg,
    network,
    audit,
    auth,
    deviceAuth,
    pairing,
    devices,
    groups,
    realtime,
    commands,
    providers,
    search,
    rateLimiter,
    accounts,
    recommendations,
    platformSync,
    downloads,
    library,
    sync,
    files,
    transfers,
    shares,
    metricsService,
    backup,
    releases,
    jobs,
    discord,
  };
  ctxRef.current = ctx;

  /* ------------------------------------------------------------------ HTTP */

  const app = Fastify({
    logger: false,
    trustProxy: config.trustedProxyCidrs.length > 0,
    genReqId: () => randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
    // `logger: false` already silences Fastify's own request logging; the hub logs requests itself
    // in `installSecurity` with the fields it wants (correlation id, operation, redacted path).
  });

  // Raw bodies for the two routes that carry bytes rather than JSON.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  installSecurity(app, ctx);
  registerAllRoutes(app, ctx);
  await registerStatic(app, ctx, deps);

  app.setErrorHandler((raw: unknown, req, reply) => {
    const err = raw instanceof Error ? raw : new Error(String(raw));
    const status = typeof (raw as { statusCode?: number }).statusCode === 'number' ? (raw as { statusCode: number }).statusCode : 500;
    if (status >= 500) log.error({ module: 'http', correlationId: req.id, err: err.message, stack: err.stack }, 'unhandled error');
    reply
      .status(status)
      .type(PROBLEM_CONTENT_TYPE)
      // A 500 never leaks an internal message to the caller; the correlation id ties it to the log.
      .send(problem(status, { detail: status >= 500 ? 'Something went wrong on the hub. The correlation id identifies this request in the logs.' : err.message, correlationId: req.id }));
  });

  metricsService.restore();
  downloads.recover();
  groups.restoreTimers();
  jobs.registerDefaults();
  jobs.registerDefaultHandlers();

  return {
    app,
    ctx,
    async start(): Promise<void> {
      await app.ready();
      realtime.attach(app.server);
      jobs.start();
      lifecycle.state = 'ok';
      log.info({ module: 'hub', version, migrationVersion: migration.to, bindMode: network.current.bindMode, setupComplete: auth.setupComplete() }, 'hub ready');
    },
    async close(): Promise<void> {
      lifecycle.state = 'stopping';
      jobs.stop();
      realtime.close();
      groups.dispose();
      await downloads.stop();
      await app.close();
      try {
        db.close();
      } catch {
        /* already closed by a restore */
      }
    },
  };
}

/** The hub's stable identity: generated once, then read from settings on every later start. */
function loadOrCreateIdentity(repos: ReturnType<typeof createRepositories>, clock: { now(): number }): HubIdentityState {
  const stored = repos.settings.get<HubIdentityState>(HUB_IDENTITY_KEY);
  if (stored?.privateKeyPem) return stored;
  const keys = generateHubKeyPair();
  const state: HubIdentityState = {
    hubId: uuidv7(clock.now()),
    name: BRANDING.products.hub,
    publicKey: keys.publicKey,
    privateKeyPem: keys.privateKeyPem,
    fingerprint: fingerprintOf(keys.publicKey),
  };
  repos.settings.set(HUB_IDENTITY_KEY, state, new Date(clock.now()).toISOString());
  return state;
}

function fingerprintOf(publicKey: string): string {
  // Grouped hex of a SHA-256 over the raw key: short enough for two people to read aloud and
  // compare during pairing.
  const hash = createHash('sha256').update(publicKey).digest('hex');
  return (hash.match(/.{4}/g) ?? []).slice(0, 8).join('-').toUpperCase();
}

/** Serve the built admin GUI when it exists; a source checkout without a build still runs the API. */
async function registerStatic(app: FastifyInstance, ctx: HubContext, deps: HubDeps): Promise<void> {
  const notFound = (req: { method: string; url: string; id: string }, reply: { status(code: number): { type(t: string): { send(body: unknown): unknown } } }): unknown =>
    reply.status(404).type(PROBLEM_CONTENT_TYPE).send(problem(404, { detail: `No route matches ${req.method} ${req.url.split('?')[0]}`, correlationId: req.id }));
  void notFound;
  const dir = deps.webDistDir ?? join(new URL('.', import.meta.url).pathname, 'web');
  if (!existsSync(dir)) {
    ctx.log.info({ module: 'hub', dir }, 'admin GUI bundle not found; serving the API only');
    return;
  }
  const staticPlugin = (await import('@fastify/static')).default;
  await app.register(staticPlugin, { root: dir, prefix: '/', index: ['index.html'], wildcard: false, cacheControl: true, maxAge: '1h' });
  // Client-side routing: any non-API path that is not a file falls through to the shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/s/') && !req.raw.headers.accept?.includes('application/json')) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).type(PROBLEM_CONTENT_TYPE).send(problem(404, { detail: `No route matches ${req.method} ${req.url.split('?')[0]}`, correlationId: req.id }));
  });
}
