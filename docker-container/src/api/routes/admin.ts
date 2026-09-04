/**
 * Operator-facing routes: metrics, network, logs, diagnostics, backup, updates and the Discord bot.
 *
 * The diagnostics bundle is the sensitive one. It exists so an operator can hand a support file to
 * someone else, which means it must be safe to hand over: it names every redaction it performed,
 * carries no tokens, no full IP addresses, no raw listening history, no audio and no user
 * filesystem paths. What it does carry is versions, counters, capability state and health.
 */
import type { FastifyInstance } from 'fastify';
import { CONTRACTS_VERSION, routes, SCHEMA_VERSIONS, WS_MIN_SUPPORTED_PROTOCOL_VERSION, WS_PROTOCOL_VERSION } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import type { HubContext } from '../../context.js';
import { actorDisplayName, actorId } from '../../auth/principal.js';
import { registerRoute } from '../register.js';

const REDACTIONS = [
  'Provider client secrets and API keys (never stored in plaintext, never included)',
  'OAuth access and refresh tokens for every connected account',
  'The Discord bot token',
  'Device credential secrets and their hashes',
  'Pairing codes and claim secrets',
  'Admin password hashes and session identifiers',
  'Full IP addresses (only the configured privacy form appears)',
  'Raw listening history and any per-track play record',
  'Filesystem paths outside the hub data volume',
  'Share link tokens (only their hints)',
];

export function registerAdminRoutes(app: FastifyInstance, ctx: HubContext): void {
  /* --------------------------------------------------------------- metrics */

  registerRoute(app, ctx, routes.metricsOverview, () => ctx.metricsService.overview() as never);
  registerRoute(app, ctx, routes.metricsConnections, () => ctx.metricsService.connections() as never);
  registerRoute(app, ctx, routes.metricsRaw, () => ctx.metricsService.raw());

  /* --------------------------------------------------------------- network */

  registerRoute(app, ctx, routes.networkGet, () => ctx.network.toConfig());

  registerRoute(app, ctx, routes.networkPut, ({ body, principal, ip, userAgent, correlationId }) => {
    // Binding beyond loopback is exactly the change that must not be possible while the default
    // password is still in place.
    if (!ctx.auth.setupComplete() && body.bindMode && body.bindMode !== 'localhost') {
      throw new DomainError('setup-required', 'Change the admin password before exposing this hub beyond localhost');
    }
    const next = ctx.network.update({
      ...(body.bindMode !== undefined ? { bindMode: body.bindMode } : {}),
      ...(body.publicEndpoint !== undefined ? { publicEndpoint: body.publicEndpoint } : {}),
      ...(body.trustedProxyCidrs !== undefined ? { trustedProxyCidrs: body.trustedProxyCidrs } : {}),
      ...(body.ipLogging !== undefined ? { ipLogging: body.ipLogging } : {}),
    });
    ctx.audit.record({
      actor: { kind: 'admin', id: actorId(principal), displayName: actorDisplayName(principal) },
      action: 'network.update',
      outcome: 'success',
      target: { kind: 'network', id: 'config' },
      ip,
      correlationId,
      details: { bindMode: next.bindMode, publicEndpoint: next.publicEndpoint ? 'set' : 'none' },
    });
    void userAgent;
    return next;
  });

  /* ----------------------------------------------------------- diagnostics */

  registerRoute(app, ctx, routes.logsList, ({ query }) => {
    const order: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
    const min = order[query.level] ?? 20;
    const items = ctx.logging.ring
      .toArray()
      .filter((line) => (order[line.level] ?? 20) >= min)
      .filter((line) => !query.since || line.time >= query.since)
      .slice(-query.limit);
    return { items };
  });

  registerRoute(app, ctx, routes.diagnosticsBundle, async () => {
    const overview = await ctx.metricsService.overview();
    const ffmpeg = await ctx.ffmpeg();
    return {
      schemaVersion: SCHEMA_VERSIONS.diagnosticsBundle,
      generatedAt: new Date(ctx.clock.now()).toISOString(),
      redactions: REDACTIONS,
      sections: {
        versions: { hub: ctx.version, contracts: CONTRACTS_VERSION, protocol: WS_PROTOCOL_VERSION, minProtocol: WS_MIN_SUPPORTED_PROTOCOL_VERSION, node: process.version, platform: `${process.platform}/${process.arch}` },
        // The bind mode and whether an endpoint is set, never the endpoint itself: that is an
        // address someone could try to reach.
        network: { bindMode: ctx.network.current.bindMode, publicEndpointConfigured: ctx.network.current.publicEndpoint !== null, ipLoggingMode: ctx.network.current.ipLogging.mode, trustedProxyCount: ctx.network.current.trustedProxyCidrs.length },
        setup: { complete: ctx.auth.setupComplete() },
        database: overview.database,
        storage: { dataDirConfigured: true, freeBytes: overview.storage.freeBytes, totalBytes: overview.storage.totalBytes },
        providers: overview.providers,
        capabilities: ctx.providers.descriptors().map((d) => ({ provider: d.provider, enabled: d.enabled, configured: d.configured, capabilities: d.capabilities })),
        connections: overview.connections,
        jobs: { ...overview.jobs, tasks: ctx.jobs.status(), discovery: ctx.jobs.jobCounts() },
        sync: ctx.sync.counts(),
        discord: ctx.discord.status(),
        ffmpeg: { available: ffmpeg.available, version: ffmpeg.version, encoderCount: ffmpeg.encoders.length },
        counters: ctx.metrics.snapshotCounters(),
        histograms: ctx.metrics.snapshotHistograms(),
        alerts: overview.alerts,
        recentErrors: ctx.logging.ring.toArray().filter((l) => l.level === 'error').slice(-50).map((l) => ({ time: l.time, msg: l.msg, module: l.module })),
      },
    };
  });

  /* ---------------------------------------------------------------- backup */

  registerRoute(app, ctx, routes.backupCreate, async ({ principal, ip, userAgent, correlationId, reply }) => {
    const entry = await ctx.backup.create({ id: actorId(principal), displayName: actorDisplayName(principal) }, { ip, userAgent, correlationId });
    reply.status(201);
    return entry;
  });

  registerRoute(app, ctx, routes.backupList, () => ({ items: ctx.backup.list() }));

  registerRoute(app, ctx, routes.backupRestore, async ({ params, principal, ip, userAgent, correlationId }) =>
    ctx.backup.restore(params.backupId, { id: actorId(principal), displayName: actorDisplayName(principal) }, { ip, userAgent, correlationId }),
  );

  registerRoute(app, ctx, routes.exportAll, () => ctx.backup.exportAll());

  registerRoute(app, ctx, routes.importAll, ({ body, query, principal, ip, userAgent, correlationId }) =>
    ctx.backup.importAll(body, query.dryRun, { id: actorId(principal), displayName: actorDisplayName(principal) }, { ip, userAgent, correlationId }),
  );

  /* --------------------------------------------------------------- updates */

  registerRoute(app, ctx, routes.updatesGet, () => ({
    currentVersion: ctx.version,
    contractsVersion: CONTRACTS_VERSION,
    protocolVersion: WS_PROTOCOL_VERSION,
    minSupportedProtocolVersion: WS_MIN_SUPPORTED_PROTOCOL_VERSION,
    migrationVersion: ctx.lifecycle.migrationVersion,
    compatibility: ctx.releases.compatibility(ctx.version, CONTRACTS_VERSION, WS_PROTOCOL_VERSION),
    companionRelease: ctx.releases.latest(),
  }));

  registerRoute(app, ctx, routes.releasesWindowsLatest, () => {
    const release = ctx.releases.latest();
    // 404 rather than an empty object: the PWA renders a download link only when this succeeds,
    // so an unconfigured hub must not produce a button that goes nowhere.
    if (!release) throw new DomainError('not-found', 'No Windows companion release is configured on this hub');
    return release;
  });

  registerRoute(app, ctx, routes.releasesWindowsPut, async ({ body }) => {
    const state = await ctx.releases.configure({ feedUrl: body.feedUrl, metadata: body.metadata });
    return { feedUrl: state.feedUrl, metadata: state.metadata, lastFetchedAt: state.lastFetchedAt, lastError: state.lastError };
  });

  /* --------------------------------------------------------------- discord */

  registerRoute(app, ctx, routes.discordConfigGet, () => ctx.discord.configuration());

  registerRoute(app, ctx, routes.discordConfigPut, ({ body, principal, ip, userAgent, correlationId }) =>
    ctx.discord.updateConfiguration(body as Parameters<typeof ctx.discord.updateConfiguration>[0], { id: actorId(principal), displayName: actorDisplayName(principal) }, { ip, userAgent, correlationId }),
  );

  registerRoute(app, ctx, routes.discordTokenSet, ({ body, principal, ip, userAgent, correlationId }) =>
    ctx.discord.setToken(body.token, { id: actorId(principal), displayName: actorDisplayName(principal) }, { ip, userAgent, correlationId }),
  );

  registerRoute(app, ctx, routes.discordTokenClear, ({ principal, ip, userAgent, correlationId }) => {
    ctx.discord.clearToken({ id: actorId(principal), displayName: actorDisplayName(principal) }, { ip, userAgent, correlationId });
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.discordAction, ({ params, principal, ip, userAgent, correlationId }) =>
    ctx.discord.act(params.action, { id: actorId(principal), displayName: actorDisplayName(principal) }, { ip, userAgent, correlationId }),
  );

  registerRoute(app, ctx, routes.discordStatus, () => ctx.discord.status());

  registerRoute(app, ctx, routes.discordInviteUrl, () => ctx.discord.inviteUrl());

  registerRoute(app, ctx, routes.discordTemplatesGet, () => ctx.discord.templates());

  registerRoute(app, ctx, routes.discordTemplatesPut, ({ body, principal, ip, userAgent, correlationId }) =>
    ctx.discord.saveTemplates(body, { id: actorId(principal), displayName: actorDisplayName(principal) }, { ip, userAgent, correlationId }),
  );

  registerRoute(app, ctx, routes.discordTemplatesPreview, ({ body }) => ctx.discord.previewTemplate(body.key, body.template, body.sample));

  registerRoute(app, ctx, routes.discordTemplatesReset, () => ctx.discord.resetTemplates());

  registerRoute(app, ctx, routes.discordCommandTest, ({ body }) =>
    ctx.discord.runCommand({ command: body.command, args: body.args, guildId: body.guildId, channelId: body.channelId, userId: body.userId, roleIds: body.roleIds, transport: body.transport }),
  );
}
