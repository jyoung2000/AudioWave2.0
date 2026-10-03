/**
 * The parts of Settings that are decisions rather than screens, each on its own:
 *
 * - the log the app writes, its roll-over, and what Export Logs takes out before anything leaves;
 * - whether a newer companion is out, read from GitHub without a key, and what Download opens;
 * - what kind of connection Windows says this PC is on, and whether streaming may serve on it;
 * - where a finished download is saved, and how big the caches are.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bufferSource, openZip } from '@now-playing/domain/tool-install';
import { exportLogs, Log, redactLog, zipFiles } from '../../src/main/log.js';
import { classifyCost, COST_SCRIPT, streamingDecision } from '../../src/main/network.js';
import { folderBytes, saveDownload } from '../../src/main/storage.js';
import { CompanionStore, openCompanionDb } from '../../src/main/store.js';
import { isNewer, RELEASES_API, RELEASES_PAGE, UpdateChecker, UPDATE_EVERY_MS } from '../../src/main/updates.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'np-settings-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the log', () => {
  it('writes lines to a file, adds debug lines only when detailed logs are on, and rolls over', () => {
    const log = new Log(join(root, 'logs'), { maxBytes: 400, keep: 2, now: () => new Date('2026-10-03T12:00:00Z') });
    log.debug('not kept');
    log.info('kept');
    log.setVerbose(true);
    log.debug('kept too');
    const text = readFileSync(join(root, 'logs', 'companion.log'), 'utf8');
    expect(text).toContain('2026-10-03T12:00:00.000Z INFO  kept');
    expect(text).toContain('DEBUG kept too');
    expect(text).not.toContain('not kept');
    for (let i = 0; i < 40; i += 1) log.info(`line ${i} ${'x'.repeat(30)}`);
    expect(log.files().map((f) => f.split(/[\\/]/).pop())).toEqual(['companion.log', 'companion.1.log', 'companion.2.log']);
  });

  it('takes out secrets, tokens and folder paths before anything leaves this PC', () => {
    const token = 'Zk3q9Lm2Xr7Tp4Wv8Yn1Bc6Df0Gh5Jk2';
    const line = [
      `helper token ${token}`,
      'authorization: Bearer abc.def-ghi',
      'x-helper-token=Q1w2E3r4',
      'key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'saved C:\\Users\\Sam\\Music\\Downloads\\Song.opus',
      'share \\\\nas\\music\\a.flac',
      'tools /home/sam/.local/bin/yt-dlp',
    ].join('\n');
    const clean = redactLog(line, [token], 'C:\\Users\\Sam');
    expect(clean).not.toContain(token);
    expect(clean).not.toContain('abc.def-ghi');
    expect(clean).not.toContain('Q1w2E3r4');
    expect(clean).not.toContain('0123456789abcdef');
    expect(clean).not.toMatch(/Sam|nas\\music|home\/sam/);
    // What a line is about stays readable: the file's name is kept.
    expect(clean).toContain('Song.opus');
    expect(clean).toContain('yt-dlp');
    expect(redactLog('A normal sentence about 3 songs.')).toBe('A normal sentence about 3 songs.');
  });

  it('exports a zip Windows can open, with every file redacted', () => {
    const log = new Log(join(root, 'logs'));
    log.info('the token is SECRET-VALUE-123 and the folder is C:\\Users\\Sam\\Music\\x.flac');
    const target = join(root, 'logs.zip');
    expect(exportLogs(log, target, ['SECRET-VALUE-123'], [{ name: 'about.txt', data: Buffer.from('Airwave Companion 0.1.0\n') }])).toBe(1);
    const zip = openZip(bufferSource(readFileSync(target)));
    expect(zip.entries.map((e) => e.name)).toEqual(['companion.log', 'about.txt']);
    const body = Buffer.from(zip.read(zip.entries[0]!)).toString('utf8');
    expect(body).toContain('[secret]');
    expect(body).not.toContain('SECRET-VALUE-123');
    expect(body).not.toContain('Sam');
    expect(Buffer.from(zip.read(zip.entries[1]!)).toString('utf8')).toBe('Airwave Companion 0.1.0\n');
    // An empty zip is still a zip.
    expect(openZip(bufferSource(zipFiles([]))).entries).toEqual([]);
  });
});

describe('checking for a new companion', () => {
  let store: CompanionStore;
  beforeEach(() => {
    store = new CompanionStore(openCompanionDb(':memory:'));
  });
  afterEach(() => store.close());

  const answer = (status: number, body: unknown) => async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  let asked: Array<{ url: string; headers: Record<string, string> }> = [];
  beforeEach(() => {
    asked = [];
  });

  it('compares versions as numbers, ignoring a leading v and a pre-release label', () => {
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.3')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0-beta.2', '0.1.0')).toBe(false);
    expect(isNewer('0.0.9', '0.1.0')).toBe(false);
    expect(isNewer('nightly', '0.1.0')).toBe(false);
  });

  it('asks the project’s releases without a key, says when a newer one is out, and opens only the release page', async () => {
    let clock = Date.parse('2026-10-03T12:00:00Z');
    const updates = new UpdateChecker({ store, version: '0.1.0', enabled: () => true, log: () => undefined, fetchImpl: answer(200, { tag_name: 'v0.2.0', html_url: 'https://evil.example/download' }) as typeof fetch, now: () => clock });
    expect(updates.due()).toBe(true);
    const status = await updates.check();
    expect(status).toMatchObject({ current: '0.1.0', latest: '0.2.0', available: true, reason: null, enabled: true });
    expect(asked[0]!.url).toBe(RELEASES_API);
    expect(Object.keys(asked[0]!.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    // Whatever the API says the page is, the one that opens is fixed.
    expect(RELEASES_PAGE).toBe('https://github.com/jyoung2000/AudioWave2.0/releases/latest');
    // Once a day at most.
    expect(updates.due()).toBe(false);
    clock += UPDATE_EVERY_MS;
    expect(updates.due()).toBe(true);
  });

  it('says plainly when GitHub has nothing or does not answer, and shows nothing when switched off', async () => {
    const none = new UpdateChecker({ store, version: '0.1.0', enabled: () => true, log: () => undefined, fetchImpl: answer(404, {}) as typeof fetch });
    expect(await none.check()).toMatchObject({ latest: null, available: false, reason: 'No version has been published yet.' });
    const down = new UpdateChecker({
      store,
      version: '0.1.0',
      enabled: () => true,
      log: () => undefined,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    expect((await down.check()).reason).toMatch(/couldn’t be reached/);
    const newer = new UpdateChecker({ store, version: '0.1.0', enabled: () => false, log: () => undefined, fetchImpl: answer(200, { tag_name: '9.0.0' }) as typeof fetch });
    expect((await newer.check()).available).toBe(false);
  });
});

describe('streaming on Wi-Fi and Ethernet, or on metered connections', () => {
  it('reads what Windows says a connection costs', () => {
    expect(classifyCost('Unrestricted|False|False|False\r\n')).toBe('unmetered');
    expect(classifyCost('Fixed|False|False|False')).toBe('metered');
    expect(classifyCost('Variable|False|False|False')).toBe('metered');
    // Roaming, over the limit or mobile broadband is metered, whatever the cost type.
    expect(classifyCost('Unrestricted|True|False|False')).toBe('metered');
    expect(classifyCost('Unrestricted|False|True|False')).toBe('metered');
    expect(classifyCost('Unrestricted|False|False|True')).toBe('metered');
    expect(classifyCost('none')).toBe('offline');
    expect(classifyCost('Unknown|False|False|False')).toBe('unknown');
    expect(classifyCost('')).toBe('unknown');
  });

  it('asks with one fixed script that takes nothing from outside', () => {
    expect(COST_SCRIPT).toContain('GetInternetConnectionProfile()');
    expect(COST_SCRIPT).not.toMatch(/\$args|\$input|Invoke-Expression|iex\b/i);
  });

  it('decides whether streaming may serve, and says why not', () => {
    const both = { unmetered: true, metered: true };
    const homeOnly = { unmetered: true, metered: false };
    const meteredOnly = { unmetered: false, metered: true };
    expect(streamingDecision(both, 'metered')).toEqual({ allowed: true, reason: null });
    expect(streamingDecision(homeOnly, 'unmetered')).toEqual({ allowed: true, reason: null });
    expect(streamingDecision(homeOnly, 'metered').allowed).toBe(false);
    expect(streamingDecision(homeOnly, 'metered').reason).toMatch(/metered connection.*streaming on metered connections is off/);
    expect(streamingDecision(meteredOnly, 'unmetered').reason).toMatch(/Wi-Fi or Ethernet, and streaming on Wi-Fi and Ethernet is off/);
    // A connection Windows could not rate counts as Wi-Fi or Ethernet: a failed look never switches streaming off by itself.
    expect(streamingDecision(homeOnly, 'unknown').allowed).toBe(true);
    expect(streamingDecision(meteredOnly, 'unknown').allowed).toBe(false);
    expect(streamingDecision({ unmetered: false, metered: false }, 'offline').allowed).toBe(true);
  });
});

describe('saving a download, and the cache', () => {
  it('copies a finished download into the chosen folder, numbering a name that is taken', async () => {
    mkdirSync(join(root, 'staging'));
    writeFileSync(join(root, 'staging', 'a.opus'), 'one');
    writeFileSync(join(root, 'staging', 'b.opus'), 'two');
    const dest = join(root, 'Music', 'Downloads');
    const first = await saveDownload([{ name: 'Song: Live?.opus', path: join(root, 'staging', 'a.opus') }], dest);
    const second = await saveDownload([{ name: 'Song: Live?.opus', path: join(root, 'staging', 'b.opus') }], dest);
    expect(first[0]).not.toBe(second[0]);
    expect(second[0]).toMatch(/\(2\)\.opus$/);
    expect(readFileSync(first[0]!, 'utf8')).toBe('one');
    expect(readFileSync(second[0]!, 'utf8')).toBe('two');
    // The name came from a web page: nothing in it may name another folder.
    expect(first[0]!.startsWith(dest)).toBe(true);
  });

  it('measures a folder, and an absent one as empty', async () => {
    mkdirSync(join(root, 'cache', 'deep'), { recursive: true });
    writeFileSync(join(root, 'cache', 'a'), Buffer.alloc(100));
    writeFileSync(join(root, 'cache', 'deep', 'b'), Buffer.alloc(50));
    expect(await folderBytes(join(root, 'cache'))).toBe(150);
    expect(await folderBytes(join(root, 'not-there'))).toBe(0);
  });
});
