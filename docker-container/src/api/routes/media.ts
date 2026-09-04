/**
 * Recommendations, downloads and the hub-hosted library.
 *
 * The download routes are where the project's legal posture becomes code: creating a job requires
 * naming an authorization basis, and the adapter must independently agree that basis applies. A
 * stream URL is never treated as a download source (docs/DOWNLOADS_AND_LEGAL.md), and
 * `GET /downloads/formats` reports what the *installed* FFmpeg can actually encode rather than a
 * hard-coded list, so the UI never offers a format that would fail.
 */
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { routes } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import type { HubContext } from '../../context.js';
import { actorDisplayName, actorId, type Principal } from '../../auth/principal.js';
import { RAW, registerRoute } from '../register.js';

/** Personalization is per hub user; a device without one has not finished pairing. */
function userIdOf(ctx: HubContext, principal: Principal): string {
  if (principal.kind !== 'device') throw new DomainError('unauthenticated', 'Device credential required');
  const user = ctx.devices.userFor(principal.deviceId);
  if (!user) throw new DomainError('not-found', 'This device has no hub user; re-pair it');
  return user.id;
}

export function registerMediaRoutes(app: FastifyInstance, ctx: HubContext): void {
  /* ------------------------------------------------------- recommendations */

  registerRoute(app, ctx, routes.eventsIngest, ({ body, principal }) => {
    const userId = userIdOf(ctx, principal);
    // Events are append-only and deduplicated by id, so a retried upload is free.
    return ctx.recommendations.ingestEvents(userId, body.events);
  });

  registerRoute(app, ctx, routes.recommendationsGet, ({ query, principal }) => {
    const userId = userIdOf(ctx, principal);
    return ctx.recommendations.serve({
      userId,
      mode: query.mode,
      contextId: query.contextId ?? null,
      ...(query.seeds ? { seeds: query.seeds.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      limit: query.limit,
      exploration: query.exploration,
    });
  });

  registerRoute(app, ctx, routes.recommendationsFeedback, ({ params, body, principal }) => {
    const userId = userIdOf(ctx, principal);
    ctx.recommendations.recordFeedback(userId, params.recommendationId, body.feedback, null);
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.recommendationsSeeds, ({ body, principal }) => {
    const userId = userIdOf(ctx, principal);
    ctx.recommendations.applySeeds(userId, { artists: body.artists, genres: body.genres, likedTrackIds: body.likedTrackIds });
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.recommendationsProfile, ({ principal }) => ctx.recommendations.view(userIdOf(ctx, principal)));

  registerRoute(app, ctx, routes.recommendationsConfigGet, () => ctx.recommendations.config() as unknown as Record<string, unknown>);

  registerRoute(app, ctx, routes.recommendationsConfigPut, ({ body }) => ctx.recommendations.setConfig(body) as unknown as Record<string, unknown>);

  /* -------------------------------------------------------------- downloads */

  registerRoute(app, ctx, routes.downloadsList, ({ principal }) => ({ items: ctx.downloads.list(principal.kind === 'admin' ? undefined : actorId(principal)) }));

  registerRoute(app, ctx, routes.downloadsCreate, async ({ body, principal, ip, correlationId, reply }) => {
    const job = await ctx.downloads.create(
      {
        source: body.source,
        authorization: { basis: body.authorization.basis, evidence: body.authorization.evidence, acknowledged: true },
        target: { destination: body.target.destination, directoryId: body.target.directoryId, filenameTemplate: body.target.filenameTemplate, format: body.target.format, quality: body.target.quality },
        ownerId: actorId(principal),
      },
      { ip, correlationId },
      actorDisplayName(principal),
    );
    reply.status(201);
    return job;
  });

  registerRoute(app, ctx, routes.downloadsAction, ({ params, principal }) => ctx.downloads.action(params.jobId, params.action, principal.kind === 'admin' ? null : actorId(principal)));

  registerRoute(app, ctx, routes.downloadsFormats, async () => {
    const report = await ctx.downloads.formats();
    return { formats: report.formats, ffmpeg: { available: report.ffmpeg.available, version: report.ffmpeg.version, encoders: report.ffmpeg.encoders } };
  });

  registerRoute(app, ctx, routes.downloadsStorage, async () => {
    const storage = ctx.downloads.storage();
    const volume = await diskUsage(ctx.config.dataDir);
    return {
      dataDir: ctx.config.dataDir,
      freeBytes: volume.freeBytes,
      totalBytes: volume.totalBytes,
      usedByDownloadsBytes: storage.usedByDownloadsBytes,
      partialFiles: storage.partialFiles,
      cleanupPolicy: { keepFailedDays: 14, keepPartialHours: 24 },
      directories: ctx.library.listRoots().map((r) => ({ id: r.id, name: r.displayName, relativePath: r.handleId })),
    };
  });

  /* ---------------------------------------------------------------- library */

  registerRoute(app, ctx, routes.libraryTracks, ({ query }) => {
    const page = ctx.library.listTracks({ q: query.q, cursor: query.cursor, limit: query.limit, ...(query.source === 'hub' ? { tag: null } : {}) });
    return { items: page.items, nextCursor: page.nextCursor, total: page.total };
  });

  registerRoute(app, ctx, routes.libraryRoots, () => ({ items: ctx.library.listRoots() }));

  registerRoute(app, ctx, routes.libraryRootAdd, ({ body, principal, ip, userAgent, correlationId, reply }) => {
    const root = ctx.library.addRoot(body.relativePath, body.displayName, { ip, userAgent, correlationId }, { id: actorId(principal), displayName: actorDisplayName(principal) });
    reply.status(201);
    return root;
  });

  registerRoute(app, ctx, routes.libraryRootRemove, ({ params, principal, ip, userAgent, correlationId }) => {
    ctx.library.removeRoot(params.rootId, { ip, userAgent, correlationId }, { id: actorId(principal), displayName: actorDisplayName(principal) });
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.libraryScan, ({ principal }) => {
    const userId = principal.kind === 'device' ? (ctx.devices.userFor(principal.deviceId)?.id ?? actorId(principal)) : 'admin';
    // Scanning can take minutes on a large volume, so it runs as a job and the caller polls.
    const job = ctx.jobs.enqueue({ userId, kind: 'sync-library', priority: 'P2', payload: { provider: 'hub' } });
    void ctx.library.scanAll().catch((err: unknown) => ctx.log.warn({ module: 'library', err: err instanceof Error ? err.message : String(err) }, 'library scan failed'));
    return { jobId: job.id, roots: ctx.library.listRoots().length };
  });

  registerRoute(app, ctx, routes.libraryStream, ({ params, req, reply }) => {
    const stream = ctx.library.openRange(params.trackId, req.headers.range);
    reply
      .status(stream.start === 0 && stream.end === stream.size - 1 && !req.headers.range ? 200 : 206)
      .header('Content-Type', stream.mime)
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', String(stream.end - stream.start + 1))
      .header('Cache-Control', 'private, max-age=0, must-revalidate');
    if (req.headers.range) reply.header('Content-Range', `bytes ${stream.start}-${stream.end}/${stream.size}`);
    reply.send(stream.stream);
    return RAW;
  });

  registerRoute(app, ctx, routes.libraryArtwork, ({ params, reply }) => {
    const art = ctx.library.artworkPath(params.artworkId);
    if (!art) throw new DomainError('not-found', 'No such artwork');
    // Streamed directly rather than through the static plugin: the path was already resolved and
    // confined to the artwork directory by the library service.
    reply.header('Content-Type', art.mime).header('Cache-Control', 'private, max-age=86400').send(createReadStream(art.path));
    return RAW;
  });
}

async function diskUsage(dir: string): Promise<{ freeBytes: number | null; totalBytes: number | null }> {
  try {
    const { statfs } = await import('node:fs/promises');
    const fs = await statfs(dir);
    return { freeBytes: Number(fs.bavail) * Number(fs.bsize), totalBytes: Number(fs.blocks) * Number(fs.bsize) };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}
