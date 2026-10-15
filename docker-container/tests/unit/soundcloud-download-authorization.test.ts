import { describe, expect, it, vi } from 'vitest';
import { SoundCloudAdapter } from '../../src/providers/adapters/soundcloud.js';
import type { Clock } from '../../src/deps.js';
import type { SafeHttpClient } from '../../src/providers/http.js';

function makeAdapter(downloadable: boolean, downloadsLeft: boolean | null = true) {
  const http = {
    request: vi.fn(async () => ({ status: 200, json: async () => ({ access_token: 'app-token', expires_in: 3600 }) })),
    getJson: vi.fn(async () => ({ id: 123, title: 'Track', downloadable, has_downloads_left: downloadsLeft, user: { username: 'Creator' } })),
  } as unknown as SafeHttpClient;
  const adapter = new SoundCloudAdapter(http, { now: () => 1_000_000 } as Clock);
  adapter.configure({ enabled: true, clientId: 'test-client', clientSecret: 'test-secret', apiKey: null, applicationId: null, redirectUri: null, contactEmail: null, extra: {} });
  return { adapter, http };
}

describe('SoundCloud creator-enabled downloads', () => {
  it('refuses when the creator did not enable downloads or no download remains', async () => {
    const disabled = makeAdapter(false);
    await expect(disabled.adapter.getAuthorizedDownload('123', { actorId: 'device-1', basis: 'creator-download' })).resolves.toBeNull();
    const exhausted = makeAdapter(true, false);
    await expect(exhausted.adapter.getAuthorizedDownload('123', { actorId: 'device-1', basis: 'licensed' })).resolves.toBeNull();
  });

  it('allows only a numeric track ID with an enabled download and a SoundCloud-compatible basis', async () => {
    const { adapter, http } = makeAdapter(true);
    await expect(adapter.getAuthorizedDownload('123', { actorId: 'device-1', basis: 'user-owned' })).resolves.toBeNull();
    const allowed = await adapter.getAuthorizedDownload('123', { actorId: 'device-1', basis: 'creator-download' });
    expect(allowed).toMatchObject({ kind: 'http', url: 'https://api.soundcloud.com/tracks/123/download', basis: 'creator-download' });
    expect(http.getJson).toHaveBeenCalledTimes(1);
  });
});
