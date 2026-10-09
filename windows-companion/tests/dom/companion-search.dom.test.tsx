/**
 * The companion's Search tool, rendered (DEC-039; UX-SEARCH-001…012): the same search as the hub's,
 * through the bridge. A search's chunks arrive as `event:catalog-chunk` for the id the window chose
 * and are folded as they come; the services' states, rows that are music and say where they are, the
 * calm overview, a type's own page with ‹ › and "Page N of M", Playlists with the starred ones first,
 * a song row's menu (Up Next into a paired hub's group, this PC's library), the filter kept in the
 * companion's store, a pasted playlist with its mosaic and star, a song's details and lyrics, and a
 * download through the helper's path.
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
  let filter = { sections: ['tracks', 'artists', 'albums', 'playlists'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud'] };
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
    'hub:groups': () => ({ items: [{ id: '0192f0c0-0000-7000-8000-000000000001', name: 'Kitchen' }], reason: null }),
    'hub:request': () => ({ queued: true, title: 'Harbour Lights', position: 2, reason: null }),
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
    await waitFor(() => expect(screen.getAllByRole('status').some((s) => s.textContent === 'Done: 9 songs, 3 artists, 2 albums, 14 playlists. SoundCloud did not answer.')).toBe(true));
    // The calm overview: five songs (UX-SEARCH-007).
    expect(within(songs).getAllByRole('option')).toHaveLength(5);
    const lights = within(songs).getAllByRole('option')[0]!;
    expect(within(lights).getByLabelText('On Deezer, Apple Music, YouTube Music')).toBeTruthy();
    expect(lights.textContent).toContain('118 BPM');
    // The credit line (UX-CAT-006) and the explicit mark on a song the store lists a contributor for.
    const wall = within(songs).getAllByRole('option').find((o) => o.textContent?.startsWith('Harbour Wall'))!;
    expect(wall.textContent).toContain('Cassette Bloom feat. Ada Moss · Harbour Lights');
    expect(wall.textContent).toContain('explicit');
    expect(within(screen.getByRole('list', { name: 'Services asked' })).getByText('SoundCloud').parentElement?.textContent).toMatch(/resting/);
    expect(screen.getByText('Linked, not searched: Spotify.')).toBeTruthy();
    const [search] = bridge.sent('catalog:search');
    expect(search!.request).toMatchObject({ q: 'harbour', sections: ['tracks', 'artists', 'albums', 'playlists'], offset: 0 });
    expect(String(search!.request['searchId'])).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('the overview has no pager; See all opens the Songs page, which reads on and moves a page at a time (UX-SEARCH-007, UX-SEARCH-009)', async () => {
    const bridge = installBridge();
    render(<SearchView />);
    await searchFor('harbour');
    await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(screen.getAllByRole('status').some((s) => /^Done/.test(s.textContent ?? ''))).toBe(true));
    expect(screen.queryByRole('navigation')).toBeNull();
    for (const name of ['See all 9+ songs', 'See all 3 artists', 'See all 2 albums', 'See all 14 playlists']) expect(screen.getByRole('button', { name })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'See all 9+ songs' }));
    await waitFor(() => expect(bridge.sent('catalog:search').at(-1)!.request).toMatchObject({ sections: ['tracks'], offset: 25, limit: 25 }));
    const list = screen.getByRole('listbox', { name: 'All songs' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(31));
    const pager = screen.getByRole('navigation', { name: 'Songs pages' });
    expect(within(pager).getByText('Page 1 of 2')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search songs' })).toHaveProperty('value', 'harbour');
    expect(within(screen.getByRole('tablist', { name: 'Kind of music' })).getByRole('tab', { name: 'Songs' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.click(within(pager).getByRole('button', { name: 'Next page of songs' }));
    expect(within(pager).getByText('Page 2 of 2')).toBeTruthy();
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute('aria-activedescendant')).toBe(within(list).getAllByRole('option')[25]!.id);
    expect(screen.getByText('That’s all 31 songs.')).toBeTruthy();
  });

  it('Playlists is a type: the starred ones first, then Deezer’s, twelve a page (UX-SEARCH-010)', async () => {
    const bridge = installBridge();
    render(<SearchView />);
    await searchFor('harbour');
    await waitFor(() => expect(screen.getAllByRole('status').some((s) => /^Done/.test(s.textContent ?? ''))).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'See all 14 playlists' }));
    expect(within(screen.getByRole('listbox', { name: 'Your playlists' })).getByRole('option').textContent).toContain('Harbour Mix');
    const catalog = screen.getByRole('listbox', { name: 'Playlists from the catalog' });
    expect(within(catalog).getAllByRole('option')).toHaveLength(14);
    expect(within(screen.getByRole('navigation', { name: 'Playlists pages' })).getByText('Page 1 of 2')).toBeTruthy();
    await userEvent.click(within(catalog).getAllByRole('option')[1]!);
    expect(await screen.findByRole('heading', { name: 'Harbour Lights & Friends', level: 2 })).toBeTruthy();
    expect(bridge.sent('catalog:resolve').at(-1)!.request).toMatchObject({ url: 'https://www.deezer.com/playlist/9402' });
  });

  it('a song row’s “…”: Add to Up Next goes to the paired hub’s group, Add to Library through the helper with a basis (UX-SEARCH-012)', async () => {
    const bridge = installBridge();
    render(<SearchView />);
    await searchFor('harbour');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(5));
    const lights = within(songs).getAllByRole('option')[0]!;
    await userEvent.click(lights.querySelector('[data-menu]')!);
    const menu = screen.getByRole('menu', { name: '“Harbour Lights”' });
    await userEvent.click(await within(menu).findByRole('menuitem', { name: 'Add to Up Next (Kitchen)' }));
    await waitFor(() => expect(bridge.sent('hub:request')[0]!.request).toEqual({ groupId: '0192f0c0-0000-7000-8000-000000000001', query: 'https://music.youtube.com/watch?v=mockHL0001' }));
    await waitFor(() => expect(screen.getAllByRole('status').some((s) => s.textContent === 'Up Next in Kitchen: “Harbour Lights”, number 2.')).toBe(true));
    // Right-click opens the same menu; Add to Playlist says the companion keeps none and offers the library.
    await userEvent.pointer({ keys: '[MouseRight]', target: lights });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add to Playlist…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add to a playlist' });
    expect(sheet.textContent).toContain('The companion keeps no playlists of its own');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add to Library' }));
    await waitFor(() => expect(bridge.sent('catalog:download')[0]!.request).toMatchObject({ basis: 'user-owned', track: { id: 'deezer:9101' } }));
    expect(bridge.sent('catalog:download')[0]!.request).not.toHaveProperty('format');
    await waitFor(() => expect(screen.getAllByRole('status').some((s) => s.textContent?.startsWith('“Harbour Lights” is joining this PC’s library. Downloading from YouTube Music.'))).toBe(true));
  });

  it('with no hub paired, Up Next says plainly that queueing needs a group (UX-SEARCH-012)', async () => {
    installBridge({ 'hub:groups': () => ({ items: [], reason: 'Queueing needs a group on a hub: this companion has no queue of its own. Pair a hub under Remote first.' }) });
    render(<SearchView />);
    await searchFor('harbour');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(5));
    songs.focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Add to Up Next' }));
    await waitFor(() => expect(screen.getAllByRole('status').some((s) => s.textContent === 'Queueing needs a group on a hub: this companion has no queue of its own. Pair a hub under Remote first.')).toBe(true));
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
    await waitFor(() => expect(bridge.sent('catalog:filter:set')[0]!.request).toEqual({ sections: ['tracks', 'artists', 'playlists'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud'] }));
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
    await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(5));
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
