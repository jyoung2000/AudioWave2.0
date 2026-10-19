/**
 * An artist's discography, page by page (NP-FIND-004/006, UX-CAT-002).
 *
 * The artist page opens with the first page of albums the catalog gives (`albumsPage`), and offers
 * "Load more albums" while the server says more remain. These tests drive the real search module
 * against the real shell markup (`music-player/index.html`), with the catalog clients stood in for:
 * every artist page asked for is recorded, so what the page asks — and what it shows — is checked,
 * never guessed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CatalogAlbum,
  CatalogArtist,
  CatalogArtistDetail,
  CatalogSearchChunk,
  CatalogTrack,
} from '@now-playing/contracts';

/* ------------------------------------------------------------------ fixtures */

const source = (id: string) => ({
  platform: 'deezer' as const,
  id,
  url: `https://www.deezer.com/album/${id}`,
  previewUrl: null,
  matchedBy: 'search' as const,
});

const album = (n: number): CatalogAlbum => ({
  id: `deezer:al${n}`,
  title: `Album ${n}`,
  artist: 'Lantern Choir',
  artworkUrl: null,
  releaseDate: '2019-05-03',
  year: 2019,
  trackCount: 11,
  label: 'Quay Records',
  genre: 'Folk',
  explicit: null,
  upc: null,
  sources: [source(`al${n}`)],
  rank: 100 - n,
});

const track = (n: number): CatalogTrack => ({
  id: `deezer:t${n}`,
  title: `Song ${n}`,
  artist: 'Lantern Choir',
  artists: ['Lantern Choir'],
  album: 'Night Ferries',
  albumArtist: 'Lantern Choir',
  durationMs: 214_000,
  isrc: null,
  artworkUrl: null,
  releaseDate: '2019-05-03',
  year: 2019,
  trackNumber: n,
  discNumber: 1,
  // A bpm on every song: the browser's Deezer tempo fallback then asks for nothing.
  bpm: 112,
  explicit: false,
  genre: 'Folk',
  artistId: 'deezer:ar1',
  albumId: 'deezer:al1',
  tags: [],
  label: null,
  sources: [source(`t${n}`)],
  rank: 50,
});

const ARTIST: CatalogArtist = {
  id: 'deezer:ar1',
  name: 'Lantern Choir',
  pictureUrl: null,
  albumCount: 60,
  fans: 1200,
  genre: 'Folk',
  sources: [source('ar1')],
  rank: 50,
};

const detail = (
  albums: CatalogAlbum[],
  page: { offset: number; limit: number; hasMore: boolean },
): CatalogArtistDetail => ({
  artist: ARTIST,
  topTracks: [track(1), track(2)],
  albums,
  albumsPage: page,
});

const query = { kind: 'text' as const, text: 'lantern', track: null, artist: null, album: null, isrc: null, url: null };

const chunks = (): CatalogSearchChunk[] => [
  {
    type: 'results',
    seq: 0,
    provider: 'deezer',
    query,
    tracks: [],
    artists: [ARTIST],
    albums: [],
    playlists: [],
    status: [{ provider: 'deezer', state: 'ok', count: 1, latencyMs: 10, error: null, retryAt: null }],
  },
  {
    type: 'done',
    seq: 1,
    query,
    status: [{ provider: 'deezer', state: 'ok', count: 1, latencyMs: 10, error: null, retryAt: null }],
    page: {
      tracks: null,
      artists: { offset: 0, limit: 25, hasMore: false },
      albums: null,
      playlists: null,
    },
    totals: { tracks: 0, artists: 1, albums: 0, playlists: 0 },
    resolve: null,
    linkedOnly: [],
  },
];

/* ----------------------------------------------------------------- the stand-in */

/** Every artist page asked for, in order, and what each answered. */
interface Asked {
  id: string;
  albumsOffset: number | undefined;
}
const asked: Asked[] = [];
/** Answers queued for the artist route, oldest first; an Error is thrown instead of answered. */
let answers: Array<CatalogArtistDetail | Error> = [];
/** Resolves the answer only when released, so "while it is coming" is a real state. */
let hold: { release: () => void; pending: Promise<void> } | null = null;

function fakeClient() {
  return {
    kind: 'hub' as const,
    label: 'the hub TOWER',
    // eslint-disable-next-line @typescript-eslint/require-await
    async *search(): AsyncGenerator<CatalogSearchChunk> {
      for (const c of chunks()) yield c;
    },
    album: (id: string) =>
      Promise.resolve({
        album: album(Number(id.replace('deezer:al', '')) || 1),
        page: { tracks: [track(1)], offset: 0, limit: 100, total: 1, hasMore: false, capped: false },
        collection: {
          platform: 'deezer' as const,
          kind: 'album' as const,
          id: id.replace('deezer:', ''),
          url: `https://www.deezer.com/album/${id}`,
          title: `Album ${id}`,
          owner: null,
        },
      }),

    artist: async (id: string, albumsOffset?: number) => {
      asked.push({ id, albumsOffset });
      if (hold) await hold.pending;
      const next = answers.shift();
      if (!next) throw new Error(`no answer queued for offset ${String(albumsOffset)}`);
      if (next instanceof Error) throw next;
      return next;
    },
    resolve: () => Promise.reject(new Error('not asked here')),
    lyrics: () => Promise.reject(new Error('not asked here')),
    enrich: () => Promise.reject(new Error('not asked here')),
  };
}

vi.mock('../../src/shell/search/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shell/search/client.js')>();
  const client = fakeClient();
  return {
    ...actual,
    clients: async () => [client as unknown as import('../../src/shell/search/client.js').CatalogClient],
    ask: async <T>(work: (c: unknown) => Promise<T>) => ({ value: await work(client), client }),
    jsonp: () => Promise.reject(new Error('the browser engine is not asked here')),
    legacyHubSearch: () => Promise.resolve([]),
  };
});

/* --------------------------------------------------------------------- harness */

const SHELL = resolve(process.cwd(), 'music-player/index.html');
const shellHtml = readFileSync(SHELL, 'utf8');

const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const $ = <E extends HTMLElement>(id: string): E => document.getElementById(id) as E;
const body = (): HTMLElement => $('srchBody');
const moreBtn = (): HTMLButtonElement | null =>
  body().querySelector<HTMLButtonElement>('[data-act="albums-more"]');
const retryBtn = (): HTMLButtonElement | null =>
  body().querySelector<HTMLButtonElement>('[data-act="albums-retry"]');
const albumRows = (): string[] =>
  [...body().querySelectorAll<HTMLElement>('.srch__row--album .srch__title')].map(
    (el) => el.textContent ?? '',
  );

async function install(): Promise<void> {
  const doc = new DOMParser().parseFromString(shellHtml, 'text/html');
  for (const id of ['searchBox', 'srchFilter']) {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`the shell has no #${id}`);
    document.body.append(document.importNode(node, true));
  }
  const mod = await import('../../src/shell/search/index.js');
  mod.installSearch();
}

/** Search, then open the artist row: the artist page, with its first page of albums. */
async function openArtist(): Promise<void> {
  const input = $<HTMLInputElement>('q');
  input.value = 'lantern';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  const row = body().querySelector<HTMLElement>('.srch__row--artist');
  if (!row) throw new Error(`no artist row to open; the body is ${body().innerHTML.slice(0, 400)}`);
  row.click();
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  asked.length = 0;
  answers = [];
  hold = null;
  document.body.innerHTML = '';
  const w = window as unknown as Record<string, unknown>;
  const store = new Map<string, unknown>();
  w['kv'] = {
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    set: (k: string, v: unknown) => void store.set(k, v),
  };
  delete w['NP_HUB_SHELF'];
  delete w['NP_DISC_ONLINE'];
  delete w['NP_VISIT'];
  delete w['COMPANION'];
  w['say'] = () => undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ----------------------------------------------------------------------- tests */

describe("an artist's discography pages on request", () => {
  it('offers Load more albums only while the catalog says more remain, and asks from the server page', async () => {
    answers = [detail([album(1), album(2)], { offset: 0, limit: 2, hasMore: true })];
    await install();
    await openArtist();

    expect(albumRows()).toEqual(['Album 1', 'Album 2']);
    const btn = moreBtn();
    expect(btn, 'the action is offered while more albums remain').not.toBeNull();
    expect(btn!.textContent).toContain('Load more albums');
    expect(btn!.getAttribute('aria-label') ?? btn!.textContent).toContain('album');

    answers = [detail([album(3), album(4)], { offset: 2, limit: 2, hasMore: false })];
    btn!.click();
    await flush();

    // The second ask uses the server's own offset + limit, not a row count.
    expect(asked.map((a) => a.albumsOffset)).toEqual([undefined, 2]);
    expect(albumRows(), 'the page that came sits under the rows already there').toEqual([
      'Album 1',
      'Album 2',
      'Album 3',
      'Album 4',
    ]);
    expect(moreBtn(), 'nothing more remains: no action').toBeNull();
    expect(body().querySelector('.srch__end')?.textContent).toContain('4 albums');
    expect($('srchLive').textContent).toContain('albums');
  });

  it('shows an album brought twice once, and still advances by the server page', async () => {
    answers = [detail([album(1), album(2)], { offset: 0, limit: 2, hasMore: true })];
    await install();
    await openArtist();

    // The next page repeats Album 2 (two services, one release) and brings one new album.
    answers = [detail([album(2), album(3)], { offset: 2, limit: 2, hasMore: true })];
    moreBtn()!.click();
    await flush();

    expect(albumRows()).toEqual(['Album 1', 'Album 2', 'Album 3']);

    answers = [detail([album(4)], { offset: 4, limit: 2, hasMore: false })];
    moreBtn()!.click();
    await flush();

    // Three rows were kept, but the third ask is from offset 4: the deduped count never moves it.
    expect(asked.map((a) => a.albumsOffset)).toEqual([undefined, 2, 4]);
    expect(albumRows()).toEqual(['Album 1', 'Album 2', 'Album 3', 'Album 4']);
  });

  it('says a page is coming and cannot be asked twice over', async () => {
    answers = [detail([album(1)], { offset: 0, limit: 1, hasMore: true })];
    await install();
    await openArtist();

    let release = (): void => undefined;
    hold = {
      pending: new Promise<void>((r) => {
        release = r;
      }),
      release: () => release(),
    };
    answers = [detail([album(2)], { offset: 1, limit: 1, hasMore: false })];
    const btn = moreBtn()!;
    btn.focus();
    btn.click();
    await flush();

    const busy = moreBtn();
    expect(busy, 'the control stays where it was').not.toBeNull();
    expect(busy!.getAttribute('aria-disabled'), 'and is not pressable while it works').toBe('true');
    expect(busy!.getAttribute('aria-busy')).toBe('true');
    expect(busy!.textContent).toContain('Loading more albums');
    expect(document.activeElement, 'the keyboard is not dropped by the redraw').toBe(busy);
    expect($('srchLive').textContent).toContain('Loading more albums');
    // A second press while it works asks for nothing more.
    busy!.click();
    await flush();
    expect(asked.length).toBe(2);

    hold.release();
    hold = null;
    await flush();
    expect(albumRows()).toEqual(['Album 1', 'Album 2']);
    expect(moreBtn()).toBeNull();
    expect(
      document.activeElement === $('q') || document.activeElement === document.body,
      'with nothing left to press, focus leaves the gone control',
    ).toBe(true);
  });

  it('a page that fails keeps the albums, says why, and Try again asks the same page again', async () => {
    answers = [detail([album(1), album(2)], { offset: 0, limit: 2, hasMore: true })];
    await install();
    await openArtist();

    const { Refused } = await import('../../src/shell/search/client.js');
    answers = [new Refused('Deezer answered 429: too many requests.')];
    const btn = moreBtn()!;
    btn.focus();
    btn.click();
    await flush();

    expect(albumRows(), 'the albums already shown stay').toEqual(['Album 1', 'Album 2']);
    expect(body().textContent).toContain('too many requests');
    expect($('srchLive').textContent).toContain('too many requests');
    const again = retryBtn();
    expect(again, 'a failure offers the page again').not.toBeNull();
    expect(document.activeElement, 'the keyboard lands on the way to retry').toBe(again);

    answers = [detail([album(3)], { offset: 2, limit: 2, hasMore: false })];
    again!.click();
    await flush();

    expect(asked.map((a) => a.albumsOffset), 'the same offset is asked again').toEqual([
      undefined,
      2,
      2,
    ]);
    expect(albumRows()).toEqual(['Album 1', 'Album 2', 'Album 3']);
    expect(retryBtn()).toBeNull();
  });

  it('is honest at the catalog’s offset cap: it stops, says so, and asks for nothing past it', async () => {
    // The contract pages an artist's albums to albumsOffset 500 (CatalogArtistRequest): offset 500
    // is the last page it can answer, and the page after it could only be asked past the bound.
    answers = [detail([album(1)], { offset: 500, limit: 25, hasMore: true })];
    await install();
    await openArtist();

    expect(moreBtn(), 'the last page the catalog can answer offers no more').toBeNull();
    const end = body().querySelector('.srch__end')?.textContent ?? '';
    expect(end).toContain('500');
    expect(asked.length, 'nothing is asked past the cap').toBe(1);
  });

  it('still asks for the last page the cap allows', async () => {
    // offset 475 + limit 25 lands exactly on 500: askable, so the action is still offered.
    answers = [detail([album(1)], { offset: 475, limit: 25, hasMore: true })];
    await install();
    await openArtist();

    expect(moreBtn(), 'offset 500 is within the catalog’s bound').not.toBeNull();
    answers = [detail([album(2)], { offset: 500, limit: 25, hasMore: true })];
    moreBtn()!.click();
    await flush();

    expect(asked.map((a) => a.albumsOffset)).toEqual([undefined, 500]);
    expect(albumRows()).toEqual(['Album 1', 'Album 2']);
    expect(moreBtn(), 'and the page after it is past the bound').toBeNull();
    expect(body().querySelector('.srch__end')?.textContent).toContain('500');
  });

  it('keeps every album loaded when an album is opened and Back comes back', async () => {
    answers = [detail([album(1)], { offset: 0, limit: 1, hasMore: true })];
    await install();
    await openArtist();
    answers = [detail([album(2)], { offset: 1, limit: 1, hasMore: false })];
    moreBtn()!.click();
    await flush();
    expect(albumRows()).toEqual(['Album 1', 'Album 2']);

    const before = asked.length;
    const row = body().querySelector<HTMLElement>('.srch__row--album');
    row!.click();
    await flush();
    expect(body().textContent, 'the album page opened over the artist').toContain('Album 1');

    $('srchBack').click();
    await flush();

    expect(albumRows(), 'Back finds the whole discography it left').toEqual(['Album 1', 'Album 2']);
    expect(asked.length, 'coming back asks the artist for nothing again').toBe(before);
  });
});
