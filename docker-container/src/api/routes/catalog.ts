/**
 * The music catalog's routes (DEC-039): `/api/v1/catalog/*`.
 *
 * Search streams NDJSON — a line per chunk, flushed as each service answers — under the same auth,
 * scope (`search:use`) and rate-limit class (`search`) as `/api/v1/search`. A client that goes away
 * aborts the services still being asked. `?stream=0` answers once, with the folded result.
 */
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { NDJSON_CONTENT_TYPE, routes } from '@now-playing/contracts';
import { ndjsonLine } from '@now-playing/domain/catalog';
import type { HubContext } from '../../context.js';
import { actorDisplayName, actorId } from '../../auth/principal.js';
import { RAW, registerRoute, type RawResponse } from '../register.js';

export function registerCatalogRoutes(app: FastifyInstance, ctx: HubContext): void {
  registerRoute(app, ctx, routes.catalogSearch, async ({ query, req, reply }): Promise<RawResponse> => {
    const controller = new AbortController();
    req.raw.once('close', () => controller.abort());
    const input = {
      q: query.q,
      track: query.track,
      artist: query.artist,
      album: query.album,
      sections: query.sections,
      providers: query.providers,
      offset: query.offset,
      limit: query.limit,
    };
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (query.stream === '0') {
      const aggregate = await ctx.catalog.engine.searchAll(input, controller.signal);
      reply.type('application/json; charset=utf-8').send(aggregate);
      return RAW;
    }
    const engine = ctx.catalog.engine;
    async function* lines(): AsyncGenerator<string> {
      for await (const chunk of engine.search(input, controller.signal)) yield ndjsonLine(chunk);
    }
    reply.type(`${NDJSON_CONTENT_TYPE}; charset=utf-8`).send(Readable.from(lines()));
    return RAW;
  });

  registerRoute(app, ctx, routes.catalogAlbum, ({ query }) => ctx.catalog.engine.album(query.id, query.offset, query.limit));

  registerRoute(app, ctx, routes.catalogArtist, ({ query }) => ctx.catalog.engine.artist(query.id, { albumsOffset: query.albumsOffset, albumsLimit: query.albumsLimit, topLimit: query.topLimit }));

  registerRoute(app, ctx, routes.catalogResolve, ({ query }) => ctx.catalog.engine.resolve(query.url, query.offset, query.limit));

  registerRoute(app, ctx, routes.catalogLyrics, ({ query }) =>
    ctx.catalog.engine.lyrics({ title: query.title, artist: query.artist, ...(query.album ? { album: query.album } : {}), ...(query.durationSec ? { durationSec: query.durationSec } : {}) }),
  );

  registerRoute(app, ctx, routes.catalogEnrich, ({ query }) => {
    const input = { isrc: query.isrc ?? null, title: query.title ?? null, artist: query.artist ?? null, durationMs: query.durationSec ? query.durationSec * 1000 : null };
    return query.links === '1' ? ctx.catalog.engine.enrichWithLinks(input) : ctx.catalog.engine.enrich(input);
  });

  registerRoute(app, ctx, routes.catalogDownload, async ({ body, principal, ip, correlationId, reply }) => {
    const result = await ctx.catalog.download(
      {
        track: body.track,
        authorization: { basis: body.authorization.basis, evidence: body.authorization.evidence, acknowledged: true },
        target: { destination: body.target.destination, directoryId: body.target.directoryId, filenameTemplate: body.target.filenameTemplate, format: body.target.format, quality: body.target.quality },
        ownerId: actorId(principal),
      },
      { ip, correlationId },
      actorDisplayName(principal),
    );
    reply.status(201);
    return result;
  });

  registerRoute(app, ctx, routes.catalogSettingsGet, () => ctx.catalog.settingsView());

  registerRoute(app, ctx, routes.catalogSettingsPut, ({ body, principal, ip, correlationId }) => {
    const view = ctx.catalog.putSettings(body);
    ctx.audit.record({
      actor: principal.kind === 'admin' ? { kind: 'admin', id: principal.userId, displayName: principal.username } : { kind: 'anonymous', id: 'anonymous' },
      action: 'catalog.settings',
      outcome: 'success',
      ip,
      correlationId,
      // Never the key itself: only that one was set or cleared.
      details: { embedLyrics: view.embedLyrics, switchedOff: Object.entries(view.providers).filter(([, on]) => !on).map(([id]) => id).join(',') || null, odesliKeyChanged: body.odesliKey !== undefined },
    });
    return view;
  });
}
