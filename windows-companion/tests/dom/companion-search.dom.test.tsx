/**
 * The companion's Search tool, rendered (DEC-039; UX-SEARCH-001…007): the same search as the hub's,
 * through the bridge. A search's chunks arrive as `event:catalog-chunk` for the id the window chose
 * and are folded as they come; the services' states, rows that are music and say where they are,
 * pages with numbers, the filter kept in the companion's store, a pasted playlist with its mosaic and
 * star, a song's details and lyrics, and a download through the helper's path.
 *
 * The main process is a fake answering from the stock catalog (packages/aqua-ui/styleguide/fixtures/
 * catalog-stock.json); nothing reaches a network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import stock from '../../../packages/aqua-ui/styleguide/fixtures/catalog-stock.json';
import { SearchView } from '../../src/renderer/views/Search.js';
import type { CompanionBridge } from '../../src/shared/ipc.js';

type Call = { channel: string; request: Record<string, unknown> };

function installBridge(extra: Record<string, (request: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = [];
  const listeners = new Set<(payload: unknown) => void>();
  let saved = stock.saved.items as unknown[];
  let filter = { sections: ['tracks', 'artists', 'albums'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud'] };
  const answers: Record<string, (request: Record<string, unknown>) => unknown> = {
    'catalog:search': async (request) => {
      const q = String(request['q']);
      const chunks = /^https?:/.test(q) ? [{ ...stock.searchLink[0], resolve: q }] : Number(request['offset']) > 0 ? stock.searchPage2 : stock.search;
      for (const chunk of chunks) {
        await Promise.resolve();
        for (const listener of listeners) listener({ searchId: request['searchId'], chunk });
      }
      return { reason: null };
    },
    'catalog:cancel': () => ({ ok: true }),
    'catalog:album': () => ({ result: stock.album, reason: null }),
    'catalog:artist': () => ({ result: stock.artist, reason: null }),
    'catalog:resolve': (request) => ({ result: request['url'] === stock.playlistUrl ? stock.resolvePlaylist : stock.resolveUnsupported, reason: null }),
    'catalog:lyrics': () => ({ result: stock.lyrics, reason: null }),
    'catalog:enrich': () => ({ result: stock.enrich, reason: null }),
    'catalog:saved': () => ({ items: saved }),
    'catalog:unsave': () => {
      saved = [];
      return { items: [] };
    },
    'catalog:save': (request) => {
      saved = [request];
      return { items: saved };
    },
    'catalog:filter': () => filter,
    'catalog:filter:set': (request) => {
      filter = request as typeof filter;
      return filter;
    },
    'catalog:download': (request) => ({ job: { id: 'j1' }, source: (request['track'] as { sources: unknown[] }).sources.find((s) => (s as { platform: string }).platform === 'youtube-music'), reason: null }),
    ...extra,
  };
  const bridge: CompanionBridge = {
    invoke: (async (channel: string, request: unknown) => {
      calls.push({ channel, request: (request ?? {}) as Record<string, unknown> });
      const answer = answers[channel];
      if (!answer) throw new Error(`No fake for ${channel}`);
      return answer((request ?? {}) as Record<string, unknown>);
    }) as CompanionBridge['invoke'],
    on: ((event: string, listener: (payload: unknown) => void) => {
      if (event !== 'event:catalog-chunk') return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    }) as CompanionBridge['on'],
  };
  (window as unknown as { companion?: CompanionBridge }).companion = bridge;
  return { calls, sent: (channel: string) => calls.filter((c) => c.channel === channel) };
}

async function searchFor(text: string): Promise<void> {
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search for music' }), text);
  await userEvent.click(screen.getByRole('button', { name: 'Search' }));
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { companion?: CompanionBridge }).companion;
});

describe('Search in the companion', () => {
  it('folds the chunks the main process passes on, says every service’s state, and shows rows that are music', async () => {
    const bridge = installBridge();
    render(<SearchView />);
    await searchFor('harbour');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(screen.getAllByRole('status').some((s) => s.textContent === 'Done: 9 songs, 3 artists, 2 albums. SoundCloud did not answer.')).toBe(true));
    expect(within(songs).getAllByRole('option')).toHaveLength(8);
    const lights = within(songs).getAllByRole('option')[0]!;
    expect(within(lights).getByLabelText('On Deezer, Apple Music, YouTube Music')).toBeTruthy();
    expect(lights.textContent).toContain('118 BPM');
    expect(within(screen.getByRole('list', { name: 'Services asked' })).getByText('SoundCloud').parentElement?.textContent).toMatch(/resting/);
    expect(screen.getByText('Linked, not searched: Spotify.')).toBeTruthy();
    const [search] = bridge.sent('catalog:search');
    expect(search!.request).toMatchObject({ q: 'harbour', sections: ['tracks', 'artists', 'albums'], offset: 0 });
    expect(String(search!.request['searchId'])).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('pages Songs with numbers and Next, asking for the next offset at the end (UX-SEARCH-007)', async () => {
    const bridge = installBridge();
    render(<SearchView />);
    await searchFor('harbour');
    await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(screen.getAllByRole('status').some((s) => /^Done/.test(s.textContent ?? ''))).toBe(true));
    const pager = screen.getByRole('navigation', { name: 'Songs pages' });
    await userEvent.click(within(pager).getByRole('button', { name: 'Next page of songs' }));
    await userEvent.click(within(pager).getByRole('button', { name: 'Next page of songs' }));
    await waitFor(() => expect(bridge.sent('catalog:search').at(-1)!.request).toMatchObject({ sections: ['tracks'], offset: 25 }));
    await waitFor(() => expect(within(pager).getByText('Page 2 of 2')).toBeTruthy());
  });

  it('keeps the filter in the companion’s store and searches again', async () => {
    const bridge = installBridge();
    render(<SearchView />);
    await searchFor('harbour');
    await screen.findByRole('listbox', { name: 'Albums' });
    await userEvent.click(screen.getByRole('button', { name: 'Filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Filter the search' });
    await userEvent.click(within(dialog).getByLabelText('Albums'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(bridge.sent('catalog:filter:set')[0]!.request).toEqual({ sections: ['tracks', 'artists'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud'] }));
    await waitFor(() => expect(bridge.sent('catalog:search')).toHaveLength(2));
  });

  it('lists a pasted Spotify playlist with its mosaic and platform, opens it, and the star un-stars it', async () => {
    const bridge = installBridge();
    render(<SearchView />);
    await searchFor(stock.playlistUrl);
    const link = await screen.findByRole('listbox', { name: 'The playlist' });
    const row = within(link).getByRole('option');
    expect(row.textContent).toContain('Playlist · Spotify · 6 songs');
    expect(row.querySelectorAll('.art--mosaic img')).toHaveLength(4);
    await userEvent.click(row);
    const songs = await screen.findByRole('listbox', { name: 'Songs in Harbour Mix' });
    for (const option of within(songs).getAllByRole('option')) expect(option.textContent).toMatch(/Spotify\s*plays from YouTube Music via spotDL/);
    const star = await screen.findByRole('button', { name: /Starred playlist/ });
    await userEvent.click(star);
    await waitFor(() => expect(bridge.sent('catalog:unsave')[0]!.request).toEqual({ platform: 'spotify', kind: 'playlist', id: '0MockHarbourMix0000001' }));
    expect(await screen.findByRole('button', { name: /Star this playlist/ })).toBeTruthy();
  });

  it('opens a song with genre, label, year and lyrics, and downloads it through the helper’s path', async () => {
    const bridge = installBridge();
    render(<SearchView />);
    await searchFor('harbour');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(8));
    await userEvent.click(within(songs).getAllByRole('option')[0]!);
    expect(await screen.findByText('Pier Records')).toBeTruthy();
    expect((await screen.findByRole('region', { name: 'Lyrics, timed' })).textContent).toContain('The lamps come on along the quay');
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByText(/Downloading from YouTube Music\. It is saved where Settings ▸ Downloads says/)).toBeTruthy();
    expect(bridge.sent('catalog:download')[0]!.request).toMatchObject({ basis: 'user-owned', track: { id: 'deezer:9101' } });
  });

  it('says the main process’s reason when the helper is not running', async () => {
    installBridge({ 'catalog:search': () => ({ reason: 'The helper isn’t running, so the music services can’t be asked. Check Settings ▸ Network.' }) });
    render(<SearchView />);
    await searchFor('harbour');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The helper isn’t running, so the music services can’t be asked. Check Settings ▸ Network.');
  });
});
