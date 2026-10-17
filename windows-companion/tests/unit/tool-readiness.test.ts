import { describe, expect, it } from 'vitest';
import { EmbeddedHelper } from '../../src/main/helper.js';

describe('Companion tool setup status', () => {
  it.each([
    [false, 'ready', 'failed'],
    [false, 'installing', 'installing'],
    [false, 'failed', 'failed'],
    [true, 'ready', 'ready'],
  ] as const)('present=%s setup=%s reports %s', (present, state, expected) => {
    // No Electron, credentials, disk, or subprocesses: exercise the IPC status merge itself.
    const embedded = new EmbeddedHelper({} as ConstructorParameters<typeof EmbeddedHelper>[0]);
    Object.assign(embedded, {
      tools: [{ id: 'yt-dlp', present, version: present ? '2026.08.19' : null, path: null, advice: null, origin: present ? 'installed' : 'missing' }],
      helper: { origin: 'http://127.0.0.1:17342', jobs: { busy: () => false }, tools: { status: () => ({ 'yt-dlp': state === 'failed' ? { state, reason: 'disk full' } : { state } }) } },
    });
    expect(embedded.status().tools[0]?.setup?.state).toBe(expected);
  });
});
