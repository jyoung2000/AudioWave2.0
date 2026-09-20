/**
 * The download queue: recovery, retries, concurrency and cancellation.
 *
 * A stub provider hands out either a file on disk or an HTTP body the test feeds by hand, so a job
 * can be held mid-transfer while the test cancels, retries or counts running jobs.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderCapabilities, ProviderDescriptor } from '@now-playing/contracts';
import { DomainError, uuidv7 } from '@now-playing/domain';
import type { AuthorizedDownload } from '../../src/providers/adapter.js';
import { BaseAdapter, caps, REVIEWED_AT } from '../../src/providers/adapters/base.js';
import type { DownloadRecord } from '../../src/db/repositories/downloads.js';
import { MAX_CONCURRENT_DOWNLOADS } from '../../src/downloads/service.js';
import { createTestHub, type TestHub } from '../helpers/hub.js';

const HOST = 'downloads.example';

class StubDownloadAdapter extends BaseAdapter {
  readonly id = 'stub-dl';
  mode: 'file' | 'http' = 'file';
  filePath = '';

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'Stub downloads', role: 'tool', authType: 'local', authScopes: [], groupCompatible: false, discordCompatible: false, reviewedAt: REVIEWED_AT, limitations: [] };
  }

  capabilities(): ProviderCapabilities {
    return caps({ userOwnedDownload: 'available' });
  }

  override allowedHosts(): readonly string[] {
    return [HOST];
  }

  override async getAuthorizedDownload(id: string): Promise<AuthorizedDownload | null> {
    if (this.mode === 'file') return { kind: 'file', path: this.filePath, filename: `${id}.mp3`, mime: 'audio/mpeg', sizeBytes: null, basis: 'user-owned' };
    return { kind: 'http', url: `https://${HOST}/${id}.mp3`, filename: `${id}.mp3`, mime: 'audio/mpeg', sizeBytes: null, basis: 'user-owned' };
  }
}

interface HeldBody {
  push(text: string): void;
  end(): void;
  cancelled: boolean;
}

/** A fetch whose response bodies stay open until the test ends them. */
function heldFetch(): { fetch: typeof globalThis.fetch; bodies: HeldBody[] } {
  const bodies: HeldBody[] = [];
  const fetchImpl = (async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const held: HeldBody = {
      cancelled: false,
      push: (text) => controller.enqueue(new TextEncoder().encode(text)),
      end: () => controller.close(),
    };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        held.cancelled = true;
      },
    });
    bodies.push(held);
    return new Response(stream, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, bodies };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let hub: TestHub | null = null;

afterEach(async () => {
  await hub?.dispose();
  hub = null;
});

async function setup(mode: 'file' | 'http'): Promise<{ hub: TestHub; adapter: StubDownloadAdapter; bodies: HeldBody[] }> {
  const adapter = new StubDownloadAdapter();
  adapter.mode = mode;
  const held = heldFetch();
  hub = await createTestHub({ deps: { extraAdapters: [adapter], ...(mode === 'http' ? { fetch: held.fetch } : {}) } });
  adapter.filePath = join(hub.dataDir, 'source.mp3');
  writeFileSync(adapter.filePath, 'not really audio, but bytes all the same');
  return { hub, adapter, bodies: held.bodies };
}

function record(h: TestHub, patch: Partial<DownloadRecord>): DownloadRecord {
  const now = new Date(h.clock.now()).toISOString();
  const job: DownloadRecord = {
    id: uuidv7(h.clock.now()),
    state: 'queued',
    ownerId: 'admin',
    source: { provider: 'stub-dl', providerTrackId: `t-${Math.random().toString(36).slice(2)}`, url: null, locator: null, title: 'Song', artistName: 'Artist' },
    authorization: { basis: 'user-owned', evidence: null, acknowledgedAt: now },
    target: { destination: 'hub', directoryId: null, filenameTemplate: '{artist} - {title}', format: 'original', quality: null },
    progress: { bytesDone: 0, bytesTotal: null, speedBps: null, percent: null, stage: 'preflight' },
    attempts: 0,
    maxAttempts: 5,
    nextRetryAt: null,
    checksumSha256: null,
    resultLocator: null,
    resultSizeBytes: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    outputPath: null,
    ...patch,
  };
  h.ctx.repos.downloads.insert(job);
  return job;
}

const create = (h: TestHub) =>
  h.ctx.downloads.create(
    {
      source: { provider: 'stub-dl', providerTrackId: `t-${Math.random().toString(36).slice(2)}`, url: null, locator: null, title: 'Song', artistName: 'Artist' },
      authorization: { basis: 'user-owned', acknowledged: true },
      target: { destination: 'hub', format: 'original' },
      ownerId: 'admin',
    },
    { ip: null, correlationId: null },
    'Admin',
  );

describe('download queue recovery', () => {
  it('runs jobs that were interrupted by a restart once recover() is called', async () => {
    const { hub: h } = await setup('file');
    const job = record(h, { state: 'running', attempts: 1 });
    expect(h.ctx.downloads.recover()).toBe(1);
    await h.ctx.downloads.idle();
    expect(h.ctx.downloads.find(job.id).state).toBe('completed');
  });

  it('runs a retrying job once its backoff has elapsed, from the scheduler tick', async () => {
    const { hub: h } = await setup('file');
    const job = record(h, { state: 'retrying', attempts: 1, nextRetryAt: new Date(h.clock.now() + 3000).toISOString() });
    // Not due yet: nothing starts.
    expect(h.ctx.downloads.tick()).toBe(0);
    await h.tick(10_000);
    await h.ctx.downloads.idle();
    const done = h.ctx.downloads.find(job.id);
    expect(done.state).toBe('completed');
    expect(done.attempts).toBe(2);
  });
});

describe('download concurrency and control', () => {
  it('runs up to the concurrency limit at once', async () => {
    const { hub: h, bodies } = await setup('http');
    const jobs = [await create(h), await create(h), await create(h)];
    await waitFor(() => bodies.length === MAX_CONCURRENT_DOWNLOADS, 'two transfers to start');
    expect(h.ctx.downloads.counts().running).toBe(MAX_CONCURRENT_DOWNLOADS);
    expect(h.ctx.downloads.counts().queued).toBe(1);

    for (const body of bodies.splice(0)) {
      body.push('abc');
      body.end();
    }
    await waitFor(() => bodies.length === 1, 'the third transfer to start');
    bodies[0]!.push('xyz');
    bodies[0]!.end();
    await h.ctx.downloads.idle();
    for (const job of jobs) expect(h.ctx.downloads.find(job.id).state).toBe('completed');
  });

  it('cancelling a running job stops the transfer, removes the partial file and stays cancelled', async () => {
    const { hub: h, bodies } = await setup('http');
    const job = await create(h);
    await waitFor(() => bodies.length === 1, 'the transfer to start');
    bodies[0]!.push('first chunk');
    await waitFor(() => existsSync(join(h.dataDir, 'partial', `${job.id}.part`)), 'the partial file');

    const cancelled = h.ctx.downloads.action(job.id, 'cancel', null);
    expect(cancelled.state).toBe('cancelled');
    // The body may still "finish" afterwards; that must not resurrect the job.
    try {
      bodies[0]!.push('late');
      bodies[0]!.end();
    } catch {
      /* already cancelled by the runner */
    }
    await h.ctx.downloads.idle();

    const after = h.ctx.downloads.find(job.id);
    expect(after.state).toBe('cancelled');
    expect(after.checksumSha256).toBeNull();
    expect(bodies[0]!.cancelled).toBe(true);
    expect(readdirSync(join(h.dataDir, 'partial'))).toEqual([]);
    expect(h.ctx.repos.library.listBlobs()).toEqual([]);
  });

  it('refuses to retry or resume a job that is still running', async () => {
    const { hub: h, bodies } = await setup('http');
    const job = await create(h);
    await waitFor(() => bodies.length === 1, 'the transfer to start');

    for (const action of ['retry', 'resume'] as const) {
      let error: unknown = null;
      try {
        h.ctx.downloads.action(job.id, action, null);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('conflict');
    }
    // Still exactly one writer.
    expect(bodies).toHaveLength(1);

    bodies[0]!.push('done');
    bodies[0]!.end();
    await h.ctx.downloads.idle();
    expect(h.ctx.downloads.find(job.id).state).toBe('completed');
  });

  it('pausing a running job aborts it without the runner overwriting the pause', async () => {
    const { hub: h, bodies } = await setup('http');
    const job = await create(h);
    await waitFor(() => bodies.length === 1, 'the transfer to start');
    bodies[0]!.push('some');
    expect(h.ctx.downloads.action(job.id, 'pause', null).state).toBe('paused');
    await h.ctx.downloads.idle();
    expect(h.ctx.downloads.find(job.id).state).toBe('paused');

    // Resuming starts a fresh transfer.
    h.ctx.downloads.action(job.id, 'resume', null);
    await waitFor(() => bodies.length === 2, 'the resumed transfer');
    bodies[1]!.push('all of it');
    bodies[1]!.end();
    await h.ctx.downloads.idle();
    expect(h.ctx.downloads.find(job.id).state).toBe('completed');
  });
});
