/** Hub-only capabilities. Never contributes to Companion/local helper health (UX-SETUP-001). */
import { z } from 'zod';
import { routes, type ProviderDescriptor, type ProviderHealth } from '@now-playing/contracts';
import { hubAccount } from './hub-account.js';

// Mirrors the additive Hub route in api/routes/tool-status.ts, until moved into contracts.
const RuntimeTool = z.object({ present: z.boolean(), state: z.enum(['missing', 'checking', 'installing', 'ready', 'failed']), version: z.string().max(160).nullable(), reason: z.string().nullable() });
const HubRuntimeStatus = z.object({
  tools: z.object({ 'yt-dlp': RuntimeTool, spotdl: RuntimeTool, ffmpeg: RuntimeTool }),
  musicsearch: z.object({ configured: z.boolean(), state: z.enum(['disabled', 'installing', 'ready', 'failed']), reason: z.string().nullable() }),
});
type RuntimeStatus = z.infer<typeof HubRuntimeStatus>;
/** Requested additive Hub route. Unknown fields are stripped by zod and never reach the DOM. */
const HubMusicSearchResponse = z.object({
  items: z.array(z.object({
    id: z.string().min(1).max(300), kind: z.enum(['track', 'artist', 'album']), title: z.string().max(300),
    artistName: z.string().max(300).nullable().default(null), albumName: z.string().max(300).nullable().default(null),
    durationMs: z.number().int().nonnegative().nullable().default(null),
  })).max(100),
  reason: z.string().max(300).nullable().default(null),
});

export type HubHealthState = 'unpaired' | 'loaded' | 'unauthorized' | 'missing-scope' | 'unavailable' | 'unreachable' | 'unsupported';
export interface HubToolStatus {
  state: HubHealthState;
  label: string;
  providers: ProviderDescriptor[];
  health: ProviderHealth[];
  reason: string | null;
  runtime: RuntimeStatus | null;
  runtimeState: HubHealthState;
  runtimeReason: string | null;
}

/** Deliberately contains no URL, path, preview, transfer handle or playback capability. */
export interface HubMusicMetadata {
  id: string;
  kind: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
}
export interface HubMusicSearch {
  items: HubMusicMetadata[];
  reason: string | null;
}

export class HubFeatureError extends Error {
  constructor(readonly state: Exclude<HubHealthState, 'unpaired' | 'loaded'>, message: string) {
    super(message);
  }
}

/** Fixed same-Hub routes only. Credentials are never put in a URL or forwarded across a redirect. */
async function get(path: string, signal?: AbortSignal, requiredScope?: string): Promise<unknown> {
  const acct = await hubAccount();
  if (!acct) throw new HubFeatureError('unauthorized', 'Pair a Hub first.');
  // AbortSignal.any is missing in older Android WebViews; link by hand.
  const linked = new AbortController();
  const timer = setTimeout(() => linked.abort(), 15_000);
  const onAbort = (): void => linked.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) linked.abort();
  const response = await fetch(`${acct.base.replace(/\/$/, '')}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${acct.credentialId}.${acct.secret}`, accept: 'application/json' },
    cache: 'no-store', redirect: 'error',
    signal: linked.signal,
  }).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }).catch((err: unknown) => {
    if (signal?.aborted) throw err;
    throw new HubFeatureError('unreachable', 'The Hub did not answer. Check its connection and try again.');
  });
  if (response.status === 401)
    throw new HubFeatureError('unauthorized', 'The Hub no longer accepts this device credential. Check whether it was revoked or expired.');
  if (response.status === 403) {
    let named: string[] = [];
    try {
      const body = (await response.json()) as { details?: { missingScopes?: unknown } };
      if (Array.isArray(body.details?.missingScopes))
        named = body.details.missingScopes.filter((s): s is string => typeof s === 'string' && /^[a-z]+:[a-z]+$/.test(s)).slice(0, 4);
    } catch { /* Older Hubs: fall back to the scope this route is documented to need. */ }
    const scopes = named.length ? named : requiredScope ? [requiredScope] : [];
    throw new HubFeatureError('missing-scope', scopes.length ? `This device needs the ${scopes.join(', ')} permission on the Hub. Grant it there; this Player does not ask for broader access.` : 'The Hub has not granted this device the permission this operation needs.');
  }
  if (response.status === 503)
    throw new HubFeatureError('unavailable', 'The requested Hub tool is unavailable. Check its setup on the Hub and try again.');
  if (response.status === 404)
    throw new HubFeatureError('unsupported', 'This Hub does not offer this feature yet.');
  if (!response.ok) throw new HubFeatureError('unreachable', `The Hub could not answer (${response.status}). Try again.`);
  const body: unknown = await response.json();
  const current = await hubAccount();
  if (!current || current.base !== acct.base || current.credentialId !== acct.credentialId)
    throw new HubFeatureError('unauthorized', 'Hub pairing changed while this request was running. Try again.');
  return body;
}

export async function hubToolStatus(signal?: AbortSignal): Promise<HubToolStatus> {
  const acct = await hubAccount();
  if (!acct) return { state: 'unpaired', label: 'Hub', providers: [], health: [], reason: 'Pair a Hub to check its tools. Companion status is separate.', runtime: null, runtimeState: 'unpaired', runtimeReason: null };
  const label = `Hub ${acct.hubName || ''}`.trim();
  const [providers, runtime] = await Promise.allSettled([
    get('/providers', signal).then((v) => routes.providersList.response.parse(v)),
    get('/tools/status', signal, 'search:use').then((v) => HubRuntimeStatus.parse(v)),
  ]);
  if (signal?.aborted) throw signal.reason;
  const error = (err: unknown): { state: HubHealthState; reason: string } => ({
    state: err instanceof HubFeatureError ? err.state : 'unreachable',
    reason: err instanceof HubFeatureError ? err.message : 'The Hub sent an unreadable status. Try again.',
  });
  const providerError = providers.status === 'rejected' ? error(providers.reason) : null;
  const runtimeError = runtime.status === 'rejected' ? error(runtime.reason) : null;
  return {
    state: providerError?.state ?? 'loaded', label,
    providers: providers.status === 'fulfilled' ? providers.value.items : [],
    health: providers.status === 'fulfilled' ? providers.value.health : [],
    reason: providerError?.reason ?? null,
    runtime: runtime.status === 'fulfilled' ? runtime.value : null,
    runtimeState: runtimeError?.state ?? 'loaded', runtimeReason: runtimeError?.reason ?? null,
  };
}

/** Explicit opt-in metadata search, not the catalog's audio acquisition path. */
export async function hubMusicSearch(query: string, signal?: AbortSignal): Promise<HubMusicSearch> {
  const q = query.trim();
  if (!q || q.length > 300 || /^(?:https?:|file:|[a-z]:[\\/])/i.test(q))
    throw new Error('Enter a song, artist or album name (up to 300 characters), not a URL or path.');
  const account = await hubAccount();
  const status = await hubToolStatus(signal);
  if (status.state !== 'loaded') throw new HubFeatureError(status.state === 'unpaired' ? 'unauthorized' : status.state, status.reason || 'The Hub is unavailable.');
  if (status.runtimeState !== 'loaded' || !status.runtime)
    throw new HubFeatureError(status.runtimeState === 'loaded' || status.runtimeState === 'unpaired' ? 'unsupported' : status.runtimeState, status.runtimeReason || 'This Hub does not report MusicSearch runtime status yet.');
  if (!status.runtime.musicsearch.configured || status.runtime.musicsearch.state !== 'ready')
    throw new Error(`MusicSearch metadata search is ${status.runtime.musicsearch.configured ? status.runtime.musicsearch.state : 'not configured'} on this Hub. Ask its administrator to check its setup.`);
  const current = await hubAccount();
  if (!account || !current || account.base !== current.base || account.credentialId !== current.credentialId) throw new HubFeatureError('unauthorized', 'Hub pairing changed. Try again.');
  const response = HubMusicSearchResponse.parse(await get(`/musicsearch/search?q=${encodeURIComponent(q)}&limit=20`, signal, 'search:use'));
  // Whitelist, do not spread: even a newer Hub cannot turn these rows into audio or file access.
  return {
    items: response.items.slice(0, 20).map((item) => ({
      id: item.id, kind: item.kind, title: item.title,
      artist: item.artistName, album: item.albumName, durationMs: item.durationMs,
    })),
    reason: response.reason ? 'MusicSearch could not finish this metadata search. Try again.' : null,
  };
}

/** Names each provider independently; an absent health entry is unknown, never healthy. */
export function hubHealthRows(status: HubToolStatus): Array<[string, string]> {
  return status.providers.map((provider) => {
    const health = status.health.find((h) => h.provider === provider.provider);
    const state = !provider.enabled ? 'disabled' : !provider.configured ? 'not configured' : health?.status ?? 'status unknown';
    return [provider.displayName, `${state}${health?.checkedAt ? ` · checked ${health.checkedAt}` : ''}`];
  });
}

export function hubRuntimeRows(status: HubToolStatus): Array<[string, string]> {
  if (status.runtimeState === 'unpaired') return [];
  const toolNames = [['yt-dlp', 'yt-dlp'], ['spotdl', 'spotDL'], ['ffmpeg', 'FFmpeg']] as const;
  const rows: Array<[string, string]> = toolNames.map(([id, name]) => {
    const tool = status.runtime?.tools[id];
    return [name, tool ? `${tool.state}${tool.state === 'ready' && tool.version ? ` · ${tool.version}` : ''}${tool.state === 'failed' ? ' · Check setup on the Hub, then refresh.' : ''}` : 'status unknown'];
  });
  const ms = status.runtime?.musicsearch;
  rows.push(['MusicSearch metadata runtime', ms ? `${ms.state}${!ms.configured ? ' · not configured' : ''}${ms.state === 'failed' ? ' · Check runtime setup on the Hub.' : ''}` : 'status unknown']);
  return rows;
}

/** Sources > Connections: authenticated Hub facts live outside both Companion cards. */
export function installHubFeatures(): void {
  const facts = document.getElementById('hubToolFacts');
  const message = document.getElementById('hubToolMsg');
  const button = document.getElementById('hubToolsRefresh') as HTMLButtonElement | null;
  installHubMusicSearch();
  if (!facts || !message || !button) return;
  let seq = 0;
  let ctl: AbortController | null = null;
  const refresh = async (): Promise<void> => {
    const mine = ++seq;
    ctl?.abort();
    ctl = new AbortController();
    facts.replaceChildren();
    button.disabled = true;
    message.textContent = 'Checking authenticated Hub tool status…';
    try {
      const status = await hubToolStatus(ctl.signal);
      if (mine !== seq) return;
      message.textContent = [status.reason, status.runtimeReason].filter(Boolean).join(' ') || `${status.label} answered. These tools run on the Hub, not on this PC. Refreshing status never installs anything.`;
      for (const [label, value] of [...hubRuntimeRows(status), ...hubHealthRows(status).map(([name, state]): [string, string] => [`Catalog: ${name}`, state])]) {
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = label; dd.textContent = value; facts.append(dt, dd);
      }
      facts.hidden = !facts.childElementCount;
    } catch {
      if (mine === seq) message.textContent = 'Hub status check was interrupted. Try again.';
    } finally { if (mine === seq) button.disabled = false; }
  };
  document.addEventListener('hub:refused', (e) => { const d = (e as CustomEvent<unknown>).detail; if (typeof d === 'string') message.textContent = d.slice(0, 300); });
  button.addEventListener('click', () => { void refresh(); });
  document.addEventListener('hub:changed', () => { void refresh(); });
  void refresh();
}

/** Read-only results are never catalog visitors: no audio, preview, download or path action. */
function installHubMusicSearch(): void {
  const button = document.getElementById('srchHubMusicSearch') as HTMLButtonElement | null;
  const box = document.getElementById('srchHubMetadata');
  const input = document.getElementById('q') as HTMLInputElement | null;
  if (!button || !box || !input) return;
  let sequence = 0;
  let ctl: AbortController | null = null;
  const reset = (): void => { sequence++; ctl?.abort(); box.replaceChildren(); box.hidden = true; button.disabled = false; };
  input.addEventListener('input', reset);
  document.addEventListener('hub:changed', reset);
  document.getElementById('srchClear')?.addEventListener('click', reset);
  button.addEventListener('click', () => {
    reset();
    const mine = sequence;
    ctl = new AbortController();
    box.hidden = false;
    button.disabled = true;
    box.textContent = 'Searching Hub MusicSearch metadata…';
    void hubMusicSearch(input.value, ctl.signal).then((answer) => {
      if (mine !== sequence) return;
      box.replaceChildren();
      const heading = document.createElement('p');
      heading.className = 'srch__cap';
      heading.textContent = `Hub MusicSearch · metadata only · ${answer.items.length} results`;
      box.append(heading);
      if (answer.reason || !answer.items.length) {
        const line = document.createElement('p');
        line.className = 'srch__status';
        line.textContent = answer.reason || 'No metadata matched. Try another song, artist or album name.';
        box.append(line);
      }
      const list = document.createElement('ul');
      for (const item of answer.items) {
        const row = document.createElement('li');
        row.textContent = [item.title, item.artist, item.album, item.kind].filter(Boolean).join(' · ');
        list.append(row);
      }
      box.append(list);
    }).catch((err: unknown) => {
      if (mine === sequence) box.textContent = err instanceof Error ? err.message : 'Could not search Hub metadata. Try again.';
    }).finally(() => { if (mine === sequence) button.disabled = false; });
  });
}

const RADIO_KEYS = new Set(['name', 'countrycode', 'tag', 'language', 'limit', 'offset']);
const RADIO_IGNORED = new Set(['hidebroken', 'is_https', 'User-Agent', 'order', 'reverse']);
const RadioRow = z.object({
  stationuuid: z.string().regex(/^[a-f\d-]{36}$/i), name: z.string().max(200), url_resolved: z.string().url().max(2048), url: z.string().url().max(2048),
  homepage: z.string().url().max(2048).nullable().optional(), favicon: z.string().url().max(2048).nullable().optional(),
  country: z.string().max(200).default(''), countrycode: z.string().max(2).default(''), language: z.string().max(200).default(''),
  tags: z.string().max(500).default(''), codec: z.string().max(30).default(''), bitrate: z.number().int().nonnegative().default(0), votes: z.number().int().nonnegative().default(0),
});
const RadioResponse = z.object({ items: z.array(z.unknown()).max(100) });

/**
 * Radio parity through the paired Hub's fixed metadata routes. Null means "not usable for this
 * query" (unpaired, an older Hub, or a query the Hub does not support) and the shell keeps its
 * public directory fallback. Station rows are metadata; no stream is proxied by the Hub.
 */
export async function hubRadioSearch(params: Record<string, unknown>, httpsOnly: boolean, signal?: AbortSignal): Promise<Array<Record<string, unknown>> | null> {
  if (!(await hubAccount())) return null;
  const q = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (RADIO_IGNORED.has(key) || raw === undefined || raw === null || raw === '') continue;
    if (!RADIO_KEYS.has(key)) return null;
    q.set(key, String(raw));
  }
  const limit = Number(q.get('limit') || 60);
  q.set('limit', String(Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.trunc(limit) : 60))));
  if (q.has('countrycode') && !/^[A-Za-z]{2}$/.test(q.get('countrycode')!)) return null;
  try {
    const answer = RadioResponse.parse(await get(`/radio/search?${q}`, signal, 'search:use'));
    return answer.items.flatMap((row) => {
      const parsed = RadioRow.safeParse(row);
      if (!parsed.success) return [];
      if (httpsOnly && !parsed.data.url_resolved.startsWith('https:')) return [];
      return [{ ...parsed.data, homepage: parsed.data.homepage ?? '', favicon: parsed.data.favicon ?? '', via: 'hub' }];
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    // Public stations still list, but a refusal is never silent: Hub Tools names it.
    if (err instanceof HubFeatureError && (err.state === 'unauthorized' || err.state === 'missing-scope'))
      document.dispatchEvent(new CustomEvent('hub:refused', { detail: `Hub radio: ${err.message} Using the public station directory.` }));
    return null;
  }
}

declare global {
  interface Window {
    NP_HUB_RADIO?: { search(params: Record<string, unknown>, httpsOnly: boolean): Promise<Array<Record<string, unknown>> | null> };
  }
}
if (typeof window !== 'undefined') window.NP_HUB_RADIO = { search: (params, httpsOnly) => hubRadioSearch(params, httpsOnly) };
