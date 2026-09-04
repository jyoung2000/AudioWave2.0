import type { FastifyInstance } from 'fastify';
import type { HubContext } from '../../context.js';
import { registerAdminRoutes } from './admin.js';
import { registerGroupRoutes } from './groups.js';
import { registerMediaRoutes } from './media.js';
import { registerPairingRoutes } from './pairing.js';
import { registerProviderRoutes } from './providers.js';
import { registerShareRoutes } from './shares.js';
import { registerSyncRoutes } from './sync.js';
import { registerSystemRoutes } from './system.js';

/**
 * Bind every contract route. The order is irrelevant to Fastify but is kept in the same order as
 * `routes.ts` so a missing route is easy to spot; `tests/contracts` asserts that every route in the
 * contract has a handler here.
 */
export function registerAllRoutes(app: FastifyInstance, ctx: HubContext): void {
  registerSystemRoutes(app, ctx);
  registerPairingRoutes(app, ctx);
  registerProviderRoutes(app, ctx);
  registerGroupRoutes(app, ctx);
  registerMediaRoutes(app, ctx);
  registerSyncRoutes(app, ctx);
  registerShareRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
}
