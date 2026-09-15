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
import { detectBackend, runFetch, ToolError } from '../../src/lib/tool-backend.js';
import type { AndroidToolsBridge } from '../../src/lib/android-bridge.js';

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
