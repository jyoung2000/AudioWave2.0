import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hubHealthRows, hubRadioSearch, hubRuntimeRows, hubMusicSearch, hubToolStatus, installHubFeatures } from '../../src/shell/hub-features.js';

const CAP = { search: 'available', metadata: 'available', preview: 'unsupported', playback: 'unsupported', importLikes: 'unsupported', importPlaylists: 'unsupported', creatorDownload: 'unsupported', userOwnedDownload: 'unsupported', groupSync: 'unsupported', eq: 'unsupported' };
const provider = (id = 'musicsearch') => ({ provider: id, displayName: id === 'musicsearch' ? 'MusicSearch' : id, enabled: true, configured: true, capabilities: CAP, role: 'metadata-only', authType: 'none', groupCompatible: false, discordCompatible: false, reviewedAt: '2026-10-17' });
const health = (id = 'musicsearch') => ({ provider: id, status: 'ok', circuit: 'closed', checkedAt: '2026-10-17T12:00:00Z', latencyMs: 12, message: null, rateLimitedUntil: null });
const runtime = () => ({ tools: { 'yt-dlp': { present: true, state: 'ready', version: '2026.10.17', reason: null }, spotdl: { present: true, state: 'ready', version: '4.5.2', reason: null }, ffmpeg: { present: true, state: 'ready', version: '9.0', reason: null } }, musicsearch: { configured: true, state: 'ready', reason: null } });
const status = () => ({ items: [provider()], health: [health()] });
const json = (body: unknown, code = 200): Response => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
let account: unknown;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  account = { base: 'https://hub.example', credentialId: 'test-device', secret: 'fixture-secret', hubName: 'Fixture Hub', scopes: ['search:use'] };
  (window as unknown as { kv: unknown }).kv = { get: vi.fn(async () => account) };
  fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  document.body.innerHTML = '';
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('authenticated Hub status, never Companion readiness', () => {
  it('does not fetch anything when unpaired', async () => {
    account = null;
    expect((await hubToolStatus()).state).toBe('unpaired');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps per-provider health and sends only a device bearer on a fixed Hub URL', async () => {
    fetcher.mockResolvedValue(json(status()));
    const result = await hubToolStatus();
    expect(result.state).toBe('loaded');
    expect(result.health[0]?.status).toBe('ok');
    expect(hubHealthRows(result)[0]).toEqual(['MusicSearch', expect.stringContaining('ok')]);
    expect(fetcher).toHaveBeenCalledWith('https://hub.example/api/v1/providers', expect.objectContaining({ headers: { Authorization: 'Bearer test-device.fixture-secret', accept: 'application/json' }, cache: 'no-store', redirect: 'error' }));
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('https://hub.example/api/v1/'))).toBe(true);
  });
  it('absent health is unknown, not healthy', async () => {
    fetcher.mockResolvedValue(json({ items: [provider()], health: [] }));
    expect(hubHealthRows(await hubToolStatus())[0]?.[1]).toBe('status unknown');
  });
  it.each([[401, 'unauthorized'], [403, 'missing-scope'], [404, 'unsupported'], [503, 'unavailable']])('keeps HTTP %i distinct as %s', async (code, state) => {
    fetcher.mockResolvedValue(json({ error: { message: 'never echo fixture-secret' } }, Number(code)));
    const result = await hubToolStatus();
    expect(result.state).toBe(state);
    expect(result.reason).not.toContain('fixture-secret');
  });
  it('renders each runtime setup state, independently from provider health and Companion', async () => {
    const tools = runtime(); tools.tools['yt-dlp'].state = 'missing'; tools.tools.spotdl.state = 'installing';
    fetcher.mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json(tools));
    const result = await hubToolStatus();
    expect(result.state).toBe('loaded'); expect(result.runtimeState).toBe('loaded');
    expect(hubRuntimeRows(result)).toEqual([['yt-dlp', 'missing'], ['spotDL', 'installing'], ['FFmpeg', 'ready · 9.0'], ['MusicSearch metadata runtime', 'ready']]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('an older Hub keeps provider health but runtime is unsupported, never ready', async () => {
    fetcher.mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json({}, 404));
    const result = await hubToolStatus();
    expect(result.state).toBe('loaded'); expect(result.runtimeState).toBe('unsupported');
    expect(hubRuntimeRows(result).every(([, state]) => state === 'status unknown')).toBe(true);
  });
  it('names the exact status permission without asking for broad scopes', async () => {
    fetcher.mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json({}, 403));
    expect((await hubToolStatus()).runtimeReason).toContain('search:use');
  });
  it('names Hub-reported missing scopes, validated, over the default', async () => {
    fetcher.mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json({ details: { missingScopes: ['library:sync', '<b>evil</b>'] } }, 403));
    const reason = (await hubToolStatus()).runtimeReason!;
    expect(reason).toContain('library:sync'); expect(reason).not.toContain('evil');
  });
  it('network failure stays unreachable and clears stale health', async () => {
    fetcher.mockRejectedValue(new TypeError('offline'));
    expect(await hubToolStatus()).toMatchObject({ state: 'unreachable', health: [], providers: [] });
  });
  it('respects cancellation', async () => {
    const ctl = new AbortController(); ctl.abort();
    fetcher.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(hubToolStatus(ctl.signal)).rejects.toThrow();
  });
});

describe('MusicSearch is explicit metadata-only', () => {
  it.each(['https://audio.example/file', 'file:///secret', 'C:\\secret\\music', 'x'.repeat(301)])('refuses a URL/path/overlong query', async (q) => {
    await expect(hubMusicSearch(q)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([['not configured', false, 'disabled'], ['installing', true, 'installing'], ['failed', true, 'failed']])('refuses MusicSearch when its runtime is %s', async (_label, configured, state) => {
    const rt = runtime(); rt.musicsearch = { configured: configured as boolean, state: state as 'ready', reason: null };
    fetcher.mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json(rt));
    await expect(hubMusicSearch('Night Song')).rejects.toThrow(/MusicSearch metadata search is/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('an older Hub without runtime status is unsupported, never searched', async () => {
    fetcher.mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json({}, 404));
    await expect(hubMusicSearch('Night Song')).rejects.toThrow('does not offer');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('uses the dedicated metadata route and whitelists fields', async () => {
    const item = { id: 'musicsearch:track:1', kind: 'track', title: '<img src=x onerror=alert(1)>', artistName: 'Singer', albumName: 'Album', durationMs: 12345, url: 'https://upstream.example/track', previewUrl: 'https://upstream.example/preview', streamUrl: 'https://upstream.example/audio', downloadUrl: 'https://upstream.example/dl', localPath: 'C:/private/audio.mp3', file: 'x.mp3', transferHandle: 'secret' };
    fetcher.mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json(runtime())).mockResolvedValueOnce(json({ items: [item], reason: null }));
    const result = await hubMusicSearch('Night Song');
    expect(result.items).toEqual([{ id: item.id, kind: 'track', title: item.title, artist: 'Singer', album: 'Album', durationMs: 12345 }]);
    expect(JSON.stringify(result)).not.toMatch(/upstream|private|secret|x\.mp3/);
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://hub.example/api/v1/musicsearch/search?q=Night%20Song&limit=20');
  });
  it('names search:use when the metadata route is refused', async () => {
    fetcher.mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json(runtime())).mockResolvedValueOnce(json({}, 403));
    await expect(hubMusicSearch('Night Song')).rejects.toThrow('search:use');
  });
  it('drops an answer when pairing changed mid-request', async () => {
    fetcher.mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json(runtime())).mockImplementationOnce(async () => { account = { ...(account as object), credentialId: 'other' }; return json({ items: [], reason: null }); });
    await expect(hubMusicSearch('Night Song')).rejects.toThrow('pairing changed');
  });
  it('renders remote names as text and clears them when the paired Hub changes', async () => {
    document.body.innerHTML = '<dl id="hubToolFacts"></dl><p id="hubToolMsg"></p><button id="hubToolsRefresh"></button><input id="q"><button id="srchHubMusicSearch"></button><section id="srchHubMetadata" hidden></section>';
    fetcher.mockResolvedValue(json({ items: [{ ...provider(), displayName: '<img onerror=alert(1)>' }], health: [] }));
    installHubFeatures();
    await vi.waitFor(() => expect(document.getElementById('hubToolFacts')?.textContent).toContain('<img onerror=alert(1)>'));
    expect(document.querySelector('#hubToolFacts img')).toBeNull();
    document.getElementById('hubToolFacts')!.textContent = 'stale';
    account = null; document.dispatchEvent(new Event('hub:changed'));
    await vi.waitFor(() => expect(document.getElementById('hubToolMsg')?.textContent).toContain('Pair a Hub'));
    expect(document.getElementById('hubToolFacts')?.textContent).toBe('');
  });
});

describe('Hub radio directory parity', () => {
  const station = { stationuuid: '11111111-2222-3333-4444-555555555555', name: 'Hub FM', url_resolved: 'https://stream.example/hub', url: 'https://stream.example/hub', homepage: null, favicon: null, country: 'US', countrycode: 'US', language: 'english', tags: 'jazz', codec: 'MP3', bitrate: 128, votes: 5 };
  it('is not used while unpaired', async () => {
    account = null;
    expect(await hubRadioSearch({ name: 'jazz' }, false)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('asks the fixed Hub metadata route with supported filters only and drops malformed/insecure rows', async () => {
    fetcher.mockResolvedValue(json({ items: [station, { ...station, stationuuid: 'bad' }, { ...station, stationuuid: '11111111-2222-3333-4444-555555555556', url_resolved: 'http://stream.example/plain' }] }));
    const rows = await hubRadioSearch({ tag: 'jazz', hidebroken: 'true', 'User-Agent': 'x', limit: '500' }, true);
    expect(rows).toEqual([expect.objectContaining({ name: 'Hub FM', via: 'hub' })]);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://hub.example/api/v1/radio/search?tag=jazz&limit=100');
  });
  it('falls back (null) for unsupported filters, refusals and older Hubs', async () => {
    expect(await hubRadioSearch({ state: 'Illinois' }, false)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    const refused = vi.fn(); document.addEventListener('hub:refused', refused);
    for (const code of [401, 403, 404, 503]) {
      fetcher.mockResolvedValueOnce(json({}, code));
      expect(await hubRadioSearch({ name: 'x' }, false)).toBeNull();
    }
    expect(refused).toHaveBeenCalledTimes(2);
    fetcher.mockRejectedValueOnce(new TypeError('offline'));
    expect(await hubRadioSearch({ name: 'x' }, false)).toBeNull();
  });
});
