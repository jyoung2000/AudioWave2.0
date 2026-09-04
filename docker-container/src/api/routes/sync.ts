/**
 * Companion sync, the content-addressed file store and device-to-device transfers.
 *
 * Two things distinguish these routes from the rest of the API. They deal in raw bytes, so the body
 * parser is bypassed and size caps are explicit. And they are the only place a device can cause the
 * hub to store a file, so every write is bounded by a declared total, verified against its content
 * hash, and readable afterwards only by a device a transfer job actually names.
 */
import type { FastifyInstance } from 'fastify';
import { routes } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import type { HubContext } from '../../context.js';
import { actorDisplayName, actorId, type Principal } from '../../auth/principal.js';
import { RAW, registerRoute } from '../register.js';

/** 8 MiB per chunk: large enough to be efficient, small enough that a retry is cheap. */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

function deviceIdOf(principal: Principal): string {
  if (principal.kind !== 'device') throw new DomainError('unauthenticated', 'Device credential required');
  return principal.deviceId;
}

export function registerSyncRoutes(app: FastifyInstance, ctx: HubContext): void {
  registerRoute(app, ctx, routes.syncManifest, async ({ body, principal }) => {
    const deviceId = deviceIdOf(principal);
    const result = await ctx.sync.exchangeManifest(deviceId, body);
    return { serverManifest: result.serverManifest, needed: result.needed };
  });

  registerRoute(app, ctx, routes.syncDelta, ({ body, principal }) => ctx.sync.delta(deviceIdOf(principal), body));

  registerRoute(app, ctx, routes.syncStatus, ({ principal }) => ctx.sync.status(deviceIdOf(principal)));

  /* ------------------------------------------------------------------ files */

  registerRoute(app, ctx, routes.filesHead, ({ params, principal, reply }) => {
    const deviceId = deviceIdOf(principal);
    const auth = ctx.files.authorizeRead(params.contentHash, deviceId, false);
    const status = ctx.files.status(params.contentHash);
    // HEAD answers for an unauthorized hash too, but only with "nothing here": otherwise the
    // response would confirm the hub holds a file the caller has no claim to.
    reply
      .status(status.complete && auth.allowed ? 200 : 404)
      .header('Accept-Ranges', 'bytes')
      .header('X-Received-Bytes', String(auth.allowed ? status.receivedBytes : 0))
      .header('Content-Length', String(status.complete && auth.allowed ? (status.completeBytes ?? 0) : 0))
      .send();
    return RAW;
  });

  registerRoute(
    app,
    ctx,
    routes.filesPut,
    async ({ params, query, req, principal }) => {
      deviceIdOf(principal);
      const body = req.body;
      const chunk = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body, 'binary') : null;
      if (!chunk) throw new DomainError('validation', 'Send the chunk as application/octet-stream');
      if (chunk.byteLength > MAX_CHUNK_BYTES) throw new DomainError('validation', `A chunk may be at most ${MAX_CHUNK_BYTES} bytes`);
      const result = await ctx.files.putChunk(params.contentHash, query.offset, query.total, chunk);
      ctx.transfers.recordUpload(params.contentHash, result.receivedBytes, result.complete);
      return result;
    },
    { bodyLimit: MAX_CHUNK_BYTES + 1024 },
  );

  registerRoute(app, ctx, routes.filesGet, ({ params, principal, req, reply }) => {
    const deviceId = deviceIdOf(principal);
    const auth = ctx.files.authorizeRead(params.contentHash, deviceId, false);
    if (!auth.allowed) throw new DomainError('not-found', auth.reason ?? 'No such file');
    const handle = ctx.files.openRead(params.contentHash, req.headers.range);
    reply
      .status(handle.partial ? 206 : 200)
      .header('Content-Type', 'application/octet-stream')
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', String(handle.end - handle.start + 1))
      .header('ETag', `"${params.contentHash}"`);
    if (handle.partial) reply.header('Content-Range', `bytes ${handle.start}-${handle.end}/${handle.size}`);
    reply.send(handle.stream);
    return RAW;
  });

  /* -------------------------------------------------------------- transfers */

  registerRoute(app, ctx, routes.transfersList, ({ principal }) => ({ items: ctx.transfers.list(principal.kind === 'admin' ? undefined : actorId(principal)) }));

  registerRoute(app, ctx, routes.transfersCreate, ({ body, principal, ip, userAgent, correlationId, reply }) => {
    const job = ctx.transfers.create(
      { fromDeviceId: deviceIdOf(principal), toDeviceId: body.toDeviceId, contentHash: body.contentHash, sizeBytes: body.sizeBytes, trackId: body.trackId, policy: body.policy },
      { ip, userAgent, correlationId },
      actorDisplayName(principal),
    );
    reply.status(201);
    return job;
  });

  registerRoute(app, ctx, routes.transfersAction, ({ params, principal, ip, userAgent, correlationId }) =>
    ctx.transfers.act(params.jobId, params.action, principal.kind === 'device' ? principal.deviceId : null, principal.kind === 'admin', { ip, userAgent, correlationId }, actorDisplayName(principal)),
  );
}
