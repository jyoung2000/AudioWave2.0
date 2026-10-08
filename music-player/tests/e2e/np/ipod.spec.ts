/**
 * The library button's iPod menu: the root rows, the wheel keys, the drills, the scope chip and
 * the Now Playing home view. Ported from airwave-np tests/ipod.mjs.
 *
 * The original leaned on sixteen built-in rows, a demo history and a `library:state` written
 * straight into kv before a reload. Here the rows are eight WAVs seeded through the app's own
 * import path (two artists, two albums); stars, the queue and playlists are made through the rows
 * and their menu; the history is made by playing rows — so every count below is a count of what
 * was seeded, not of what shipped.
 */
import { expect, test, type Page } from '@playwright/test';
import { addToPlaylist, boot, newPlaylistWith, playRow, queueSong, resetToLibrary, rowIds, seed, star, watchErrors } from './_shell';

type Row = { id: string; title: string; artist: string; album: string };
const byTitle = (rows: Row[], t: string) => rows.find((r) => r.title === t)!.id;

const items = (p: Page) => p.evaluate(() => [...document.querySelectorAll('#ipodMenu .ipod__item')].map((i) => ({
  l: i.querySelector('.ipod__label')!.textContent, c: i.querySelector('.ipod__count')?.textContent,
  sub: !!i.querySelector('.ipod__chev'), on: i.classList.contains('is-on'),
  bg: getComputedStyle(i).backgroundColor })));
const title = (p: Page) => p.textContent('#ipodMenu .ipod__title');
const count = (p: Page) => p.evaluate(() => document.querySelectorAll('#libraryRows tr[data-id]').length);

let errors: string[];
let rows: Row[];

test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await boot(page);
  rows = await seed(page);
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

/** The state the original wrote into kv: two stars, two playlists, a queue of two — made by hand. */
async function buildState(page: Page): Promise<void> {
  await resetToLibrary(page);
  await star(page, 'Harbour Morning'); await star(page, 'Gantry');
  await newPlaylistWith(page, 'Harbour Morning', 'Late Night'); await addToPlaylist(page, 'Blue Hour', 'Late Night');
  await newPlaylistWith(page, 'Slow Carousel', 'Pier 9 Sets');
  await queueSong(page, 'Paper Harbour'); await queueSong(page, 'Closing Hour');
}

test('the menu opens in the list slot with five root rows', async ({ page }) => {
  expect(await page.evaluate(() => document.getElementById('libMenuBtn')!.tagName === 'BUTTON'), 'button is a real control').toBe(true);
  await page.click('#libMenuBtn'); await page.waitForTimeout(250);
  expect((await page.getAttribute('#ipodMenu', 'hidden')) === null && (await page.getAttribute('#libMenuBtn', 'aria-expanded')) === 'true', 'menu opens').toBe(true);
  expect(await page.getAttribute('#library', 'hidden'), 'list is replaced, not covered').not.toBeNull();
  expect(await page.getAttribute('.lib-find', 'hidden'), 'search field stands down').not.toBeNull();
  expect(await page.evaluate(() => {
    const a = document.getElementById('ipodMenu')!.getBoundingClientRect();
    const b = document.querySelector('.lib-scope')!.getBoundingClientRect();
    return Math.abs(a.left - b.left) < 1 && Math.abs(a.right - b.right) < 1 && Math.abs(a.top - b.bottom) < 2; }), 'panel sits in the list slot').toBe(true);
  expect(await title(page), 'title is Library').toBe('Library');
  const root = await items(page);
  expect(root.map((r) => r.l), 'five root rows in order').toEqual(['Now Playing', 'Discover', 'Playlists', 'Artists', 'Albums']);
  expect(root.every((r) => r.c === undefined), 'no counts rendered').toBe(true);
  expect(await page.evaluate(() => !document.querySelector('#ipodMenu .ipod__mark') && !document.querySelector('#ipodMenu .ipod__batt')), 'no mark or battery in the bar').toBe(true);
  expect(root[1]!.bg !== root[0]!.bg && root[1]!.bg === root[3]!.bg, 'rows alternate like the list').toBe(true);
  expect(root.map((r) => r.sub).join(), 'only drill rows carry a chevron').toBe('false,false,true,true,true');
  expect(root[0]!.on, 'first row selected').toBe(true);
});

test('the wheel keys move the highlight, drill into Albums and back out', async ({ page }) => {
  await page.click('#libMenuBtn'); await page.waitForTimeout(250);
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(120);
  expect((await items(page))[1]!.on, 'down moves the highlight').toBe(true);
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.waitForTimeout(120);
  expect((await items(page))[4]!.on, 'up wraps to the end').toBe(true);

  await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  expect(await title(page), 'drills into Albums').toBe('Albums');
  const albums = await items(page);
  // ported: the seed has two albums, as the demo happened to
  expect(albums.map((a) => a.l), 'albums listed').toEqual(['First Light', 'Late Shift']);
  expect(await page.evaluate(() => { const b = document.querySelector('#ipodMenu [data-back]'); return !!b && b.textContent!.trim() === 'Menu'; }), 'Menu back control appears').toBe(true);
  expect(await page.evaluate(() => {
    const bar = document.querySelector('#ipodMenu .ipod__bar')!.getBoundingClientRect();
    const t = document.querySelector('#ipodMenu .ipod__title')!.getBoundingClientRect();
    return Math.abs((t.left + t.right) / 2 - (bar.left + bar.right) / 2) < 1.5; }), 'title stays centred with Menu present').toBe(true);
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(200);
  expect(await title(page), 'MENU backs out to root').toBe('Library');

  // pick an album leaf
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  await page.keyboard.press('Enter'); await page.waitForTimeout(350);
  expect((await page.getAttribute('#ipodMenu', 'hidden')) !== null && (await page.getAttribute('#library', 'hidden')) === null && (await page.getAttribute('.lib-find', 'hidden')) === null, 'leaf applies a focus and returns the list').toBe(true);
  expect((await page.getAttribute('#libScope', 'hidden')) === null && (await page.textContent('#libScopeKind')) === 'Album', 'scope chip shows the album').toBe(true);
  // ported: the first album of the seed has four songs (the demo's had eight)
  expect(await count(page), 'list narrowed to the album').toBe(4);
});

test('Now Playing orders playing > queue > history, Discover excludes starred, playlists drill', async ({ page }) => {
  await buildState(page);
  // the history needs an entry that is neither playing nor queued, and a play is what makes one
  await playRow(page, 'Tideline');
  await playRow(page, 'Gantry');
  await page.click('#libMenuBtn'); await page.waitForTimeout(200);
  await page.click('#ipodMenu .ipod__item[data-i="0"]'); await page.waitForTimeout(350);
  const ids = await rowIds(page);
  expect(ids, 'Now Playing orders playing > queue > history').toEqual([byTitle(rows, 'Gantry'), byTitle(rows, 'Paper Harbour'), byTitle(rows, 'Closing Hour'), byTitle(rows, 'Tideline')]);
  expect(await page.textContent('#libScopeLabel'), 'Now Playing label').toBe('Now Playing');

  await resetToLibrary(page);
  await page.click('#libMenuBtn'); await page.waitForTimeout(200);
  await page.click('#ipodMenu .ipod__item[data-i="1"]'); await page.waitForTimeout(350);
  // ported: the demo had 14 of 16 (two starred). Discover is ranked now (NP-DISC-001): besides the two
  // starred it leaves out what is queued and what was just played (the engine's repeat window), so the
  // count is read from the state rather than assumed.
  const eligible = await page.evaluate(async () => {
    const w = window as unknown as { kv: { get(k: string): Promise<unknown> }; LIBRARY: Array<{ id: string }> };
    const st = ((await w.kv.get('library:state')) ?? {}) as { starred?: Record<string, boolean>; queue?: string[]; plays?: Array<{ id: string }> };
    const played = new Set((st.plays ?? []).map((p) => p.id));
    return w.LIBRARY.filter((s) => !st.starred?.[s.id] && !(st.queue ?? []).includes(s.id) && !played.has(s.id)).length;
  });
  expect(eligible, 'the two starred rows are among those left out').toBeLessThanOrEqual(6);
  expect(await count(page), 'Discover excludes starred, queued and just-played songs').toBe(eligible);

  await resetToLibrary(page);
  await page.click('#libMenuBtn'); await page.waitForTimeout(200);
  await page.click('#ipodMenu .ipod__item[data-i="2"]'); await page.waitForTimeout(250);
  expect((await title(page)) === 'Playlists' && (await items(page)).length === 2, 'playlists listed').toBe(true);
  await page.click('#ipodMenu .ipod__item[data-i="0"]'); await page.waitForTimeout(350);
  expect((await count(page)) === 2 && (await page.textContent('#libScopeKind')) === 'Playlist', 'playlist focus applies').toBe(true);
});

test('an empty queue never disables Now Playing; empty playlists say so; Escape returns focus', async ({ page }) => {
  await page.click('#libMenuBtn'); await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.querySelector('#ipodMenu .ipod__item[data-i="0"]')!.getAttribute('aria-disabled') !== 'true'), 'Now Playing is never disabled').toBe(true);
  await page.click('#ipodMenu .ipod__item[data-i="2"]'); await page.waitForTimeout(250);
  expect(await page.textContent('#ipodMenu .ipod__empty'), 'empty playlists show an empty state').toBe('No playlists yet');
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  expect((await page.getAttribute('#ipodMenu', 'hidden')) !== null && (await page.evaluate(() => document.activeElement!.id === 'libMenuBtn')), 'escape closes and returns focus').toBe(true);
});

test('the chip names a category and the thing picked from it, once each', async ({ page }) => {
  const chipParts = () => page.evaluate(() => [...document.getElementById('libScope')!.querySelectorAll('*')]
    .filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.textContent!.trim()));
  await resetToLibrary(page);
  await star(page, 'Harbour Morning');
  await newPlaylistWith(page, 'Blue Hour', 'Late Night');
  await queueSong(page, 'Paper Harbour');
  for (const [path, name, want] of [
    [[0], 'Now Playing', ['Now Playing']],
    [[1], 'Discover', ['Discover', '✕']],
    [[2, 0], 'Playlist', ['Playlist', 'Late Night', '✕']],
    // ported: the first artist of the seed, alphabetically
    [[3, 0], 'Artist', ['Artist', 'Alder Quartet', '✕']],
  ] as Array<[number[], string, string[]]>) {
    await page.click('#libMenuBtn'); await page.waitForTimeout(220);
    for (const i of path) { await page.click('#ipodMenu .ipod__item[data-i="' + i + '"]'); await page.waitForTimeout(250); }
    expect(await chipParts(), 'chip reads right for ' + name).toEqual(want);
    await resetToLibrary(page);
  }
  expect(await chipParts(), 'label stays at rest').toEqual(['Library']);
  expect(await page.getAttribute('#libScopeClear', 'hidden'), 'no clear badge with nothing narrowed').not.toBeNull();

  expect(await page.evaluate(() => {
    const m = (el: HTMLElement) => { const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const r = document.createRange(); r.selectNodeContents(el); const t = r.getBoundingClientRect();
      return [b.width, b.height, cs.backgroundColor, cs.fontSize, cs.lineHeight, cs.borderRadius, ((t.top + t.bottom) / 2 - (b.top + b.bottom) / 2).toFixed(1)].join('/'); };
    const find = document.getElementById('libFind') as HTMLInputElement;
    find.value = 'a'; find.dispatchEvent(new Event('input', { bubbles: true }));
    const sc = document.getElementById('libScopeClear') as HTMLElement;
    sc.hidden = false;
    const same = m(sc) === m(document.getElementById('libFindClear') as HTMLElement);
    sc.hidden = true;
    return same; }), 'both clear badges are identical').toBe(true);
});

test('playing something must not evict the track it replaced', async ({ page }) => {
  // the home view: Now Playing, with nothing to clear, before anything has been played
  expect(await page.textContent('#libScopeLabel'), 'opens on Now Playing by default').toBe('Now Playing');
  expect(await page.getAttribute('#libScopeClear', 'hidden'), 'home view has no clear badge').not.toBeNull();
  await page.focus('#libFind'); await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  expect(await page.textContent('#libScopeLabel'), 'escape cannot back out of home').toBe('Now Playing');
  // ported: the demo history is gone; the home view's rows are made by playing four rows for real
  await resetToLibrary(page);
  for (const t of ['Tideline', 'Blue Hour', 'Gantry', 'Harbour Morning']) await playRow(page, t);
  await page.click('#libMenuBtn'); await page.waitForTimeout(220);
  await page.click('#ipodMenu .ipod__item[data-i="0"]'); await page.waitForTimeout(350);
  const boot = await rowIds(page);
  expect(boot.length, 'the home view holds what was played').toBe(4);
  await page.click('#libraryRows tr:nth-child(4)'); await page.waitForTimeout(450);
  const after = await rowIds(page);
  expect(after[0], 'played track goes to the front').toBe(boot[3]);
  expect(after.includes(boot[0]!) && after.length === boot.length, 'outgoing track kept in history').toBe(true);
  // clicking the already-active Title column flips it, so accept either run
  await page.click('thead th[data-sort="title"] button'); await page.waitForTimeout(300);
  const t = await page.evaluate(() => [...document.querySelectorAll('#libraryRows .lib-title')].map((e) => e.textContent!));
  const asc = t.slice().sort((a, b) => a.localeCompare(b));
  expect(JSON.stringify(t) === JSON.stringify(asc) || JSON.stringify(t) === JSON.stringify(asc.slice().reverse()), 'a column sort overrides the set order').toBe(true);
  await page.click('#libMenuBtn'); await page.waitForTimeout(220);
  await page.click('#ipodMenu .ipod__item[data-i="0"]'); await page.waitForTimeout(350);
  const ids = await rowIds(page);
  const playing = await page.evaluate(() => (document.querySelector('#libraryRows tr.is-playing') as HTMLElement | null)?.dataset['id']);
  expect(ids[0], 'a new focus drops back to its own order').toBe(playing);
});

test('no column may show a sort arrow while the rows are in set order', async ({ page }) => {
  await resetToLibrary(page);
  await playRow(page, 'Gantry');
  await page.click('#libMenuBtn'); await page.waitForTimeout(220);
  await page.click('#ipodMenu .ipod__item[data-i="0"]'); await page.waitForTimeout(350);
  const hdr = () => page.evaluate(() => [...document.querySelectorAll('thead th[data-sort]')]
    .filter((t) => t.getAttribute('aria-sort') || t.querySelector('.lib-sort')).map((t) => (t as HTMLElement).dataset['sort']));
  expect(await hdr(), 'no sort arrow while in set order').toEqual([]);
  await page.click('thead th[data-sort="artist"] button'); await page.waitForTimeout(300);
  expect(await hdr(), 'arrow appears once a column is chosen').toEqual(['artist']);
});
