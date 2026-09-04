/**
 * Outbound-request safety and the download authorization gate.
 *
 * The download tests encode the project's legal posture: a stream is not a download, an
 * authorization basis has to be one the adapter actually agrees with, and no adapter is permitted
 * to bypass a provider's terms. If someone later "helpfully" makes a download succeed where these
 * expect a refusal, these tests fail — which is the point.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateOutboundUrl } from '@now-playing/domain';
import { createTestHub, FULL_FFMPEG, pairDevice, type TestHub } from '../helpers/hub.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };
let device: { deviceId: string; authorization: string };

beforeEach(async () => {
  hub = await createTestHub({ ffmpeg: FULL_FFMPEG });
  admin = await hub.completeSetup();
  device = await pairDevice(hub, admin);
});

afterEach(async () => {
  await hub.dispose();
});

describe('SSRF guard', () => {
  it('rejects private, loopback, link-local and metadata addresses', () => {
    const blocked = [
      'http://127.0.0.1/admin',
      'http://localhost:4546/api/v1/hub',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://0.0.0.0/',
    ];
    for (const url of blocked) {
      const result = validateOutboundUrl(url, { allowedHosts: ['example.com'] });
      expect(result.ok, `${url} must be blocked`).toBe(false);
    }
  });

  it('rejects non-http schemes outright', () => {
    for (const url of ['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/x', 'data:text/plain,hi']) {
      expect(validateOutboundUrl(url, { allowedHosts: ['example.com'] }).ok, url).toBe(false);
    }
  });

  it('rejects a host that is not on the allowlist', () => {
    expect(validateOutboundUrl('https://evil.example/x', { allowedHosts: ['api.spotify.com'] }).ok).toBe(false);
    expect(validateOutboundUrl('https://api.spotify.com/v1/me', { allowedHosts: ['api.spotify.com'] }).ok).toBe(true);
  });

  it('rejects a lookalike host that merely ends with an allowed name', () => {
    expect(validateOutboundUrl('https://evil-api.spotify.com.attacker.example/x', { allowedHosts: ['api.spotify.com'] }).ok).toBe(false);
  });

  it('refuses to resolve a pasted link to a host no provider claims', async () => {
    const response = await hub.app.inject({ method: 'GET', url: `/api/v1/providers/resolve?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`, headers: { authorization: device.authorization } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain('meta-data');
  });
});

describe('download authorization', () => {
  it('refuses a download the provider does not permit, and says why', async () => {
    await hub.app.inject({
      method: 'PUT',
      url: '/api/v1/providers/youtube/config',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { enabled: true, apiKey: 'test-api-key' },
    });
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/downloads',
      headers: { authorization: device.authorization },
      payload: {
        source: { provider: 'youtube', providerTrackId: 'dQw4w9WgXcQ', url: null, locator: null, title: null, artistName: null },
        authorization: { basis: 'user-owned', acknowledged: true },
        target: { destination: 'hub', format: 'original' },
      },
    });
    expect(response.statusCode).toBe(403);
    // The message must explain the rule rather than reading as a bug.
    expect(String((response.json() as { detail: string }).detail)).toMatch(/does not permit downloading|A stream is not a download/i);
  });

  it('refuses a download from a provider that is disabled', async () => {
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/downloads',
      headers: { authorization: device.authorization },
      payload: {
        source: { provider: 'external-tool', providerTrackId: 'x', url: null, locator: null, title: null, artistName: null },
        authorization: { basis: 'user-owned', acknowledged: true },
        target: { destination: 'hub', format: 'original' },
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('requires the downloads:request scope', async () => {
    const limited = await pairDevice(hub, admin, { name: 'No downloads', scopes: ['library:read', 'search:use'] });
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/downloads',
      headers: { authorization: limited.authorization },
      payload: {
        source: { provider: 'hub', providerTrackId: 'x', url: null, locator: null, title: null, artistName: null },
        authorization: { basis: 'user-owned', acknowledged: true },
        target: { destination: 'hub', format: 'original' },
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('reports format availability from the installed FFmpeg rather than a fixed list', async () => {
    const withFfmpeg = await hub.app.inject({ method: 'GET', url: '/api/v1/downloads/formats', headers: { authorization: device.authorization } });
    const formats = (withFfmpeg.json() as { formats: Array<{ format: string; available: boolean; lossy: boolean; reason: string | null }> }).formats;
    expect(formats.find((f) => f.format === 'mp3')).toMatchObject({ available: true, lossy: true });
    expect(formats.find((f) => f.format === 'original')).toMatchObject({ available: true, lossy: false });

    const bare = await createTestHub();
    try {
      const bareAdmin = await bare.completeSetup();
      const bareDevice = await pairDevice(bare, bareAdmin);
      const response = await bare.app.inject({ method: 'GET', url: '/api/v1/downloads/formats', headers: { authorization: bareDevice.authorization } });
      const bareFormats = (response.json() as { formats: Array<{ format: string; available: boolean; reason: string | null }> }).formats;
      // Without FFmpeg only a byte-for-byte copy is possible, and the UI is told exactly why.
      expect(bareFormats.find((f) => f.format === 'original')?.available).toBe(true);
      expect(bareFormats.find((f) => f.format === 'mp3')).toMatchObject({ available: false, reason: expect.stringContaining('FFmpeg') });
    } finally {
      await bare.dispose();
    }
  });
});

describe('external tool provider', () => {
  it('is disabled by default and reports what the administrator must do', async () => {
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/providers', headers: { authorization: device.authorization } });
    const descriptors = (response.json() as { items: Array<{ provider: string; enabled: boolean; configured: boolean; limitations: string[] }> }).items;
    const tool = descriptors.find((d) => d.provider === 'external-tool');
    expect(tool).toBeDefined();
    expect(tool?.enabled).toBe(false);
    expect(tool?.limitations.join(' ')).toMatch(/administrator must install/i);
    expect(tool?.limitations.join(' ')).toMatch(/no cookies/i);
  });
});
