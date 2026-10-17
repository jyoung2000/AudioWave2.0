/**
 * Verified readiness of the hub's own downloader tools (yt-dlp, spotDL, FFmpeg).
 *
 * A status read never installs anything and never leaks more than the version string: no paths,
 * no stderr, no installer output. MusicSearch is reported as not configured until a metadata-only
 * runtime actually ships here; the licensing question on that vendored runtime is still open.
 */
import type { FastifyInstance } from 'fastify';
import { routes } from '@now-playing/contracts';
import type { HubContext } from '../../context.js';
import { registerRoute } from '../register.js';

export function registerToolStatusRoutes(app: FastifyInstance, ctx: HubContext): void {
  registerRoute(app, ctx, routes.toolStatus, async () => ({
    tools: ctx.tools.snapshot(),
    musicsearch: {
      configured: false,
      state: 'disabled' as const,
      reason: 'MusicSearch metadata search is not enabled on this Hub yet.',
    },
  }));
}