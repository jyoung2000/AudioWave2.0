/**
 * Process entry point.
 *
 * The bind address is chosen by policy, not by configuration alone: until the admin password has
 * been changed the hub binds to loopback regardless of `NP_BIND_MODE`, so a container started with
 * remote access enabled cannot be reachable while `admin/admin` still works (docs/SECURITY.md).
 *
 * Shutdown drains in order — stop accepting, stop background work, close sockets, checkpoint the
 * database — and is bounded, so an orchestrator's SIGTERM is honoured even if something hangs.
 */
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { checkpoint } from './db/connection.js';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const version = process.env['NP_VERSION'] ?? '0.1.0';
  const hub = await buildApp({ config, version });
  const { ctx, app } = hub;

  const host = ctx.network.bindAddressFor(ctx.auth.setupComplete());
  await hub.start();
  await app.listen({ host, port: config.port });

  const reachable = ctx.network.reachableBaseUrl();
  ctx.log.info(
    { module: 'hub', host, port: config.port, bindMode: ctx.network.current.bindMode, setupComplete: ctx.auth.setupComplete(), url: reachable.url },
    ctx.auth.setupComplete() ? 'listening' : 'listening on loopback only until the admin password is changed',
  );
  if (!ctx.auth.setupComplete()) {
    // Printed rather than logged at debug: a first-run operator needs to see this.
    ctx.log.warn({ module: 'hub' }, `Open http://localhost:${config.port} and sign in with admin / admin. You will be asked to set a real password before anything else is enabled.`);
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.log.info({ module: 'hub', signal }, 'shutting down');
    const timer = setTimeout(() => {
      ctx.log.warn({ module: 'hub' }, 'shutdown did not finish in time; exiting anyway');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    void hub
      .close()
      .then(() => {
        checkpoint(ctx.db);
        clearTimeout(timer);
        process.exit(0);
      })
      .catch((err: unknown) => {
        ctx.log.error({ module: 'hub', err: err instanceof Error ? err.message : String(err) }, 'shutdown failed');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    ctx.log.error({ module: 'hub', err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    ctx.log.error({ module: 'hub', err: err.message, stack: err.stack }, 'uncaught exception');
    shutdown('uncaughtException');
  });
}

main().catch((err: unknown) => {
  // Nothing is constructed yet, so there is no logger: write plainly and exit non-zero.
  process.stderr.write(`Now Playing hub failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
