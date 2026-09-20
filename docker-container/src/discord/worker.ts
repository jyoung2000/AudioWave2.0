/**
 * Discord worker process.
 *
 * Runs in its own container (`docker compose --profile discord up -d`) so a gateway outage, a bad
 * token or a crashed websocket cannot take the hub's HTTP API down with it. It shares the data
 * volume, so it reads the same database, the same configuration and the same sealed token — there
 * is no second copy of any state.
 *
 * It builds the hub's services but never listens on a port. The shared database is also how the two
 * processes talk: the worker publishes a status heartbeat the admin GUI reads, and picks up the
 * GUI's start/stop/reconnect requests (see `DiscordService.requestFromWorker`).
 */
import type { QueueItem } from '@now-playing/contracts';
import type { Logger } from 'pino';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import type { HubContext } from '../context.js';
import { backoffMs, sleep } from '../util.js';
import { DiscordGatewayClient } from './gateway.js';
import type { ControlRequest } from './service-interface.js';
import { VoicePlayer, type ResolvedInput, type VoiceHost } from './voice.js';

const LOOP_INTERVAL_MS = 2_000;
const VOICE_SYNC_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 8;
const SYSTEM_ACTOR = { id: 'system', kind: 'system' as const, displayName: 'Hub', isHubAdmin: true };

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const hub = await buildApp({ config, version: process.env['NP_VERSION'] ?? '0.1.0', processRole: 'discord-worker' });
  const { ctx } = hub;
  const log = ctx.log.child({ module: 'discord-worker' });
  const startedAt = Date.now();

  const voice = new VoicePlayer(createVoiceHost(ctx, log), log);
  const gateway = new DiscordGatewayClient(ctx.discord, ctx.clock, ctx.metrics, log, voice);
  ctx.discord.attachGateway(gateway);

  const ffmpeg = await ctx.ffmpeg();
  if (!ffmpeg.available) log.error('FFmpeg was not found: the bot can answer commands but cannot play audio. Install it or set NP_FFMPEG_PATH.');
  else log.info({ ffmpeg: ffmpeg.version, opus: ffmpeg.encoders.includes('libopus') }, 'audio pipeline ready');

  const publishStatus = (): void => {
    try {
      ctx.discord.publishWorkerStatus(gateway.status());
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not publish status');
    }
  };
  const timers = [setInterval(() => void voice.sync(), VOICE_SYNC_INTERVAL_MS), setInterval(publishStatus, HEARTBEAT_INTERVAL_MS)];

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    for (const t of timers) clearInterval(t);
    voice.destroy();
    void gateway
      .stop()
      .then(() => publishStatus())
      .then(() => hub.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  let attempt = 0;
  let running = false;
  let retryAt = 0;
  // An operator's Stop (or a rejected token) holds until they press Start or change the configuration.
  let heldAtConfig: string | null = null;
  let handledRequest: string | null = null;

  const startGateway = async (): Promise<void> => {
    const token = ctx.discord.token();
    if (!token) throw new Error('No bot token is installed');
    await gateway.start(token, ctx.discord.configuration());
    await gateway.registerCommands().catch((err: unknown) => {
      // Not fatal: prefix commands still work, and the operator can retry from Admin → Discord.
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not register slash commands');
    });
    running = true;
    attempt = 0;
  };

  const handleControl = async (request: ControlRequest): Promise<void> => {
    log.info({ action: request.action }, 'admin request');
    switch (request.action) {
      case 'start':
        heldAtConfig = null;
        retryAt = 0;
        if (!running) await startGateway();
        return;
      case 'stop':
        heldAtConfig = ctx.discord.configuration().updatedAt;
        await gateway.stop();
        running = false;
        return;
      case 'reconnect':
        heldAtConfig = null;
        if (running) await gateway.reconnect();
        else await startGateway();
        return;
      case 'register-commands':
        await gateway.registerCommands();
        return;
    }
  };

  // The worker starts before an operator has necessarily configured anything, so it polls rather
  // than exiting: enabling the bot in the admin GUI brings it up without restarting the container.
  while (!stopping) {
    const request = ctx.discord.pendingControlRequest(handledRequest, startedAt);
    if (request) {
      handledRequest = request.id;
      const error = await handleControl(request).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      ctx.discord.completeControlRequest(request.id, error);
      publishStatus();
    }

    const configuration = ctx.discord.configuration();
    if (heldAtConfig !== null && configuration.updatedAt !== heldAtConfig) heldAtConfig = null;
    const shouldRun = configuration.enabled && ctx.discord.token() !== null && heldAtConfig === null;

    if (shouldRun && !running && Date.now() >= retryAt) {
      try {
        await startGateway();
        log.info({ guilds: configuration.guildAllowlist.length }, 'discord bot running');
      } catch (err) {
        attempt += 1;
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ attempt, err: message }, 'could not start the discord bot');
        // A rejected token will not fix itself; wait for a new configuration instead of hammering Discord.
        if (message.includes('rejected the bot token') || attempt >= MAX_ATTEMPTS) {
          log.error({ attempt }, 'giving up until the configuration changes');
          heldAtConfig = configuration.updatedAt;
          attempt = 0;
        } else {
          retryAt = Date.now() + backoffMs(attempt, 2_000, 60_000);
        }
      }
      publishStatus();
    }

    if (!shouldRun && running) {
      log.info('discord bot disabled; disconnecting');
      await gateway.stop();
      running = false;
      publishStatus();
    }

    await sleep(LOOP_INTERVAL_MS);
  }
}

/** How the voice player reaches the hub's queue and media, in this process. */
function createVoiceHost(ctx: HubContext, log: Logger): VoiceHost {
  return {
    groupId: () => ctx.discord.configuration().defaultGroupId,
    state: (groupId) => ctx.groups.state(groupId),
    now: () => ctx.clock.now(),
    ffmpeg: () => ctx.ffmpeg(),
    idleDisconnectMs: () => ctx.discord.configuration().idleDisconnectSeconds * 1000,
    resolve: (item) => resolveMedia(ctx, item),
    advance(groupId, itemId, reason) {
      try {
        const { queue, playback } = ctx.groups.state(groupId);
        if (playback.currentItemId !== itemId) return;
        // Same key as the hub's end-of-track timer, so the two can never advance twice.
        ctx.groups.applyCommand(groupId, SYSTEM_ACTOR, { idempotencyKey: `ended:${groupId}:${queue.revision}`, baseRevision: queue.revision, command: { type: 'advance', reason } });
      } catch (err) {
        log.warn({ groupId, err: err instanceof Error ? err.message : String(err) }, 'could not advance the queue');
      }
    },
  };
}

/**
 * Find bytes the bot may play for a queue item. Hub-hosted files are read straight from the data
 * volume (a queue item's locators come from clients, so the track is always looked up again here);
 * anything else must be a server-side stream its provider allows in Discord.
 */
async function resolveMedia(ctx: HubContext, item: QueueItem): Promise<ResolvedInput> {
  const track = item.track;
  const hubCopy = ctx.library.findTrack(track.trackId) ?? (track.identity.contentHash ? ctx.library.findByHash(track.identity.contentHash) : undefined);
  if (hubCopy) {
    const path = ctx.library.absolutePath(hubCopy);
    return path ? { ok: true, input: { kind: 'file', path } } : { ok: false, reason: 'its file is missing from the hub library' };
  }
  if (!ctx.providers.has(track.provider)) return { ok: false, reason: 'it only exists on a device, not on the hub' };
  const descriptor = ctx.providers.descriptor(track.provider);
  if (!ctx.providers.isEnabled(track.provider)) return { ok: false, reason: `${descriptor.displayName} is turned off on this hub` };
  if (!descriptor.discordCompatible) return { ok: false, reason: `${descriptor.displayName} cannot be played in a Discord voice channel` };
  const providerId = track.identity.providerIds[track.provider]?.[0] ?? track.trackId;
  const playable = await ctx.providers
    .get(track.provider)
    .getPlayable(providerId, { actorId: 'discord', forGroup: true })
    .catch(() => null);
  if (playable?.kind === 'remote-stream' && /^https:\/\//i.test(playable.url)) return { ok: true, input: { kind: 'url', url: playable.url } };
  if (playable?.kind === 'embed' || playable?.kind === 'open-at-source') return { ok: false, reason: `${descriptor.displayName} only plays in its own player` };
  return { ok: false, reason: `${descriptor.displayName} has no stream the hub can play` };
}

main().catch((err: unknown) => {
  process.stderr.write(`Discord worker failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
