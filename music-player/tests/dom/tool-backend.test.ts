/**
 * Two transports, one protocol.
 *
 * The point of the abstraction is that the interface above it cannot tell which one answered, so
 * these tests drive both through the same assertions and then check the two things that must differ:
 * which one wins when both are present, and what each is called on screen.
 *
 * The refusals matter as much as the successes. A backend that is present but speaks a protocol this
 * player does not know must read as *absent* — building an interface from a shape that has moved is
 * worse than offering nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELPER_PROTOCOL, HELPER_TOKEN_META, type HelperHealth, type HelperJob } from '@now-playing/contracts';
import { connectHelper, loopbackHelperOrigin } from '../../src/lib/fetch-helper.js';
import { detectBackend, runFetch, ToolError } from '../../src/lib/tool-backend.js';
import type { AndroidToolsBridge } from '../../src/lib/android-bridge.js';
import type { ShellAwsp } from '../../src/shell/awsp.js';

const health = (overrides: Partial<HelperHealth> = {}): HelperHealth => ({
  helper: 'now-playing-local-helper',
  protocol: HELPER_PROTOCOL,
  version: '1.0.0-test',
  servesApp: true,
  tools: [
    { id: 'yt-dlp', present: true, version: '2026.09.01', origin: 'path', installHint: null, installable: true },
    { id: 'spotdl', present: false, version: null, origin: 'missing', installHint: 'pipx install spotdl', installable: false },
    { id: 'ffmpeg', present: true, version: 'ffmpeg 7.1', origin: 'path', installHint: null, installable: false },
  ],
  allowedHosts: ['www.youtube.com'],
  formats: ['original', 'mp3', 'aac', 'opus', 'flac'],
  startedAt: new Date(0).toISOString(),
  ...overrides,
});

const job = (overrides: Partial<HelperJob> = {}): HelperJob => ({
  id: 'job-1',
  state: 'queued',
  url: 'https://www.youtube.com/watch?v=x',
  tool: 'yt-dlp',
  format: 'original',
  stage: 'preflight',
  percent: null,
  message: null,
  files: [],
  error: null,
  startedAt: new Date(0).toISOString(),
  finishedAt: null,
  ...overrides,
});

/** A stand-in for what Android injects: synchronous, strings in and strings out. */
function fakeBridge(overrides: Partial<AndroidToolsBridge> = {}): AndroidToolsBridge {
  return {
    protocol: () => HELPER_PROTOCOL,
    health: () => JSON.stringify(health()),
    startFetch: () => JSON.stringify(job()),
    jobState: () => JSON.stringify(job({ state: 'done', stage: 'done', files: [{ id: 'f1', name: 'A Song.m4a', sizeBytes: 9, contentType: 'audio/mp4' }] })),
    forget: () => JSON.stringify({ ok: true }),
    install: () => JSON.stringify({ tool: 'yt-dlp', installed: true, version: '2026.09.01', reason: null }),
    fileUrl: () => 'https://appassets.androidplatform.net/jobfiles/job-1/f1',
    ...overrides,
  };
}

function withToken(token: string): void {
  const meta = document.createElement('meta');
  meta.setAttribute('name', HELPER_TOKEN_META);
  meta.setAttribute('content', token);
  document.head.appendChild(meta);
}

afterEach(() => {
  delete window.NowPlayingTools;
  document.head.querySelectorAll(`meta[name="${HELPER_TOKEN_META}"]`).forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

describe('finding a backend', () => {
  it('finds nothing when there is nothing, which is almost everyone', async () => {
    expect(await detectBackend(null)).toBeNull();
  });

  it('uses the one built into the app when it is there', async () => {
    window.NowPlayingTools = fakeBridge();
    const backend = await detectBackend(null);
    expect(backend).toMatchObject({ kind: 'built-in', label: 'Built into this app' });
    // No address, because there is no address: it is the same process.
    expect(backend?.origin).toBeNull();
    expect(backend?.health.tools.find((t) => t.id === 'yt-dlp')?.version).toBe('2026.09.01');
  });

  it('prefers the built-in one over a helper, and never asks the network for it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    window.NowPlayingTools = fakeBridge();
    withToken('tok');

    expect((await detectBackend(null))?.kind).toBe('built-in');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats a bridge speaking another protocol as no bridge at all', async () => {
    window.NowPlayingTools = fakeBridge({ health: () => JSON.stringify(health({ protocol: HELPER_PROTOCOL + 1 })) });
    expect(await detectBackend(null)).toBeNull();
  });

  it('treats a bridge that throws, or answers with nonsense, as no bridge at all', async () => {
    window.NowPlayingTools = fakeBridge({
      health: () => {
        throw new Error('not ready');
      },
    });
    expect(await detectBackend(null)).toBeNull();

    window.NowPlayingTools = fakeBridge({ health: () => 'not json' });
    expect(await detectBackend(null)).toBeNull();
  });

  it('finds a helper from the token it put in the page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(health({ servesApp: true })), { status: 200 })));
    withToken('tok');
    const backend = await detectBackend(null);
    expect(backend).toMatchObject({ kind: 'helper', label: 'A helper, serving this page' });
    expect(backend?.origin).toBe(window.location.origin);
  });

  it('does not treat public health as proof that a helper token is valid', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.endsWith('/helper/v1/health')
        ? new Response(JSON.stringify(health()), { status: 200 })
        : new Response(JSON.stringify({ error: 'auth', message: 'Unauthorized' }), { status: 401 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    withToken('wrong-token');

    expect(await detectBackend(null)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('only lets the standalone pairing flow send tokens to a loopback origin', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(loopbackHelperOrigin('localhost:17342/')).toBe('http://localhost:17342');
    expect(loopbackHelperOrigin('http://[::1]:17342')).toBe('http://[::1]:17342');
    expect(loopbackHelperOrigin('https://example.com')).toBeNull();
    expect(loopbackHelperOrigin('http://localhost:17342/path')).toBeNull();
    expect(await connectHelper('https://example.com', 'secret')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pairs with a loopback helper only after the token passes its protected route', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/helper/v1/health')) return new Response(JSON.stringify(health()), { status: 200 });
      expect(new Headers(init?.headers).get('x-helper-token')).toBe('good-token');
      return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const connected = await connectHelper('localhost:17342/', ' good-token ');

    expect(connected?.origin).toBe('http://localhost:17342');
    expect(connected?.token).toBe('good-token');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not go looking on loopback for someone who never asked it to', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await detectBackend(null)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses a helper saved by hand when the page carries no token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(health()), { status: 200 })));
    const backend = await detectBackend({ origin: 'http://127.0.0.1:17342', token: 'tok' });
    expect(backend).toMatchObject({ kind: 'helper', label: 'A helper at http://127.0.0.1:17342' });
  });

  it('uses the paired Companion before a saved helper and loads its downloader status over AWSP', async () => {
    const tools = health().tools.map((tool) => ({ ...tool, present: true, version: 'ready', setup: { state: 'ready' as const } }));
    const rpc = vi.fn(async (operation: string) => operation === 'tools.status' ? health({ tools }) : null);
    const awsp = {
      status: async () => ({ paired: true, serverName: 'Test PC', status: 'connected' as const, connectionType: 'relay' as const, endpointId: null, lastError: null, tracks: 0 }),
      connect: vi.fn(async () => ({ ok: true, reason: null })),
      companion: rpc,
      connectionType: () => 'relay' as const,
    } as unknown as ShellAwsp;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const backend = await detectBackend({ origin: 'http://127.0.0.1:17342', token: 'must-not-leave-player' }, document, awsp);

    expect(backend).toMatchObject({ kind: 'awsp', label: 'Paired Windows Companion (relay-carried)', origin: null });
    expect(backend?.health.tools.map((tool) => tool.id)).toEqual(['yt-dlp', 'spotdl', 'ffmpeg']);
    expect(backend?.health.tools.every((tool) => tool.present && tool.setup?.state === 'ready')).toBe(true);
    expect(rpc).toHaveBeenCalledWith('tools.status');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a helper that will not answer as absent, not as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('refused'))));
    await expect(detectBackend({ origin: 'http://127.0.0.1:17342', token: 'tok' })).resolves.toBeNull();
  });
});

describe('running a fetch', () => {
  const request = { url: 'https://www.youtube.com/watch?v=x', tool: 'auto', format: 'original', authorization: { basis: 'user-owned', acknowledged: true } } as const;

  it('polls to the end and brings the files across', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('pretend audio', { status: 200 })));
    window.NowPlayingTools = fakeBridge();
    const backend = (await detectBackend(null))!;

    const seen: string[] = [];
    const { files } = await runFetch(backend, request, (update) => seen.push(update.state));
    expect(seen).toEqual(['queued', 'done']);
    expect(files.map((file) => file.name)).toEqual(['A Song.m4a']);
    expect(await files[0]!.text()).toBe('pretend audio');
  });

  it('downloads a paired Companion job through bounded chunks and removes the temporary job', async () => {
    const id = '4d270178-e6a9-4a52-84f5-5c73ee08f9db';
    const fileId = '29895cb0-28ea-4d72-86dc-9065146e2911';
    const operations: string[] = [];
    const awsp = {
      status: async () => ({ paired: true, serverName: 'Test PC', status: 'connected' as const, connectionType: 'direct' as const, endpointId: null, lastError: null, tracks: 0 }),
      connect: vi.fn(async () => ({ ok: true, reason: null })),
      connectionType: () => 'direct' as const,
      companion: async (operation: string) => {
        operations.push(operation);
        if (operation === 'tools.status') return health();
        if (operation === 'downloads.start') return job({ id });
        if (operation === 'downloads.status') return job({ id, state: 'done', stage: 'done', files: [{ id: fileId, name: 'A Song.m4a', sizeBytes: 5, contentType: 'audio/mp4' }] });
        if (operation === 'downloads.fileChunk') return { offset: 0, totalBytes: 5, dataBase64: 'aGVsbG8=' };
        if (operation === 'downloads.forget') return { ok: true };
        throw new Error(`unexpected operation ${operation}`);
      },
    } as unknown as ShellAwsp;
    const backend = await detectBackend(null, document, awsp);
    expect(backend?.kind).toBe('awsp');
    const started = await backend!.startFetch(request);
    const done = await backend!.jobState(started.id);
    const file = await backend!.fileOf(done, done.files[0]!);
    await backend!.forget(done.id);

    expect(await file.text()).toBe('hello');
    expect(operations).toEqual(['tools.status', 'downloads.start', 'downloads.status', 'downloads.fileChunk', 'downloads.forget']);
  });

  it('throws the reason a job failed, not a generic failure', async () => {
    window.NowPlayingTools = fakeBridge({ jobState: () => JSON.stringify(job({ state: 'failed', stage: 'done', error: 'Video unavailable' })) });
    const backend = (await detectBackend(null))!;
    await expect(runFetch(backend, request, () => {})).rejects.toThrow('Video unavailable');
  });

  it('carries a refusal across the bridge with the words it was given', async () => {
    // A synchronous bridge method cannot reject, so a refusal comes back in the same shape the
    // helper returns over HTTP — which is what lets one sentence serve both.
    window.NowPlayingTools = fakeBridge({ startFetch: () => JSON.stringify({ error: 'url', message: 'Host evil.example is not on the allowlist' }) });
    const backend = (await detectBackend(null))!;
    await expect(runFetch(backend, request, () => {})).rejects.toThrow(/not on the allowlist/);
    await expect(runFetch(backend, request, () => {})).rejects.toBeInstanceOf(ToolError);
  });

  it('stops when it is told to, and takes the job with it', async () => {
    const forget = vi.fn(() => JSON.stringify({ ok: true }));
    window.NowPlayingTools = fakeBridge({ forget, jobState: () => JSON.stringify(job({ state: 'running' })) });
    const backend = (await detectBackend(null))!;
    const controller = new AbortController();
    const running = runFetch(backend, request, () => controller.abort(), controller.signal);
    await expect(running).rejects.toThrow('Cancelled.');
    expect(forget).toHaveBeenCalledWith('job-1');
  });
});
