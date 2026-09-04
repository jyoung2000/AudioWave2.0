/**
 * Generates JSON Schema documents and an OpenAPI 3.1 description from the canonical Zod contracts.
 * Run: pnpm --filter @now-playing/contracts generate
 */
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as contracts from '../src/index.js';
import { routes, type RouteContract } from '../src/api/routes.js';
import { API_PREFIX, CONTRACTS_VERSION } from '../src/common.js';
import { BRANDING } from '../src/branding.js';
import { ClientEventPayloads, Envelope, ServerEventPayloads } from '../src/realtime/envelope.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'generated');
const schemaDir = join(outDir, 'json-schema');
mkdirSync(schemaDir, { recursive: true });
for (const f of readdirSync(schemaDir)) unlinkSync(join(schemaDir, f));

const ENTITY_NAMES = [
  'UserProfile', 'Device', 'DeviceCredential', 'DeviceCredentialSecret', 'HubUser', 'LibraryRoot', 'Artist', 'Album', 'Track', 'TrackIdentity', 'TrackRef',
  'MediaLocator', 'ProviderAccount', 'ProviderCapability', 'ProviderCapabilities', 'ProviderDescriptor', 'ProviderAppConfigInput', 'ProviderAppConfigView', 'UserPlatformSync',
  'Playlist', 'PlaylistItem', 'Queue', 'QueueItem', 'QueueCommand', 'PlaybackState', 'EqPreset', 'EqBand', 'EqBinding', 'RetuneConfig', 'AudioSettings',
  'ListeningEvent', 'AggregateTasteProfile', 'Recommendation', 'Group', 'GroupMembership', 'GroupQueueRevision', 'GroupHistoryEntry', 'GroupPlaybackState',
  'DownloadJob', 'TransferJob', 'DiscoveryJob', 'PairingSession', 'PairingLinkPayload', 'DiscordConfiguration', 'DiscordTemplates', 'DiscordStatus', 'AuditEvent',
  'CanonicalTrack', 'CanonicalArtist', 'TrackPlatform', 'ArtistRelation', 'DiscoveryCacheEntry',
  'PlaylistJson', 'EqPresetJson', 'HistoryCsvRow', 'HistoryImportReport', 'ReleaseMetadata', 'SyncManifest', 'SyncChange', 'SyncDeltaRequest', 'SyncDeltaResponse', 'SyncStatus',
  'Envelope', 'ProblemDetails', 'SearchResult', 'SearchResponse', 'HubIdentity', 'ShareLink', 'ShareLinkView', 'SharePayload',
] as const;

function toSchema(schema: z.ZodTypeAny, io: 'input' | 'output', title: string): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any', reused: 'inline' }) as Record<string, unknown>;
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title, ...json };
}

const registry = contracts as unknown as Record<string, z.ZodTypeAny>;
const index: Record<string, string> = {};
for (const name of ENTITY_NAMES) {
  const schema = registry[name];
  if (!schema || !(schema instanceof z.ZodType)) throw new Error(`Missing schema export ${name}`);
  const file = `${name}.schema.json`;
  writeFileSync(join(schemaDir, file), JSON.stringify(toSchema(schema, 'output', name), null, 2) + '\n');
  index[name] = file;
}
writeFileSync(join(schemaDir, 'index.json'), JSON.stringify({ contractsVersion: CONTRACTS_VERSION, schemas: index }, null, 2) + '\n');

/* ---------- OpenAPI ---------- */
type Json = Record<string, unknown>;
function inline(schema: z.ZodTypeAny, io: 'input' | 'output'): Json {
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any', reused: 'inline', target: 'openapi-3.0' }) as Json;
  delete json['$schema'];
  return json;
}
function paramList(schema: z.ZodTypeAny | undefined, location: 'path' | 'query'): Json[] {
  if (!schema || !(schema instanceof z.ZodObject)) return [];
  const json = inline(schema, 'input');
  const props = (json['properties'] as Record<string, Json> | undefined) ?? {};
  const required = new Set((json['required'] as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, prop]) => ({
    name,
    in: location,
    required: location === 'path' ? true : required.has(name),
    schema: prop,
    ...(prop['description'] ? { description: prop['description'] } : {}),
  }));
}

const paths: Record<string, Json> = {};
const securitySchemes = {
  adminSession: { type: 'apiKey', in: 'cookie', name: `${BRANDING.slug}-session`, description: 'HttpOnly SameSite admin session cookie; state changes also require the X-CSRF-Token header.' },
  deviceCredential: { type: 'http', scheme: 'bearer', description: 'Scoped device credential obtained through pairing: `Authorization: Bearer <credentialId>.<secret>`' },
};
for (const [name, r] of Object.entries(routes as Record<string, RouteContract>)) {
  const path = (r.absolute ? r.path : `${API_PREFIX}${r.path}`).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  const security: Json[] = r.auth === 'none' ? [] : r.auth === 'admin' ? [{ adminSession: [] }] : r.auth === 'device' ? [{ deviceCredential: r.scopes ?? [] }] : [{ adminSession: [] }, { deviceCredential: r.scopes ?? [] }];
  const op: Json = {
    operationId: r.operationId,
    summary: r.summary,
    tags: r.tags,
    'x-route-name': name,
    'x-auth': r.auth,
    'x-scopes': r.scopes ?? [],
    'x-setup-required': r.setupRequired ?? r.auth !== 'none',
    'x-rate-limit': r.rateLimit ?? 'default',
    parameters: [...paramList(r.params, 'path'), ...paramList(r.query, 'query')],
    security,
    responses: {
      [String(r.responseStatus ?? 200)]: {
        description: 'Success',
        content: { [r.responseContentType ?? 'application/json']: { schema: r.responseContentType && !r.responseContentType.includes('json') ? { type: 'string' } : inline(r.response, 'output') } },
      },
      '400': { description: 'Validation error', content: { 'application/problem+json': { schema: inline(contracts.ProblemDetails, 'output') } } },
      '401': { description: 'Not authenticated' },
      '403': { description: 'Forbidden (scope, CSRF, or setup incomplete)' },
      '429': { description: 'Rate limited; honours Retry-After' },
    },
  };
  if (r.body) {
    const ct = r.requestContentType ?? 'application/json';
    op['requestBody'] = { required: true, content: { [ct]: { schema: ct === 'application/json' ? inline(r.body, 'input') : { type: 'string', format: ct === 'application/octet-stream' ? 'binary' : undefined } } } };
  }
  paths[path] ??= {};
  paths[path][r.method.toLowerCase()] = op;
}

const realtime: Json = {
  path: `${API_PREFIX}/realtime`,
  envelope: inline(Envelope, 'output'),
  serverEvents: Object.fromEntries(Object.entries(ServerEventPayloads).map(([k, v]) => [k, inline(v, 'output')])),
  clientEvents: Object.fromEntries(Object.entries(ClientEventPayloads).map(([k, v]) => [k, inline(v, 'input')])),
};

const openapi = {
  openapi: '3.1.0',
  info: { title: `${BRANDING.products.hub} API`, version: CONTRACTS_VERSION, description: 'Generated from packages/contracts. Do not edit by hand.' },
  servers: [{ url: `http://localhost:${BRANDING.hubPort}` }],
  paths,
  components: { securitySchemes },
  'x-realtime': realtime,
};
writeFileSync(join(outDir, 'openapi.json'), JSON.stringify(openapi, null, 2) + '\n');
console.log(`Generated ${Object.keys(index).length} JSON schemas and OpenAPI with ${Object.keys(paths).length} paths.`);
