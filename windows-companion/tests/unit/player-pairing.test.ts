import { describe, expect, it } from 'vitest';
import type { HelperStatus } from '../../src/shared/ipc.js';
import { playerHelperAddress } from '../../src/renderer/views/player-pairing.js';

const helper = (patch: Partial<HelperStatus> = {}): HelperStatus => ({
  running: true,
  port: 17342,
  origin: 'http://127.0.0.1:17342',
  reason: null,
  tools: [],
  checkedAt: null,
  busy: false,
  lan: false,
  ...patch,
});

describe('Player helper pairing address', () => {
  it('uses the live Companion address when the helper is running', () => {
    expect(playerHelperAddress(helper({ port: 17345, origin: 'http://127.0.0.1:17345' }), { helperPort: 17342 }))
      .toBe('http://127.0.0.1:17345');
  });

  it('uses the configured port when the helper is not running', () => {
    expect(playerHelperAddress(helper({ running: false, port: null, origin: null }), { helperPort: 18080 }))
      .toBe('http://127.0.0.1:18080');
  });

  it('falls back to the Companion default port', () => {
    expect(playerHelperAddress(null, null)).toBe('http://127.0.0.1:17342');
  });
});
