/**
 * Discord worker process.
 *
 * Runs in its own container (`docker compose --profile discord up -d`) so a gateway outage, a bad
 * token or a crashed websocket cannot take the hub's HTTP API down with it. It shares the data
 * volume, so it reads the same database, the same configuration and the same sealed token — there
 * is no second copy of any state.
 *
 * It builds the hub's services but never listens on a port: no routes are served from this process.
 */
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { backoffMs, sleep } from '../util.js';
import { DiscordGatewayClient } from './gateway.js';

const POLL_INTERVAL_MS = 15_000;
const MAX_ATTEMPTS = 8;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const hub = await buildApp({ config, version: process.env['NP_VERSION'] ?? '0.1.0' });
  const { ctx } = hub;
  const log = ctx.log.child({ module: 'discord-worker' });

  const gateway = new DiscordGatewayClient(ctx.discord, ctx.clock, ctx.metrics, log);
  ctx.discord.attachGateway(gateway);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    void gateway
      .stop()
      .then(() => hub.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  let attempt = 0;
  let running = false;

  // The worker starts before an operator has necessarily configured anything, so it polls rather
  // than exiting: enabling the bot in the admin GUI brings it up without restarting the container.
  while (!stopping) {
    const configuration = ctx.discord.configuration();
    const token = ctx.discord.token();
    const shouldRun = configuration.enabled && token !== null;

    if (shouldRun && !running) {
      try {
        await gateway.start(token, configuration);
        await gateway.registerCommands().catch((err: unknown) => {
          // Failing to register commands is not fatal: the bot still answers prefix commands, and
          // the operator can retry from Admin → Discord.
          log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not register slash commands');
        });
        running = true;
        attempt = 0;
        log.info({ guilds: configuration.guildAllowlist.length }, 'discord bot running');
      } catch (err) {
        attempt += 1;
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ attempt, err: message }, 'could not start the discord bot');
        if (message.includes('rejected the bot token') || attempt >= MAX_ATTEMPTS) {
          // Stop trying, but keep the process alive: a corrected token in the GUI resumes it.
          log.error({ attempt }, 'giving up until the configuration changes');
          attempt = 0;
          await sleep(POLL_INTERVAL_MS * 4);
          continue;
        }
        await sleep(backoffMs(attempt, 2_000, 60_000));
        continue;
      }
    }

    if (!shouldRun && running) {
      log.info('discord bot disabled; disconnecting');
      await gateway.stop();
      running = false;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Discord worker failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
