/**
 * The hub's Search tab, rendered (DEC-039; UX-SEARCH-001…012): the live feed folded as it arrives,
 * every service's state on one line, rows that are music and say where they are, the calm overview
 * without a pager, a type's own page (its field, the control, infinite scroll and ‹ › with
 * "Page N of M"), Playlists with the starred ones first, a song row's menu (Up Next into a group's
 * queue, the library, Download…), the filter sheet, a pasted playlist with its mosaic and star, an
 * unreadable link's reason, a song's details and lyrics and its download into the queue, Escape
 * walking back, and the Music search settings.
 *
 * The catalog answers from the stock answers (packages/aqua-ui/styleguide/fixtures/catalog-stock.json),
 * never the network; the saved list, the download and the settings go through a fake hub.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CatalogSearchChunk } from '@now-playing/contracts';
import stock from '../../../packages/aqua-ui/styleguide/fixtures/catalog-stock.json';
import type { CatalogClient, CatalogSearchParams } from '../../src/web/lib/catalog.js';
import { HubUiProvider } from '../../src/web/ui.js';
import { MusicSearchSettingsView } from '../../src/web/views/CatalogSettings.js';
import { SearchView } from '../../src/web/views/Search.js';

type Answer = { status?: number; body: unknown };

function fakeHub(routes: Record<string, Answer>) {
  const calls: Array<{ method: string; path: string; query: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, 'http://hub.test');
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const method = init?.method ?? 'GET';
      calls.push({ method, path, query: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const answer = routes[`${method} ${path}`] ?? { status: 404, body: { detail: 'Not found' } };
      const status = answer.status ?? 200;
      return new Response(JSON.stringify(answer.body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
    }),
  );
  return { calls, sent: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

/** The catalog, answered from the stock: a search, its next page, a pasted link. */
function stockClient() {
  const searches: CatalogSearchParams[] = [];
  const client: CatalogClient = {
    async search(params, onChunk) {
      searches.push(params);
      const chunks = (/^https?:/.test(params.fields.q) ? stock.searchLink : params.offset ? stock.searchPage2 : stock.search) as CatalogSearchChunk[];
      for (const chunk of chunks) {
        await Promise.resolve();
        onChunk(chunk);
      }
    },
    album: async () => stock.album as never,
    artist: async () => stock.artist as never,
    resolve: async (url) => (url === stock.playlistUrl ? stock.resolvePlaylist : stock.resolveUnsupported) as never,
    lyrics: async () => stock.lyrics as never,
    enrich: async () => stock.enrich as never,
  };
  return { client, searches };
}

function renderSearch(client: CatalogClient) {
  return render(
    <HubUiProvider gated={false}>
      {({ sheet, message }) => (
        <>
          <SearchView client={client} />
          {sheet}
          <p data-testid="status-strip">{message}</p>
        </>
      )}
    </HubUiProvider>,
  );
}

const SAVED_EMPTY = { 'GET /catalog/saved': { body: { items: [] } } };

async function searchFor(text: string): Promise<void> {
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search for music' }), text);
  await userEvent.click(screen.getByRole('button', { name: 'Search' }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('the search (UX-SEARCH-001, UX-SEARCH-002)', () => {
  it('folds the live feed by id and says every service’s state, the resting one with when it is back', async () => {
    fakeHub(SAVED_EMPTY);
    const { client, searches } = stockClient();
    renderSearch(client);
    await searchFor('harbour');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    // The overview's five of nine: Harbour Lights came three times (iTunes, Deezer, YouTube) and is one row.
    await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(5));
    expect(within(songs).getAllByRole('option').filter((o) => o.textContent?.startsWith('Harbour Lights'))).toHaveLength(1);
    const services = screen.getByRole('list', { name: 'Services asked' });
    expect(within(services).getByText('iTunes').parentElement?.textContent).toContain('3 found');
    expect(within(services).getByText('SoundCloud').parentElement?.textContent).toMatch(/resting/);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Done: 9 songs, 3 artists, 2 albums, 14 playlists. SoundCloud did not answer.'));
    // Which platforms were searched (the line above) and which only contributed links.
    expect(screen.getByText('Linked, not searched: Spotify.')).toBeTruthy();
    expect(searches[0]).toMatchObject({ fields: { q: 'harbour' }, sections: ['tracks', 'artists', 'albums', 'playlists'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud'] });
  });

  it('puts the Track, Artist and Album fields back into the line when they are closed', async () => {
    fakeHub(SAVED_EMPTY);
    renderSearch(stockClient().client);
    await userEvent.type(screen.getByRole('searchbox'), 'live');
    const toggle = screen.getByRole('button', { name: 'Track, Artist, Album' });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await userEvent.type(screen.getByLabelText('Artist:'), 'Birch Ensemble');
    await userEvent.click(toggle);
    expect(screen.queryByLabelText('Artist:')).toBeNull();
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('live Birch Ensemble');
  });
});

describe('what a row says (UX-SEARCH-003)', () => {
  it('shows cover, title, artist, album, its platforms, BPM, time, the explicit marker and a preview', async () => {
    fakeHub(SAVED_EMPTY);
    renderSearch(stockClient().client);
    await searchFor('harbour');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(within(songs).getAllByRole('option').length).toBeGreaterThan(4));
    const lights = within(songs).getAllByRole('option').find((o) => o.textContent?.startsWith('Harbour Lights'))!;
    expect(lights.querySelector('.art img')).not.toBeNull();
    expect(lights.textContent).toContain('Cassette Bloom · Harbour Lights');
    expect(within(lights).getByLabelText('On Deezer, Apple Music, YouTube Music')).toBeTruthy();
    expect(lights.textContent).toContain('118 BPM');
    expect(lights.textContent).toContain('3:34');
    expect(lights.textContent).toContain('preview');
    const wall = within(songs).getAllByRole('option').find((o) => o.textContent?.startsWith('Harbour Wall'))!;
    expect(wall.textContent).toContain('explicit');
    // The credit line (UX-CAT-006): the store's contributors become "feat. …" when the artist line does not name them.
    expect(wall.textContent).toContain('Cassette Bloom feat. Ada Moss · Harbour Lights');
    // Music only: no row offers to "search on" a site.
    expect(document.body.textContent).not.toMatch(/search on|search youtube|open it on/i);
  });

  it('is a list box: one tab stop, arrows move, Enter opens the song with genre, label, year and synced lyrics', async () => {
    fakeHub(SAVED_EMPTY);
    renderSearch(stockClient().client);
    await searchFor('harbour');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(5));
    songs.focus();
    const first = songs.getAttribute('aria-activedescendant');
    await userEvent.keyboard('{ArrowDown}');
    expect(songs.getAttribute('aria-activedescendant')).not.toBe(first);
    await userEvent.keyboard('{Home}{Enter}');
    const heading = await screen.findByRole('heading', { name: 'Harbour Lights', level: 2 });
    expect(document.activeElement).toBe(heading);
    expect(await screen.findByText('Indie Pop')).toBeTruthy();
    expect(screen.getByText('Pier Records')).toBeTruthy();
    expect(screen.getByText('2026')).toBeTruthy();
    const lyrics = await screen.findByRole('region', { name: 'Lyrics, timed' });
    expect(lyrics.textContent).toContain('0:12 The lamps come on along the quay');
    // Escape is Back, and the results are as they were.
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByRole('listbox', { name: 'Songs' })).toBeTruthy();
  });

  it('downloads a song to the hub’s queue and says which source was chosen and what was embedded', async () => {
    const hub = fakeHub({
      ...SAVED_EMPTY,
      'POST /catalog/download': { status: 201, body: { job: { id: 'j1' }, source: { platform: 'youtube-music', id: 'mockHL0001', url: 'https://music.youtube.com/watch?v=mockHL0001', previewUrl: null, matchedBy: 'search' }, embedded: { isrc: true, genre: true, label: false, year: true, lyrics: true } } },
    });
    renderSearch(stockClient().client);
    await searchFor('harbour');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(5));
    await userEvent.click(within(songs).getAllByRole('option')[0]!);
    await screen.findByRole('heading', { name: 'Download to this hub' });
    await userEvent.selectOptions(screen.getByLabelText('Allowed because:'), 'creator-download');
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByText('Queued from YouTube Music. Tagged with ISRC, genre, year and lyrics.')).toBeTruthy();
    const [sent] = hub.sent('POST', '/catalog/download');
    expect(sent!.body).toMatchObject({ track: { id: 'deezer:9101' }, authorization: { basis: 'creator-download', acknowledged: true }, target: { destination: 'hub', format: 'original' } });
  });
});

describe('the overview and a type’s page (UX-SEARCH-007, UX-SEARCH-009)', () => {
  it('the overview is calm: five songs and three of the rest, each with “See all N”, the services under them, and no pager', async () => {
    fakeHub(SAVED_EMPTY);
    renderSearch(stockClient().client);
    await searchFor('harbour');
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Done/));
    expect(within(screen.getByRole('listbox', { name: 'Songs' })).getAllByRole('option')).toHaveLength(5);
    expect(within(screen.getByRole('listbox', { name: 'Artists' })).getAllByRole('option')).toHaveLength(3);
    expect(within(screen.getByRole('listbox', { name: 'Albums' })).getAllByRole('option')).toHaveLength(2);
    expect(within(screen.getByRole('listbox', { name: 'Playlists' })).getAllByRole('option')).toHaveLength(3);
    for (const name of ['See all 9+ songs', 'See all 3 artists', 'See all 2 albums', 'See all 14 playlists']) expect(screen.getByRole('button', { name })).toBeTruthy();
    // No page numbers, no ‹ ›, no page count anywhere on the overview.
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Page \d+ of/);
    // The services' line sits under the groups.
    const groups = Array.from(document.querySelectorAll('.srch > fieldset'));
    expect(groups.at(-1)!.compareDocumentPosition(screen.getByRole('list', { name: 'Services asked' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('See all opens the Songs page: it reads on at once, ‹ › and Page Up/Down move a page and land on its first row', async () => {
    fakeHub(SAVED_EMPTY);
    const { client, searches } = stockClient();
    renderSearch(client);
    await searchFor('harbour');
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Done/));
    await userEvent.click(screen.getByRole('button', { name: 'See all 9+ songs' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Songs', level: 2 }));
    // Seeded with the overview's nine, then the next offset of Songs alone, at once: one song already shown is dropped.
    await waitFor(() => expect(searches.at(-1)).toMatchObject({ sections: ['tracks'], offset: 25, limit: 25 }));
    const list = screen.getByRole('listbox', { name: 'All songs' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(31));
    expect(screen.getByText('31 songs for “harbour”')).toBeTruthy();
    expect(screen.getByText('That’s all 31 songs.')).toBeTruthy();
    const pager = screen.getByRole('navigation', { name: 'Songs pages' });
    expect(within(pager).getByText('Page 1 of 2')).toBeTruthy();
    expect((within(pager).getByRole('button', { name: 'Previous page of songs' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(list).getAllByRole('option')[25]!.dataset['page']).toBe('2');
    await userEvent.click(within(pager).getByRole('button', { name: 'Next page of songs' }));
    expect(within(pager).getByText('Page 2 of 2')).toBeTruthy();
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute('aria-activedescendant')).toBe(within(list).getAllByRole('option')[25]!.id);
    // Page Up from the list: back to the first page's first row.
    await userEvent.keyboard('{PageUp}');
    await waitFor(() => expect(within(pager).getByText('Page 1 of 2')).toBeTruthy());
    expect(list.getAttribute('aria-activedescendant')).toBe(within(list).getAllByRole('option')[0]!.id);
  });

  it('› past what has arrived fetches that page first, then lands on its first row', async () => {
    fakeHub(SAVED_EMPTY);
    const { client, searches } = stockClient();
    renderSearch(client);
    await searchFor('harbour');
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Done/));
    await userEvent.click(screen.getByRole('button', { name: 'See all 9+ songs' }));
    // The page's own field searches songs alone, from the start, a page of 25 at a time.
    const field = screen.getByRole('searchbox', { name: 'Search songs' });
    expect((field as HTMLInputElement).value).toBe('harbour');
    await userEvent.clear(field);
    await userEvent.type(field, 'harbour lights{Enter}');
    await waitFor(() => expect(searches.at(-1)).toMatchObject({ fields: { q: 'harbour lights' }, sections: ['tracks'], offset: 0, limit: 25 }));
    const pager = await screen.findByRole('navigation', { name: 'Songs pages' });
    await waitFor(() => expect(within(pager).getByText('Page 1 of 1+')).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search songs' }));
    await userEvent.click(within(pager).getByRole('button', { name: 'Next page of songs' }));
    await waitFor(() => expect(searches.at(-1)).toMatchObject({ sections: ['tracks'], offset: 25 }));
    await waitFor(() => expect(within(pager).getByText('Page 2 of 2')).toBeTruthy());
    const list = screen.getByRole('listbox', { name: 'All songs' });
    expect(list.getAttribute('aria-activedescendant')).toBe(within(list).getAllByRole('option')[25]!.id);
  });

  it('the segmented control switches type, searching the new type alone for the same words', async () => {
    fakeHub(SAVED_EMPTY);
    const { client, searches } = stockClient();
    renderSearch(client);
    await searchFor('harbour');
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Done/));
    await userEvent.click(screen.getByRole('button', { name: 'See all 3 artists' }));
    const tabs = screen.getByRole('tablist', { name: 'Kind of music' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Songs', 'Artists', 'Albums', 'Playlists']);
    expect(within(tabs).getByRole('tab', { name: 'Artists' }).getAttribute('aria-selected')).toBe('true');
    within(tabs).getByRole('tab', { name: 'Artists' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(searches.at(-1)).toMatchObject({ fields: { q: 'harbour' }, sections: ['albums'], offset: 0, limit: 12 }));
    expect(await screen.findByRole('heading', { name: 'Albums', level: 2 })).toBeTruthy();
    expect(document.activeElement).toBe(within(screen.getByRole('tablist')).getByRole('tab', { name: 'Albums' }));
    expect(within(await screen.findByRole('tabpanel')).getByRole('listbox', { name: 'All albums' })).toBeTruthy();
  });

  it('Escape walks back a page, then puts the results away', async () => {
    fakeHub(SAVED_EMPTY);
    renderSearch(stockClient().client);
    await searchFor('harbour');
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Done/));
    await userEvent.click(screen.getByRole('button', { name: 'See all 3 artists' }));
    await userEvent.keyboard('{Escape}');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    songs.focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Songs' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search for music' }));
  });
});

describe('Playlists (UX-SEARCH-010)', () => {
  it('Deezer’s public playlists, the starred ones first under “In your library”, and one opens like an album', async () => {
    fakeHub({ 'GET /catalog/saved': { body: stock.saved } });
    const { client } = stockClient();
    const resolved: string[] = [];
    const resolve = client.resolve;
    client.resolve = async (url, offset, limit, signal) => {
      resolved.push(url);
      return resolve(url, offset, limit, signal);
    };
    renderSearch(client);
    await searchFor('harbour');
    const overview = await screen.findByRole('listbox', { name: 'Playlists' });
    await waitFor(() => expect(within(overview).getAllByRole('option')).toHaveLength(3));
    expect(within(overview).getAllByRole('option')[0]!.textContent).toContain('Playlist on Deezer · Playlist Editor · 40 songs');
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Done/));
    await userEvent.click(screen.getByRole('button', { name: 'See all 14 playlists' }));
    const kept = screen.getByRole('listbox', { name: 'Your playlists' });
    expect(within(kept).getByRole('option').textContent).toContain('Harbour Mix');
    expect(screen.getByRole('heading', { name: 'In your library', level: 3 })).toBeTruthy();
    const catalog = screen.getByRole('listbox', { name: 'Playlists from the catalog' });
    expect(within(catalog).getAllByRole('option')).toHaveLength(14);
    expect(within(screen.getByRole('navigation', { name: 'Playlists pages' })).getByText('Page 1 of 2')).toBeTruthy();
    expect(screen.getByText('That’s all 14 playlists.')).toBeTruthy();
    await userEvent.click(within(catalog).getAllByRole('option')[0]!);
    expect(await screen.findByRole('heading', { name: 'Harbour Evenings', level: 2 })).toBeTruthy();
    expect(resolved).toEqual(['https://www.deezer.com/playlist/9401']);
  });
});

describe('a song row’s menu (UX-SEARCH-012)', () => {
  const GROUPS = {
    'GET /groups': {
      body: {
        items: [
          { id: '0192f0c0-0000-7000-8000-000000000001', name: 'Kitchen', status: 'active' },
          { id: '0192f0c0-0000-7000-8000-000000000002', name: 'Studio', status: 'active' },
          { id: '0192f0c0-0000-7000-8000-000000000003', name: 'Old Room', status: 'archived' },
        ],
      },
    },
  };

  async function overviewSongs(): Promise<HTMLElement> {
    await searchFor('harbour');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(5));
    return songs;
  }

  it('“…” opens it; Add to Up Next ▸ a group queues the song’s fetchable source through the group’s requests, and says so', async () => {
    const hub = fakeHub({ ...SAVED_EMPTY, ...GROUPS, 'POST /groups/0192f0c0-0000-7000-8000-000000000002/requests': { body: { queued: true, title: 'Harbour Lights', artistName: 'Cassette Bloom', position: 3, reason: null } } });
    renderSearch(stockClient().client);
    const songs = await overviewSongs();
    const lights = within(songs).getAllByRole('option')[0]!;
    await userEvent.click(lights.querySelector('[data-menu]')!);
    const menu = screen.getByRole('menu', { name: '“Harbour Lights”' });
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Add to Up Next' }).getAttribute('aria-haspopup')).toBe('menu'));
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent?.replace('▶', '').trim())).toEqual(['Add to Up Next', 'Add to Playlist', 'Add to Library…', 'Download…', 'Audition', 'Open Details']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Add to Up Next' }));
    const groups = screen.getByRole('menu', { name: 'Add to Up Next' });
    // Active groups only.
    expect(within(groups).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Kitchen', 'Studio']);
    await userEvent.click(within(groups).getByRole('menuitem', { name: 'Studio' }));
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('status-strip').textContent).toBe('Up Next in Studio: “Harbour Lights”, number 3.'));
    const [sent] = hub.sent('POST', '/groups/0192f0c0-0000-7000-8000-000000000002/requests');
    // The best place the hub can fetch it from: YouTube Music.
    expect(sent!.body).toMatchObject({ query: 'https://music.youtube.com/watch?v=mockHL0001' });
  });

  it('right-click and Shift+F10 open it too; the keys walk it, and Escape gives the keys back to the list', async () => {
    fakeHub({ ...SAVED_EMPTY, ...GROUPS });
    renderSearch(stockClient().client);
    const songs = await overviewSongs();
    await userEvent.pointer({ keys: '[MouseRight]', target: within(songs).getAllByRole('option')[1]! });
    expect(screen.getByRole('menu', { name: '“Harbour Wall”' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(songs);
    // The list is still there: Escape closed the menu, not the results.
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    const menu = screen.getByRole('menu', { name: '“Harbour Wall”' });
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Add to Up Next' }).getAttribute('aria-haspopup')).toBe('menu'));
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[0]);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent?.replace('▶', '')).toBe('Add to Playlist');
    await userEvent.keyboard('{End}');
    expect(document.activeElement?.textContent).toBe('Open Details');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Harbour Wall', level: 2 })).toBeTruthy();
  });

  it('Add to Playlist ▸ lists the hub’s playlists, ticked where the song is, and files it — with the library too, by default (UX-PL-005)', async () => {
    const summary = (id: string, name: string, hasTrack: boolean) => ({ id, name, fileName: `${name}.m3u8`, description: null, createdAt: '2026-10-10T12:00:00.000Z', updatedAt: '2026-10-10T12:00:00.000Z', entryCount: 3, durationSec: 600, covers: [], origin: 'airwave', readOnly: false, createdBy: 'admin', hasTrack });
    const folder = { path: '/data/playlists', relativePath: 'playlists', isDefault: true, available: true, reason: null, playlistCount: 2, capped: false };
    const hub = fakeHub({
      ...SAVED_EMPTY,
      ...GROUPS,
      'GET /playlists': { body: { folder, items: [summary('p1', 'Harbour Nights', true), summary('p2', 'Road Trip', false)] } },
      'POST /playlists/p2/entries': { body: { playlist: summary('p2', 'Road Trip', true), added: 1, skipped: 0 } },
      'POST /playlists': { status: 201, body: summary('p3', 'Fresh', true) },
      'POST /catalog/download': { status: 201, body: { job: { id: 'j1' }, source: { platform: 'youtube-music', id: 'mockHL0001', url: 'https://music.youtube.com/watch?v=mockHL0001', previewUrl: null, matchedBy: 'search' }, embedded: { isrc: true, genre: true, label: false, year: true, lyrics: true } } },
    });
    renderSearch(stockClient().client);
    const songs = await overviewSongs();
    const lights = within(songs).getAllByRole('option')[0]!;
    await userEvent.click(lights.querySelector('[data-menu]')!);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add to Playlist' }));
    const sub = screen.getByRole('menu', { name: 'Add to Playlist' });
    await waitFor(() => expect(within(sub).getAllByRole('menuitemcheckbox').map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([['Harbour Nights', 'true'], ['Road Trip', 'false']]));
    expect(hub.calls.find((c) => c.path === '/playlists')!.query).toContain('catalogId=deezer%3A9101');
    // Already there: said, not added twice.
    await userEvent.click(within(sub).getByRole('menuitemcheckbox', { name: 'Harbour Nights' }));
    expect(screen.getByTestId('status-strip').textContent).toBe('“Harbour Lights” is in “Harbour Nights” already.');
    await userEvent.click(lights.querySelector('[data-menu]')!);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add to Playlist' }));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Road Trip' }));
    let sheet = screen.getByRole('dialog', { name: 'Add “Harbour Lights” to “Road Trip”' });
    expect((within(sheet).getByRole('checkbox', { name: 'Also add to Library' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add to Playlist' }));
    await waitFor(() => expect(screen.getByTestId('status-strip').textContent).toBe('“Harbour Lights” is in “Road Trip” now. It is joining the hub’s library too. Queued from YouTube Music. Tagged with ISRC, genre, year and lyrics.'));
    expect(hub.sent('POST', '/playlists/p2/entries')[0]!.body).toMatchObject({ tracks: [{ id: 'deezer:9101', title: 'Harbour Lights' }] });
    expect(hub.sent('POST', '/catalog/download')[0]!.body).toMatchObject({ authorization: { basis: 'user-owned' } });
    // New Playlist…, with the library left out this time.
    await userEvent.click(lights.querySelector('[data-menu]')!);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add to Playlist' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'New Playlist…' }));
    sheet = screen.getByRole('dialog', { name: 'New Playlist' });
    await userEvent.type(within(sheet).getByLabelText('Name:'), 'Fresh');
    await userEvent.click(within(sheet).getByRole('checkbox', { name: 'Also add to Library' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByTestId('status-strip').textContent).toBe('Made “Fresh” with “Harbour Lights” in it.'));
    expect(hub.sent('POST', '/playlists')[0]!.body).toMatchObject({ name: 'Fresh', tracks: [{ id: 'deezer:9101' }] });
    expect(hub.sent('POST', '/catalog/download')).toHaveLength(1);
  });

  it('Add to Library and Download… go to the hub’s queue with a rights basis', async () => {
    const hub = fakeHub({
      ...SAVED_EMPTY,
      ...GROUPS,
      'POST /catalog/download': { status: 201, body: { job: { id: 'j1' }, source: { platform: 'youtube-music', id: 'mockHL0001', url: 'https://music.youtube.com/watch?v=mockHL0001', previewUrl: null, matchedBy: 'search' }, embedded: { isrc: true, genre: true, label: false, year: true, lyrics: true } } },
    });
    renderSearch(stockClient().client);
    const songs = await overviewSongs();
    const lights = within(songs).getAllByRole('option')[0]!;
    let sheet: HTMLElement;
    await userEvent.click(lights.querySelector('[data-menu]')!);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add to Library…' }));
    sheet = screen.getByRole('dialog', { name: 'Add “Harbour Lights” to the library' });
    await userEvent.selectOptions(within(sheet).getByLabelText('Allowed because:'), 'creator-download');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add to Library' }));
    await waitFor(() => expect(screen.getByTestId('status-strip').textContent).toBe('“Harbour Lights” is joining the hub’s library. Queued from YouTube Music. Tagged with ISRC, genre, year and lyrics. It is in Music ▸ Downloads.'));
    expect(hub.sent('POST', '/catalog/download')[0]!.body).toMatchObject({ track: { id: 'deezer:9101' }, authorization: { basis: 'creator-download', acknowledged: true }, target: { destination: 'hub', format: 'original' } });
    await userEvent.click(lights.querySelector('[data-menu]')!);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Download…' }));
    sheet = screen.getByRole('dialog', { name: 'Download “Harbour Lights”' });
    await userEvent.selectOptions(within(sheet).getByLabelText('Save as:'), 'flac');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(hub.sent('POST', '/catalog/download')).toHaveLength(2));
    expect(hub.sent('POST', '/catalog/download')[1]!.body).toMatchObject({ target: { destination: 'hub', format: 'flac' } });
  });

  it('a song only a store has says there is nothing to fetch; with no group, queueing says it needs one', async () => {
    fakeHub({ ...SAVED_EMPTY, 'GET /groups': { body: { items: [] } } });
    renderSearch(stockClient().client);
    const songs = await overviewSongs();
    const night = within(songs).getAllByRole('option').find((o) => o.textContent?.startsWith('Night Harbour'))!;
    await userEvent.click(night.querySelector('[data-menu]')!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Add to Up Next' }));
    expect(screen.getByTestId('status-strip').textContent).toBe('Queueing needs a group. Make one under Groups, then songs can join its Up Next.');
    await userEvent.click(night.querySelector('[data-menu]')!);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add to Library…' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('status-strip').textContent).toBe('“Night Harbour” is only in a store (Apple Music), so there is nothing the hub can fetch.');
  });

  it('Audition plays the clip and then reads Stop Audition', async () => {
    fakeHub({ ...SAVED_EMPTY, ...GROUPS });
    const played: string[] = [];
    vi.stubGlobal(
      'Audio',
      class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(readonly src: string) {
          played.push(src);
        }
        play = async () => undefined;
        pause = () => undefined;
      },
    );
    renderSearch(stockClient().client);
    const songs = await overviewSongs();
    const lights = within(songs).getAllByRole('option')[0]!;
    await userEvent.click(lights.querySelector('[data-menu]')!);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Audition' }));
    expect(played).toEqual(['https://audio.mockup.invalid/preview/8101.m4a']);
    await userEvent.click(lights.querySelector('[data-menu]')!);
    expect(screen.getByRole('menuitem', { name: 'Stop Audition' })).toBeTruthy();
  });
});

describe('the filter (UX-SEARCH-001, UX-SEARCH-002)', () => {
  it('is a sheet: it takes the focus, Escape puts it away, and Done keeps the choice and searches again', async () => {
    fakeHub(SAVED_EMPTY);
    const { client, searches } = stockClient();
    renderSearch(client);
    await searchFor('harbour');
    await screen.findByRole('listbox', { name: 'Albums' });
    const opener = screen.getByRole('button', { name: 'Filter…' });
    await userEvent.click(opener);
    let dialog = screen.getByRole('dialog', { name: 'Filter the search' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);

    await userEvent.click(opener);
    dialog = screen.getByRole('dialog', { name: 'Filter the search' });
    await userEvent.click(within(dialog).getByLabelText('Albums'));
    await userEvent.click(within(dialog).getByLabelText('SoundCloud'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(searches).toHaveLength(2));
    expect(searches[1]).toMatchObject({ sections: ['tracks', 'artists', 'playlists'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube'] });
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Albums' })).toBeNull());
    expect(JSON.parse(window.localStorage.getItem('np.admin.search.filter')!)).toEqual({ sections: ['tracks', 'artists', 'playlists'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube'] });
    expect(screen.getByText(/Showing Songs, Artists, Playlists from iTunes, Deezer, MusicBrainz, YouTube/)).toBeTruthy();
  });

  it('will not take a filter that shows nothing', async () => {
    fakeHub(SAVED_EMPTY);
    renderSearch(stockClient().client);
    await userEvent.click(screen.getByRole('button', { name: 'Filter…' }));
    const dialog = screen.getByRole('dialog');
    for (const label of ['Songs', 'Artists', 'Albums', 'Playlists']) await userEvent.click(within(dialog).getByLabelText(label));
    expect(within(dialog).getByText('Show at least one kind of result.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('pasted links, albums and the star (UX-SEARCH-004, UX-SEARCH-005)', () => {
  it('lists a pasted Spotify playlist with its platform and a 2×2 mosaic, opens it like an album, and the star un-stars it', async () => {
    const hub = fakeHub({ 'GET /catalog/saved': { body: stock.saved }, 'DELETE /catalog/saved': { body: { items: [] } } });
    renderSearch(stockClient().client);
    await searchFor(stock.playlistUrl);
    const link = await screen.findByRole('listbox', { name: 'The playlist' });
    const row = within(link).getByRole('option');
    expect(row.textContent).toContain('Harbour Mix');
    expect(row.textContent).toContain('Playlist · Spotify · 6 songs');
    expect(row.querySelectorAll('.art--mosaic img')).toHaveLength(4);
    await userEvent.click(row);
    expect(await screen.findByRole('heading', { name: 'Harbour Mix', level: 2 })).toBeTruthy();
    const songs = screen.getByRole('listbox', { name: 'Songs in Harbour Mix' });
    expect(within(songs).getAllByRole('option')).toHaveLength(6);
    for (const option of within(songs).getAllByRole('option')) expect(option.textContent).toMatch(/Spotify\s*plays from YouTube Music via spotDL/);
    const star = await screen.findByRole('button', { name: /Starred playlist/ });
    expect(star.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(star);
    await waitFor(() => expect(screen.getByRole('button', { name: /Star this playlist/ }).getAttribute('aria-pressed')).toBe('false'));
    expect(hub.sent('DELETE', '/catalog/saved')[0]!.query).toBe('?platform=spotify&kind=playlist&id=0MockHarbourMix0000001');
    expect(screen.getByTestId('status-strip').textContent).toBe('“Harbour Mix” is no longer in your library.');
  });

  it('says why a link cannot be read, in words', async () => {
    fakeHub(SAVED_EMPTY);
    const { client } = stockClient();
    client.search = async (_params, onChunk) => onChunk({ ...(stock.searchLink[0] as CatalogSearchChunk & { type: 'done' }), resolve: stock.unsupportedUrl });
    renderSearch(client);
    await searchFor(stock.unsupportedUrl);
    expect(await screen.findByText(/Apple Music playlists are not in Apple’s public API/)).toBeTruthy();
  });

  it('opens an album with its label, date and songs, and stars it into the library', async () => {
    const hub = fakeHub({ ...SAVED_EMPTY, 'PUT /catalog/saved': { body: { items: [] } } });
    renderSearch(stockClient().client);
    await searchFor('harbour');
    const albums = await screen.findByRole('listbox', { name: 'Albums' });
    await waitFor(() => expect(within(albums).getAllByRole('option')).toHaveLength(2));
    await userEvent.click(within(albums).getAllByRole('option').find((o) => o.textContent?.startsWith('Harbour Lights'))!);
    expect(await screen.findByText('Pier Records · 2026-03-14 · 3 songs')).toBeTruthy();
    expect(within(screen.getByRole('listbox', { name: 'Songs on Harbour Lights' })).getAllByRole('option')).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: /Star this album/ }));
    await waitFor(() => expect(hub.sent('PUT', '/catalog/saved')).toHaveLength(1));
    expect(hub.sent('PUT', '/catalog/saved')[0]!.body).toMatchObject({ ref: { platform: 'deezer', kind: 'album', id: '9201', title: 'Harbour Lights' }, trackCount: 3 });
  });

  it('opens an artist with top songs and albums', async () => {
    fakeHub(SAVED_EMPTY);
    renderSearch(stockClient().client);
    await searchFor('harbour');
    const artists = await screen.findByRole('listbox', { name: 'Artists' });
    await waitFor(() => expect(within(artists).getAllByRole('option')).toHaveLength(3));
    await userEvent.click(within(artists).getAllByRole('option')[0]!);
    expect(await screen.findByRole('listbox', { name: 'Top songs by Cassette Bloom' })).toBeTruthy();
    expect(within(screen.getByRole('listbox', { name: 'Albums by Cassette Bloom' })).getAllByRole('option')).toHaveLength(1);
  });
});

describe('Music search settings (UX-SEARCH-006)', () => {
  it('sends only what changed on Save, keeps the SongLink key write-only, and needs one service on', async () => {
    const hub = fakeHub({ 'GET /catalog/settings': { body: stock.settings }, 'PUT /catalog/settings': { body: { ...stock.settings, providers: { ...stock.settings.providers, soundcloud: false }, odesliKeyConfigured: true } } });
    render(
      <HubUiProvider gated={false}>{() => <MusicSearchSettingsView />}</HubUiProvider>,
    );
    const save = await screen.findByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByLabelText(/^SoundCloud/));
    await userEvent.type(screen.getByLabelText('SongLink key:'), 'my-key-123');
    await userEvent.click(save);
    await waitFor(() => expect(hub.sent('PUT', '/catalog/settings')).toHaveLength(1));
    expect(hub.sent('PUT', '/catalog/settings')[0]!.body).toEqual({ providers: { soundcloud: false }, odesliKey: 'my-key-123' });
    // The key is never shown back: the field is empty again and says one is set.
    await waitFor(() => expect((screen.getByLabelText('SongLink key:') as HTMLInputElement).value).toBe(''));

    for (const label of ['iTunes', 'Deezer', 'MusicBrainz', 'YouTube', 'SoundCloud']) await userEvent.click(screen.getByLabelText(new RegExp(`^${label} `)));
    expect(screen.getByText('Leave at least one service on, or search finds nothing.')).toBeTruthy();
  });
});
