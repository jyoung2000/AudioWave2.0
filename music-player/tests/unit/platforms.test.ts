/**
 * The platform table is a promise about what the app will and will not do, so it is checked like
 * one: every platform the contracts know about has a row, every row has a mark, no answer is left
 * without a reason, and a hub can only ever make an answer worse.
 *
 * The last of those is the one that matters. If a hub could widen the table, a misconfigured or
 * hostile hub could make the player claim Spotify downloads work.
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_PROVIDERS, type ProviderDescriptor } from '@now-playing/contracts';
import { markFor, PROVIDER_MARKS } from '@now-playing/aqua-ui';
import { PLATFORMS, ROUTE_LABELS, ROUTE_TONE, platform, platformsInOrder, UNCOVERED, withHubReport } from '../../src/lib/platforms.js';

describe('the platform table', () => {
  it('covers every provider the contracts define', () => {
    expect(UNCOVERED).toEqual([]);
    expect(PLATFORMS).toHaveLength(KNOWN_PROVIDERS.length);
  });

  it('has a mark for every platform, and a platform for every mark', () => {
    expect([...Object.keys(PROVIDER_MARKS)].sort()).toEqual([...PLATFORMS.map((p) => p.provider)].sort());
    for (const row of PLATFORMS) expect(markFor(row.provider).glyph).not.toBeNull();
  });

  it('never leaves an answer unexplained', () => {
    for (const row of PLATFORMS) {
      for (const route of [row.play, row.keep, row.save]) {
        expect(route.detail.length, `${row.provider} ${route.state}`).toBeGreaterThan(20);
        expect(ROUTE_LABELS[route.state]).toBeTruthy();
        expect(ROUTE_TONE[route.state]).toBeTruthy();
      }
      expect(row.summary.length).toBeGreaterThan(20);
    }
  });

  it('claims no download from the platforms whose terms forbid one', () => {
    // These two are the whole reason this table exists. Neither may ever read "available".
    expect(platform('spotify')?.save.state).toBe('unsupported');
    expect(platform('spotify')?.keep.state).toBe('unsupported');
    expect(platform('youtube')?.save.state).toBe('unsupported');
    expect(platform('youtube')?.keep.state).toBe('unsupported');
  });

  it('offers a way in for every platform that has one, and says so plainly when there is none', () => {
    // MusicBrainz is a catalogue, so a null here is the honest answer rather than an omission.
    expect(platform('musicbrainz')?.bringIn).toBeNull();
    for (const row of PLATFORMS.filter((p) => p.provider !== 'musicbrainz')) {
      expect(row.bringIn, row.provider).toBeTruthy();
    }
    // The archive route is the one that needs no key and no hub.
    for (const slug of ['bandcamp', 'youtube', 'soundcloud'] as const) {
      expect(platform(slug)?.bringIn).toContain('.zip');
    }
  });

  it('puts what works here without a hub first', () => {
    const order = platformsInOrder().map((p) => p.needsHub);
    expect(order).toEqual([...order].sort((a, b) => Number(a) - Number(b)));
  });
});

describe('what a hub adds', () => {
  const descriptor = (provider: string, overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor =>
    ({
      provider,
      displayName: provider,
      role: 'audio-source',
      authType: 'oauth-pkce',
      authScopes: [],
      groupCompatible: true,
      discordCompatible: false,
      reviewedAt: '2026-09-15',
      limitations: [],
      enabled: true,
      configured: true,
      capabilities: { metadata: 'available', search: 'available', preview: 'available', playback: 'available', importLikes: 'available', importPlaylists: 'available', creatorDownload: 'available', userOwnedDownload: 'available', groupSync: 'exact', eq: 'available' },
      ...overrides,
    }) as ProviderDescriptor;

  it('cannot widen the table, however generous its answers', () => {
    const [spotify] = withHubReport([platform('spotify')!], [descriptor('spotify')]);
    expect(spotify!.save.state).toBe('unsupported');
    expect(spotify!.keep.state).toBe('unsupported');
    expect(spotify!.play.state).toBe('restricted');
  });

  it('narrows it when a provider is switched off or unconfigured', () => {
    const [off] = withHubReport([platform('soundcloud')!], [descriptor('soundcloud', { enabled: false })]);
    expect(off!.play.state).toBe('temporarily_unavailable');
    expect(off!.play.detail).toContain('switched off');

    const [unset] = withHubReport([platform('soundcloud')!], [descriptor('soundcloud', { configured: false })]);
    expect(unset!.play.detail).toContain('not configured');
  });

  it('narrows it when the hub reports a provider is down', () => {
    const live = descriptor('soundcloud');
    const [down] = withHubReport([platform('soundcloud')!], [{ ...live, capabilities: { ...live.capabilities, playback: 'temporarily_unavailable', reason: 'SoundCloud is not answering.' } }]);
    expect(down!.play.state).toBe('temporarily_unavailable');
    expect(down!.play.detail).toBe('SoundCloud is not answering.');
  });

  it('leaves the table alone when there is no hub, or when the hub says nothing about a platform', () => {
    expect(withHubReport(PLATFORMS, null)).toEqual([...PLATFORMS]);
    expect(withHubReport(PLATFORMS, [])).toEqual([...PLATFORMS]);
    const [bandcamp] = withHubReport([platform('bandcamp')!], [descriptor('soundcloud')]);
    expect(bandcamp).toEqual(platform('bandcamp'));
  });
});
