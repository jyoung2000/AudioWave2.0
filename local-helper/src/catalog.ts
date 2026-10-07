/**
 * The music catalog on this PC (DEC-039): the same engine and the same answers as the hub's
 * `/api/v1/catalog/*`, under `/helper/v1/catalog/*`, for the companion and the Android shell.
 *
 * What it may reach: the catalog's own API hosts (`CATALOG_API_HOSTS`), https only, re-checked on
 * every redirect hop, and never an address on this network — the same rule a download's URL meets,
 * because this program runs on the inside of someone's network. What it may run: yt-dlp for
 * YouTube and SoundCloud search, and the link reader the resolve route already uses (yt-dlp,
 * spotDL), through its two slots.
 */
import { lookup } from 'node:dns/promises';
import { CATALOG_API_HOSTS, type HelperResolved } from '@now-playing/contracts';
import { isResolvedAddressAllowed, validateOutboundUrl } from '@now-playing/domain';
import { CatalogEngine, LinkReadError, type CatalogFetch, type LinkRead, type LinkTrack } from '@now-playing/domain/catalog';
import { ResolveError, type Resolver } from './resolve.js';
import { checkFetchUrl } from './security.js';

const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * `fetch`, held to the catalog's hosts. Each hop's URL is validated, its name resolved and every
 * address it resolves to checked against private, loopback and link-local ranges before connecting.
 */
export function guardedCatalogFetch(fetchImpl: typeof fetch = fetch, resolveName: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true })).map((a) => a.address)): CatalogFetch {
  return async (input, init) => {
    let url = input;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const checked = validateOutboundUrl(url, { allowedHosts: CATALOG_API_HOSTS, allowedSchemes: ['https:'], maxLength: 4096 });
      if (!checked.ok || !checked.url) throw new Error(`Blocked outbound URL: ${checked.reason ?? 'not allowed'}`);
      const addresses = await resolveName(checked.url.hostname);
      const allowed = isResolvedAddressAllowed(addresses);
      if (!allowed.ok) throw new Error(`Blocked outbound URL: ${allowed.reason ?? 'resolves to a private address'}`);
      const response = await fetchImpl(checked.url, { headers: init.headers, signal: init.signal, redirect: 'manual', credentials: 'omit' });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => undefined);
        url = new URL(location, checked.url).toString();
        continue;
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_BODY_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`${checked.url.hostname} sent far more than any answer needs`);
      }
      let text: Promise<string> | null = null;
      const read = (): Promise<string> =>
        (text ??= response.text().then((t) => {
          if (t.length > MAX_BODY_BYTES) throw new Error(`${checked.url!.hostname} sent far more than any answer needs`);
          return t;
        }));
      return { status: response.status, headers: response.headers, text: read, json: async () => JSON.parse(await read()) as unknown };
    }
    throw new Error('Too many redirects');
  };
}

/** What the helper's resolver says a link is, in the engine's words. */
export function helperToLinkRead(resolved: HelperResolved): LinkRead {
  const entry = (t: NonNullable<HelperResolved['track']>): LinkTrack => ({ ...t, isrc: t.isrc ?? null, matchUrl: t.matchUrl ?? null });
  if (resolved.kind === 'track' && resolved.track) return { kind: 'track', url: resolved.url, track: entry(resolved.track) };
  const c = resolved.collection;
  if (!c) throw new LinkReadError('The tool described nothing at that address.', 'unavailable');
  return { kind: 'collection', url: resolved.url, title: c.title, owner: c.artist, artworkUrl: c.artworkUrl, date: c.date, entries: c.entries.map(entry), total: c.total, capped: c.capped };
}

export interface HelperCatalogOptions {
  version: string;
  links: Resolver;
  /** The hosts a link may be on before a tool reads it: the helper's allowlist. */
  allowedHosts: readonly string[];
  /** Tests pass a fixture fetch; nothing else should. */
  fetch?: CatalogFetch | undefined;
}

export function createHelperCatalog(options: HelperCatalogOptions): CatalogEngine {
  return new CatalogEngine({
    fetch: options.fetch ?? guardedCatalogFetch(),
    userAgent: `AirwaveHelper/${options.version} ( https://github.com/jyoung2000/AudioWave2.0 )`,
    toolSearch: ({ args, signal }) => options.links.search(args, signal),
    linkReader: async (url, { signal, match, items }) => {
      void signal;
      const checked = checkFetchUrl(url, options.allowedHosts);
      if (!checked.ok || !checked.url) throw new LinkReadError(checked.reason ?? 'That address is not one this helper will read.', 'unavailable');
      try {
        // The whole list for the catalog (up to CATALOG_COLLECTION_CAP), or a page of positions in full.
        return helperToLinkRead(await options.links.resolve(checked.url, { match: match === true, all: true, ...(items?.length ? { items } : {}) }));
      } catch (error) {
        if (error instanceof ResolveError) throw new LinkReadError(error.message, error.code === 'tool-missing' ? 'tool-missing' : error.code === 'busy' ? 'busy' : 'failed');
        throw error;
      }
    },
  });
}
