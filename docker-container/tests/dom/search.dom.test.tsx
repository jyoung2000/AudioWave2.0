/**
 * The hub's Search tab, rendered (DEC-039; UX-SEARCH-001…006): the live feed folded as it arrives,
 * every service's state on one line, rows that are music and say where they are, the filter sheet,
 * See All with the next page, a pasted playlist with its mosaic and star, an unreadable link's
 * reason, a song's details and lyrics and its download into the queue, and the Music search settings.
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
    // Eight shown of nine: Harbour Lights came three times (iTunes, Deezer, YouTube) and is one row.
    await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(8));
    expect(within(songs).getAllByRole('option').filter((o) => o.textContent?.startsWith('Harbour Lights'))).toHaveLength(1);
    const services = screen.getByRole('list', { name: 'Services asked' });
    expect(within(services).getByText('iTunes').parentElement?.textContent).toContain('3 found');
    expect(within(services).getByText('SoundCloud').parentElement?.textContent).toMatch(/resting/);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Done: 9 songs, 3 artists, 2 albums. SoundCloud did not answer.'));
    expect(searches[0]).toMatchObject({ fields: { q: 'harbour' }, sections: ['tracks', 'artists', 'albums'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud'] });
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
    // Music only: no row offers to "search on" a site.
    expect(document.body.textContent).not.toMatch(/search on|search youtube|open it on/i);
  });

  it('is a list box: one tab stop, arrows move, Enter opens the song with genre, label, year and synced lyrics', async () => {
    fakeHub(SAVED_EMPTY);
    renderSearch(stockClient().client);
    await searchFor('harbour');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(8));
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
    await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(8));
    await userEvent.click(within(songs).getAllByRole('option')[0]!);
    await screen.findByRole('heading', { name: 'Download to this hub' });
    await userEvent.selectOptions(screen.getByLabelText('Allowed because:'), 'creator-download');
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByText('Queued from YouTube Music. Tagged with ISRC, genre, year and lyrics.')).toBeTruthy();
    const [sent] = hub.sent('POST', '/catalog/download');
    expect(sent!.body).toMatchObject({ track: { id: 'deezer:9101' }, authorization: { basis: 'creator-download', acknowledged: true }, target: { destination: 'hub', format: 'original' } });
  });
});

describe('pages of a section (UX-SEARCH-007)', () => {
  it('pages Songs with numbers, Previous and Next and a count, by pointer or arrow keys, asking the services for the next offset at the end', async () => {
    fakeHub(SAVED_EMPTY);
    const { client, searches } = stockClient();
    renderSearch(client);
    await searchFor('harbour');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Done/));
    const pager = screen.getByRole('navigation', { name: 'Songs pages' });
    expect(within(pager).getByText('Page 1 of 2 or more')).toBeTruthy();
    expect(within(pager).getByRole('button', { name: 'Songs, page 1' }).getAttribute('aria-current')).toBe('page');
    expect((within(pager).getByRole('button', { name: 'Previous page of songs' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(songs).getAllByRole('option')).toHaveLength(8);

    await userEvent.click(within(pager).getByRole('button', { name: 'Songs, page 2' }));
    expect(within(screen.getByRole('listbox', { name: 'Songs' })).getAllByRole('option')).toHaveLength(1);
    // Past what is loaded: the next offset of Songs alone, then its rows join the pages.
    within(pager).getByRole('button', { name: 'Next page of songs' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(searches.at(-1)).toMatchObject({ sections: ['tracks'], offset: 25 }));
    await waitFor(() => expect(within(pager).getByText('Page 2 of 2')).toBeTruthy());
    expect(within(screen.getByRole('listbox', { name: 'Songs' })).getAllByRole('option')).toHaveLength(3);
    within(pager).getByRole('button', { name: 'Songs, page 2' }).focus();
    await userEvent.keyboard('{Home}');
    expect(within(pager).getByText('Page 1 of 2')).toBeTruthy();
    // A page survives opening a song and coming Back.
    await userEvent.keyboard('{End}');
    await userEvent.click(within(screen.getByRole('listbox', { name: 'Songs' })).getAllByRole('option')[0]!);
    await userEvent.click(await screen.findByRole('button', { name: 'Back to Results' }));
    expect(within(await screen.findByRole('navigation', { name: 'Songs pages' })).getByText('Page 2 of 2')).toBeTruthy();
  });
});

describe('the filter and See All (UX-SEARCH-001, UX-SEARCH-002)', () => {
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
    expect(searches[1]).toMatchObject({ sections: ['tracks', 'artists'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube'] });
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Albums' })).toBeNull());
    expect(JSON.parse(window.localStorage.getItem('np.admin.search.filter')!)).toEqual({ sections: ['tracks', 'artists'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube'] });
    expect(screen.getByText(/Showing Songs, Artists from iTunes, Deezer, MusicBrainz, YouTube/)).toBeTruthy();
  });

  it('will not take a filter that shows nothing', async () => {
    fakeHub(SAVED_EMPTY);
    renderSearch(stockClient().client);
    await userEvent.click(screen.getByRole('button', { name: 'Filter…' }));
    const dialog = screen.getByRole('dialog');
    for (const label of ['Songs', 'Artists', 'Albums']) await userEvent.click(within(dialog).getByLabelText(label));
    expect(within(dialog).getByText('Show at least one kind of result.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('See All opens every song and loads the next page without repeating one', async () => {
    fakeHub(SAVED_EMPTY);
    const { client, searches } = stockClient();
    renderSearch(client);
    await searchFor('harbour');
    await screen.findByRole('listbox', { name: 'Songs' });
    await userEvent.click(await screen.findByRole('button', { name: 'See All Songs' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'All Songs' }));
    const all = screen.getByRole('listbox', { name: 'All songs' });
    expect(within(all).getAllByRole('option')).toHaveLength(9);
    await userEvent.click(screen.getByRole('button', { name: 'More Songs' }));
    await waitFor(() => expect(within(all).getAllByRole('option')).toHaveLength(11));
    expect(searches.at(-1)).toMatchObject({ sections: ['tracks'], offset: 25 });
    expect(screen.getByText('That’s everything the services found.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Back to Results' }));
    expect(await screen.findByRole('listbox', { name: 'Songs' })).toBeTruthy();
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
