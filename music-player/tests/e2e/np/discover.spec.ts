/**
 * The Statistics and Recommendations panes as the Discover design draws them: what is measured, how
 * it is compared, and the saved algorithms. Ported from airwave-np tests/discover.mjs.
 *
 * What changed: the original played demo rows under a fake clock (`page.clock.runFor`) and read the
 * seconds back from `library:state.plays`. The shell's transport counts real playing seconds from
 * the audio engine, which a fake clock does not advance, so the seeded WAVs are played in real time —
 * one left after about four seconds, one short file played to its end. The period comparison wrote a
 * play log naming demo ids (`song-1`…); here it names the ids of the seeded rows (a play whose song
 * is not in the library is not counted), written through `window.kv` and read back after a reload.
 * The shelf leg recommends from the eight seeded rows, so it records at most eight, not ten.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, reload, resetToLibrary, row, seed, SEED, statsReady, stubOffline, watchErrors, type SeedTrack } from './_shell';

const DAY = 864e5;
type Play = { id: string; at: number; via?: string; secs?: number; dur?: number; end?: boolean };
type LibState = { plays?: Play[]; recShown?: Array<{ id: string; at: number }>; acts?: unknown[] } | null;
type KvWin = { kv: { get(k: string): Promise<unknown>; set(k: string, v: unknown): void } };
const state = (p: Page) => p.evaluate(async () => ((await (window as unknown as KvWin).kv.get('library:state')) as LibState) ?? {});
const plays = async (p: Page) => ((await state(p)) as NonNullable<LibState>).plays ?? [];
const pickName = (p: Page) => p.$eval('#algoPick', (n) => (n as HTMLSelectElement).selectedOptions[0]?.textContent ?? '');
const setRange = (p: Page, id: string, v: number) => p.evaluate(([id, v]) => {
  const el = document.getElementById(id as string) as HTMLInputElement;
  el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true }));
}, [id, v] as const);

let errors: string[];
test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { errors = watchErrors(page); await stubOffline(page); });
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test('a track’s seconds are measured, not assumed', async ({ page }) => {
  // ported: real time instead of page.clock; the third file is short enough to finish under the test
  const tracks: SeedTrack[] = [
    { file: '01 Long One.wav', title: 'Long One', artist: 'Alder Quartet', album: 'First Light' },
    { file: '02 Long Two.wav', title: 'Long Two', artist: 'Alder Quartet', album: 'First Light' },
    { file: '03 Short Three.wav', title: 'Short Three', artist: 'Alder Quartet', album: 'First Light', seconds: 4 },
  ];
  await boot(page);
  const rows = await seed(page, tracks);
  const id = (t: string) => rows.find((r) => r.title === t)!.id;
  await page.click('#mode [data-mode="solo"]'); await page.waitForTimeout(200);
  await resetToLibrary(page);
  await row(page, 'Long One').click();
  await page.waitForTimeout(4200);
  await row(page, 'Long Two').click();
  await page.waitForTimeout(600);
  let log = await plays(page);
  const first = [...log].reverse().find((r) => r.id === id('Long One'));
  expect(!!first && first.secs! >= 3 && first.secs! <= 5.5 && !first.end, 'a track left after four seconds is logged as about four seconds heard: ' + JSON.stringify(first)).toBe(true);
  const last = log[log.length - 1]!;
  expect(last.via === 'nowplaying' || last.via === 'library', 'and where it was started from: ' + last.via).toBe(true);

  await row(page, 'Short Three').click();
  const len = 4;
  await expect.poll(async () => {
    log = await plays(page);
    return [...log].reverse().find((r) => r.id === id('Short Three'))?.end ?? false;
  }, { message: 'the short file plays to its end', timeout: 15_000 }).toBe(true);
  const whole = [...log].reverse().find((r) => r.id === id('Short Three'))!;
  expect(whole.secs! >= len - 1, 'a track played through is logged as heard to the end: ' + JSON.stringify(whole)).toBe(true);
});

test('statistics against the period before, and the recommendation funnel', async ({ page }) => {
  await boot(page);
  const rows = await seed(page, SEED);
  const ids = rows.map((r) => r.id);
  // ported: the log names the seeded rows' ids, not demo ids; the shape and the numbers are the original's
  await page.evaluate(async ([ids, DAY]) => {
    const now = Date.now(), pl: Play[] = [];
    const idOf = (n: number) => (ids as string[])[(n - 1) % (ids as string[]).length]!;
    // this week: 6 plays, 4 heard through; the week before: 3 plays, 3 heard through
    for (let i = 0; i < 6; i++) pl.push({ id: idOf(1 + i), at: now - (i + 1) * 3600e3, via: i < 3 ? 'discover' : 'artist', secs: i < 4 ? 200 : 3, dur: 200, end: i < 4 });
    for (let i = 0; i < 3; i++) pl.push({ id: idOf(9 + i), at: now - (8 + i) * (DAY as number), via: 'artist', secs: 200, dur: 200, end: true });
    pl.sort((a, b) => a.at - b.at);
    const shown = [1, 2, 3, 7].map((n) => ({ id: idOf(n), at: now - 5 * 3600e3 }));
    const w = window as unknown as KvWin;
    const cur = ((await w.kv.get('library:state')) as Record<string, unknown>) ?? {};
    w.kv.set('library:state', { ...cur, plays: pl, recShown: shown, acts: [{ a: 'favorite', id: idOf(1), at: now - 60e3 }] });
    await new Promise((r) => setTimeout(r, 300));
  }, [ids, DAY] as const);
  expect((await plays(page)).length, 'the play log round-trips through kv').toBe(9);
  await reload(page);
  await boot(page, '#settings/stats'); await statsReady(page);
  await page.click('#cScope [data-scope="music"]'); await page.waitForTimeout(300);
  await page.click('#cRange [data-range="7"]'); await page.waitForTimeout(400);
  const tiles = await page.$$eval('#pp-stats .stat__tile', (n) => n.map((x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim()));
  expect(tiles[0]!.replace(/ /g, '').includes('6plays') && tiles[0]!.includes('▲ 100%') && tiles[0]!.includes('on the period before'), 'plays against the week before: ' + tiles[0]).toBe(true);
  expect(tiles[2]!.includes('67%') && tiles[2]!.includes('▼ 33 pts'), 'heard to the end, and the drop from 100%: ' + tiles[2]).toBe(true);
  expect(await page.$$('#pp-stats .stat__tile:nth-child(3) .dn'), 'a drop in finishing is coloured as bad news').toHaveLength(1);
  expect(tiles[3]!.includes('33%') && tiles[3]!.includes('skipped early'), 'skips inside the engine’s own threshold: ' + tiles[3]).toBe(true);
  expect(tiles[7]!.includes('50%') && tiles[7]!.includes('recommendations'), 'half the plays started from Discover: ' + tiles[7]).toBe(true);
  const fun = (await page.textContent('#recFunnel')) ?? '';
  expect(/Recommended\s*4/.test(fun) && /Started\s*3 · 75%/.test(fun), 'the funnel counts what the shelf showed and what was started: ' + fun).toBe(true);
  expect(/Added or favourited\s*1 · 25%/.test(fun), 'and what was kept afterwards').toBe(true);
  await page.click('#cRange [data-range="0"]'); await page.waitForTimeout(300);
  expect(await page.textContent('#pp-stats .stat__tile'), 'all time has no period before, and does not pretend to').not.toContain('period before');
});

test('the shelf records what it shows, and plays from it count', async ({ page }) => {
  await boot(page);
  await seed(page);
  await page.click('#libMenuBtn'); await page.waitForTimeout(250);
  await page.click('#ipodMenu .ipod__item[data-i="1"]'); await page.waitForTimeout(300); // Discover
  const st = (await state(page)) as NonNullable<LibState>;
  const shown = (st.recShown ?? []).length;
  // ported: was “at least ten”; the shelf recommends from the eight seeded rows
  expect(shown >= 1 && shown <= 8, 'opening Discover records what it recommended: ' + shown).toBe(true);
  await page.click('#libraryRows tr:nth-child(1)'); await page.waitForTimeout(300);
  await expect.poll(async () => (await plays(page)).at(-1)?.via, { message: 'a play started there is a recommendation taken' }).toBe('discover');
  await page.click('#libMenuBtn'); await page.waitForTimeout(250);
  await page.click('#ipodMenu .ipod__item[data-i="1"]'); await page.waitForTimeout(300);
  expect(((await state(page)) as NonNullable<LibState>).recShown!.length, 'opening it again the same day does not count the same songs twice').toBe(shown);
});

test.describe('saved algorithms', () => {
  test.use({ acceptDownloads: true });
  test('built-ins, copies, rename, duplicate, delete, export, import, and a reload', async ({ page }) => {
    await boot(page, '#settings/rec');
    const opts = await page.$$eval('#algoPick optgroup', (g) => g.map((x) => [(x as HTMLOptGroupElement).label, [...x.querySelectorAll('option')].map((o) => o.textContent)]));
    expect(opts, 'three built in, none of yours yet').toEqual([['Built in', ['Airwave default', 'Late night', 'Crate digger']], ['Yours', ['None yet']]]);
    expect(await page.$eval('#algoDel', (n) => (n as HTMLButtonElement).disabled) && await page.$eval('#algoName', (n) => (n as HTMLInputElement).disabled), 'a built-in cannot be renamed or deleted').toBe(true);

    await page.selectOption('#algoPick', 'crate-digger'); await page.waitForTimeout(400);
    expect(await page.getAttribute('#algoModeSeg [data-mode="deep"]', 'aria-checked'), 'Crate digger brings its own mode').toBe('true');
    expect(await page.textContent('#algoExploreVal'), 'and its own exploration rate').toMatch(/^0\.30/);
    await expect(page.locator('#algoSide'), 'and the deep mode’s own mix is what the bar shows').toContainText('strong 0.00');

    await setRange(page, 'algoHalf', 120); await page.waitForTimeout(300);
    expect(await pickName(page), 'changing a built-in makes a copy of it').toBe('Crate digger copy');
    await expect(page.locator('#algoMsg'), 'and says so').toContainText('is built in, so the change went into a copy');
    expect(await page.textContent('#algoHalfVal'), 'the half-life redraws').toBe('120 days');
    expect(((await page.getAttribute('#algoCurve', 'd')) ?? '').length, 'its curve').toBeGreaterThan(50);

    await page.fill('#algoName', 'Slow burn'); await page.press('#algoName', 'Enter'); await page.waitForTimeout(300);
    expect(await pickName(page), 'a copy can be renamed').toBe('Slow burn');
    await page.click('#algoDup'); await page.waitForTimeout(300);
    expect(await pickName(page), 'and duplicated').toBe('Slow burn copy');
    await page.click('#algoDel'); await page.waitForTimeout(200);
    expect(await page.textContent('#algoDel'), 'delete asks twice').toBe('Delete — click again');
    await page.click('#algoDel'); await page.waitForTimeout(300);
    expect(await page.$eval('#algoPick', (n) => [...n.querySelectorAll('optgroup[label="Yours"] option')].map((o) => o.textContent).join()), 'and then removes only that one').toBe('Slow burn');

    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#algoExportFile')]);
    expect(dl.suggestedFilename(), 'export saves a file named for the algorithm').toBe('airwave-default.airwave-algorithm.json');
    await page.evaluate(() => (window as unknown as { algoImportText(t: string, n: string): void }).algoImportText(JSON.stringify({ ranking: { tasteMatch: 0.5, discoveryBonus: 0.5, bogus: 1 }, explorationRate: 0.2, madeUp: true }), 'from-engine.json'));
    await page.waitForTimeout(400);
    expect(await pickName(page), 'a bare engine config imports as an algorithm named for its file').toBe('from-engine');
    await expect(page.locator('#algoMsg'), 'and says what it read and what it skipped').toContainText(/3 settings read, 2 unknown ignored/);
    expect(await page.$eval('#rw-tasteMatch', (n) => (n as HTMLInputElement).value), 'with the values it carried').toBe('50');

    await reload(page);
    expect(await pickName(page), 'the choice and the algorithms are kept on the device').toBe('from-engine');
  });
});

test('Revert puts back the weight, the algorithm, and removes the copy', async ({ page }) => {
  await boot(page, '#settings/rec');
  expect(await page.$eval('#prefsRevert', (n) => (n as HTMLButtonElement).disabled), 'nothing to revert on opening').toBe(true);
  await expect(page.locator('#prefsStatus'), 'the strip says changes apply at once').toContainText('take effect as you change them');
  await setRange(page, 'rw-recency', 60); await page.waitForTimeout(300);
  expect(await page.$eval('#prefsRevert', (n) => (n as HTMLButtonElement).disabled), 'a change makes Revert available').toBe(false);
  await page.click('#prefsRevert'); await page.waitForTimeout(400);
  expect(await page.$eval('#rw-recency', (n) => (n as HTMLInputElement).value), 'Revert puts back the weight').toBe('10');
  expect(await page.$eval('#algoPick', (n) => (n as HTMLSelectElement).value), 'and the algorithm it was on').toBe('default');
  expect(await page.$eval('#algoPick', (n) => n.querySelectorAll('optgroup[label="Yours"] option:not([disabled])').length), 'and takes away the copy the change had made').toBe(0);
  expect(await page.$eval('#prefsRevert', (n) => (n as HTMLButtonElement).disabled), 'after which there is nothing left to revert').toBe(true);
});

test('an older preferences file keeps what it had', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    (window as unknown as KvWin).kv.set('player:prefs', { algo: { ranking: { tasteMatch: 0.6 } } });
    await new Promise((r) => setTimeout(r, 300));
  });
  await boot(page, '#settings/rec'); await reload(page);
  expect(await pickName(page), 'a changed config from before becomes “My algorithm”').toBe('My algorithm');
  expect(await page.$eval('#rw-tasteMatch', (n) => (n as HTMLInputElement).value), 'with its value').toBe('60');
});

test.describe('narrow', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('the mode becomes a pop-up, nothing overflows', async ({ page }) => {
    await boot(page, '#settings/rec');
    expect(await page.isVisible('#algoMode') && !(await page.isVisible('#algoModeSeg')), 'on a phone the seven modes are a pop-up').toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), 'and the page does not scroll sideways').toBe(false);
    await boot(page, '#settings/stats'); await statsReady(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), 'nor does Statistics').toBe(false);
  });
});

/* ---- Discover is ranked by the chosen algorithm (NP-DISC-001..005, 2026-10-07) ---- */

type DiscWin = {
  NP_DISCOVER: {
    ids(): string[] | null;
    state(): { seed: number; shown: number; eligible: number; more: number | null; wrapped: boolean };
    rank(): Array<{ id: string; title: string; score: number; tier: string; explored: boolean }>;
  };
};
const discIds = (p: Page) => p.evaluate(() => (window as unknown as DiscWin).NP_DISCOVER.ids());
const discState = (p: Page) => p.evaluate(() => (window as unknown as DiscWin).NP_DISCOVER.state());
const rowTitles = (p: Page) => p.$$eval('#libraryRows tr[data-id] .lib-title', (n) => n.map((x) => (x.textContent ?? '').trim()));
const algoVar = (p: Page, sel: string) => p.$eval(sel, (n) => getComputedStyle(n).getPropertyValue('--algo').trim());
async function openDiscover(p: Page): Promise<void> {
  await p.click('#libMenuBtn'); await p.waitForTimeout(250);
  await p.click('#ipodMenu .ipod__item:has-text("Discover")'); await p.waitForTimeout(400);
}
/** The e2e seed with genres: Alder Quartet is Jazz, Birch Ensemble is Folk. */
const GENRED: SeedTrack[] = SEED.map((t) => ({ ...t, seconds: 3, genre: t.artist === 'Alder Quartet' ? 'Jazz' : 'Folk' }));

test.describe('Discover, ranked', () => {
  test.use({ acceptDownloads: true });

  test('opens ranked by the chosen algorithm, with the chip and Refresh in the silver bar', async ({ page }) => {
    await boot(page);
    await seed(page, GENRED);
    await openDiscover(page);
    await expect(page.locator('#libScopeLabel')).toHaveText('Discover');
    await expect(page.locator('#libAlgoChip'), 'the chip is in the bar').toBeVisible();
    await expect(page.locator('#libAlgoName'), 'and names the algorithm and its mode').toHaveText('Airwave default · For you');
    expect(await algoVar(page, '.lib-scope'), 'in its colour').toBe('#2f61c1');
    await expect(page.locator('#libDiscRefresh'), 'Refresh is beside it').toBeVisible();
    expect(await page.getAttribute('#libDiscRefresh', 'aria-label')).toBe('New songs');
    expect(await page.$eval('#libScope', (n) => n.classList.contains('is-tinted')), 'the scope chip wears a thin tint').toBe(true);
    const ids = (await discIds(page))!;
    expect(ids, 'every unstarred, unqueued song is eligible').toHaveLength(8);
    const ranked = await page.evaluate(() => (window as unknown as DiscWin).NP_DISCOVER.rank());
    expect(ids, 'the list is the ranker’s order, not the library’s').toEqual(ranked.map((r) => r.id));
    expect(await rowTitles(page), 'and the rows follow it').toEqual(ranked.map((r) => r.title));
    expect(await page.$eval('#libMore', (n) => (n as HTMLElement).hidden), 'eight songs need no Load more').toBe(true);
    // the same list twice: deterministic for a seed
    await page.click('#libScopeClear'); await page.waitForTimeout(200);
    await openDiscover(page);
    expect(await discIds(page), 'reopened, the same list').toEqual(ids);
    await page.click('#libraryRows tr[data-id]:nth-child(1)'); await page.waitForTimeout(400);
    await expect.poll(async () => (await plays(page)).at(-1)?.via, { message: 'a play from it is still a recommendation taken (NP-DATA-003)' }).toBe('discover');
  });

  test('Refresh re-seeds, leaves out what was shown until everything has been, pages with Load more, and speaks', async ({ page }) => {
    await boot(page);
    // 56 short songs: fifty on the first page, six behind Load more
    const many: SeedTrack[] = [...GENRED, ...Array.from({ length: 48 }, (_, i) => ({ file: `${String(i + 9).padStart(2, '0')} Cut ${i + 1}.wav`, title: `Cut ${i + 1}`, artist: `Group ${(i % 6) + 1}`, album: `Volume ${(i % 4) + 1}`, seconds: 2, genre: i % 2 ? 'Electronic' : 'Ambient' }))];
    await seed(page, many);
    await openDiscover(page);
    const first = (await discIds(page))!;
    expect(first, 'fifty at a time').toHaveLength(50);
    await expect(page.locator('#libMoreBtn'), 'Load more says how many are left').toHaveText('Load more — 6 more songs');
    await page.click('#libMoreBtn'); await page.waitForTimeout(300);
    expect((await discIds(page))!.length, 'Load more extends the same ranking').toBe(56);
    expect((await discIds(page))!.slice(0, 50), 'without moving what was already shown').toEqual(first);
    await expect(page.locator('#libFindLive')).toHaveText('6 more songs — 56 shown');
    // start over, then refresh: the second page is what the first one left out
    await page.click('#libDiscRefresh', { modifiers: ['Shift'] }); await page.waitForTimeout(400);
    const page1 = (await discIds(page))!;
    expect(page1).toHaveLength(50);
    await expect(page.locator('#libFindLive')).toHaveText('50 new songs — started over');
    await page.click('#libDiscRefresh'); await page.waitForTimeout(400);
    const page2 = (await discIds(page))!;
    expect(page2, 'what the first page did not show').toHaveLength(6);
    expect(page2.some((id) => page1.includes(id)), 'none of them already shown').toBe(false);
    await expect(page.locator('#libFindLive'), 'the live region says how many').toHaveText('6 new songs');
    expect((await discState(page)).seed, 'each refresh is a new seed').toBeGreaterThan(1);
    await page.click('#libDiscRefresh'); await page.waitForTimeout(400);
    expect((await discIds(page))!.length, 'everything shown once: it starts over').toBe(50);
    await expect(page.locator('#libFindLive')).toContainText('everything eligible has been shown once, so Discover started over');
    expect(await page.$eval('#libraryScroll', (n) => n.scrollTop), 'and the list is at its top').toBe(0);
  });

  test('the chip’s menu switches the algorithm: the list re-ranks, the HUD says so, and Settings shows the same choice', async ({ page }) => {
    await boot(page);
    const rows = await seed(page, GENRED);
    // a few plays of Alder Quartet (the rows come back sorted by title, so pick them by name), so the algorithms have something to disagree about
    const alder = rows.filter((r) => r.artist === 'Alder Quartet').map((r) => r.id);
    await page.evaluate(async ([ids]) => {
      const now = Date.now(), DAY = 864e5;
      const pl = [0, 1, 2, 3].map((i) => ({ id: ids[i % 2]!, at: now - (10 + i) * DAY, via: 'library', secs: 120, dur: 120, end: true }));
      const w = window as unknown as KvWin;
      const cur = ((await w.kv.get('library:state')) as Record<string, unknown>) ?? {};
      w.kv.set('library:state', { ...cur, plays: pl });
      await new Promise((r) => setTimeout(r, 300));
    }, [alder] as const);
    await reload(page);
    await openDiscover(page);
    const before = (await discIds(page))!;
    await page.click('#libAlgoChip'); await page.waitForTimeout(300);
    await expect(page.locator('#ctx'), 'the shell’s own menu kit opens under the chip (NP-MENU-001)').toBeVisible();
    expect(await page.getAttribute('#libAlgoChip', 'aria-expanded')).toBe('true');
    const items = await page.$$eval('#ctx [data-act="algo-pick"]', (n) => n.map((x) => ({ name: (x.textContent ?? '').replace(/^\s*✓/, '').trim(), on: x.getAttribute('aria-checked'), color: (x as HTMLElement).style.getPropertyValue('--algo').trim(), desc: x.querySelector('.ctx__desc')?.textContent ?? '' })));
    expect(items.map((i) => i.name.split('·')[0]!.trim()), 'every algorithm, built in and yours').toEqual(['Airwave default', 'Late night', 'Crate digger']);
    expect(items.map((i) => i.on), 'with a tick on the current one').toEqual(['true', 'false', 'false']);
    expect(new Set(items.map((i) => i.color)).size, 'each with its own colour dot').toBe(3);
    expect(items[2]!.desc, 'and a line on what it favours').toBe('Favours what you have heard least and what sounds like what you play, wide exploration');
    expect(await page.$('#ctx [data-act="algo-edit"]'), 'and the way to Settings').not.toBeNull();
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.activeElement?.id), 'Escape closes it and gives the chip its focus back').toBe('libAlgoChip');
    await page.click('#libAlgoChip'); await page.waitForTimeout(300);
    await page.click('#ctx [data-act="algo-pick"][data-id="crate-digger"]'); await page.waitForTimeout(500);
    await expect(page.locator('#libAlgoName')).toHaveText('Crate digger · Deep cuts');
    expect(await algoVar(page, '.lib-scope')).toBe('#d4782a');
    await expect(page.locator('#toast'), 'the HUD names the algorithm now on').toContainText('Discover ranked by “Crate digger” · Deep cuts');
    const after = (await discIds(page))!;
    expect(after, 'deep cuts leave out the artists you know: Alder Quartet is gone').toHaveLength(4);
    expect(after).not.toEqual(before);
    await page.click('#libAlgoChip'); await page.waitForTimeout(300);
    await page.click('#ctx [data-act="algo-edit"]'); await page.waitForTimeout(800);
    expect(await page.$eval('#algoPick', (n) => (n as HTMLSelectElement).value), 'Settings ▸ Recommendations shows the same algorithm: one source of truth').toBe('crate-digger');
    expect(await algoVar(page, '#algoColor'), 'with its swatch').toBe('#d4782a');
    expect(await page.$$eval('#algoLegend button', (n) => n.map((x) => [x.textContent?.trim(), x.getAttribute('aria-pressed')])), 'and the list of every algorithm in its colour').toEqual([['Airwave default', 'false'], ['Late night', 'false'], ['Crate digger', 'true']]);
    // and the other way: a choice in Settings reaches Discover
    await page.selectOption('#algoPick', 'late-night'); await page.waitForTimeout(400);
    await page.click('#prefsBack'); await page.waitForTimeout(600);
    await expect(page.locator('#libAlgoName')).toHaveText('Late night · Similar sounds');
  });

  test('a lean bends the ranking without editing the algorithm: Adventurous, then a genre; Reset clears it', async ({ page }) => {
    await boot(page);
    await seed(page, GENRED);
    await openDiscover(page);
    await page.click('#libAlgoChip'); await page.waitForTimeout(300);
    await page.click('#ctx [data-act="parent"]'); await page.waitForTimeout(200);
    expect(await page.$$eval('#ctx [data-act="algo-lean"]', (n) => n.map((x) => (x.textContent ?? '').replace(/^\s*✓/, '').trim())), 'three quick modes').toEqual(['Familiar', 'Balanced', 'Adventurous']);
    expect(await page.$$eval('#ctx [data-act="algo-genre"]', (n) => n.map((x) => (x.textContent ?? '').replace(/^\s*✓/, '').trim())), 'and the library’s genres').toEqual(['Folk', 'Jazz']);
    await page.click('#ctx [data-act="algo-lean"][data-lean="adventurous"]'); await page.waitForTimeout(400);
    await expect(page.locator('#libAlgoName')).toHaveText('Airwave default · For you · Adventurous');
    await page.click('#libAlgoChip'); await page.waitForTimeout(300);
    await page.click('#ctx [data-act="parent"]'); await page.waitForTimeout(200);
    await page.click('#ctx [data-act="algo-genre"][data-genre="Folk"]'); await page.waitForTimeout(400);
    await expect(page.locator('#libAlgoName')).toHaveText('Airwave default · For you · Adventurous · Folk');
    const titles = await rowTitles(page);
    const folk = SEED.filter((t) => t.artist === 'Birch Ensemble').map((t) => t.title);
    expect(folk.includes(titles[0]!), 'Folk rises: the list opens on a Birch Ensemble song: ' + titles.join(', ')).toBe(true);
    const ranked = await page.evaluate(() => (window as unknown as DiscWin).NP_DISCOVER.rank());
    const minFolk = Math.min(...ranked.filter((r) => folk.includes(r.title)).map((r) => r.score));
    const maxJazz = Math.max(...ranked.filter((r) => !folk.includes(r.title)).map((r) => r.score));
    expect(minFolk, 'every Folk song outscores every Jazz song').toBeGreaterThan(maxJazz);
    await page.click('#profile'); await page.waitForTimeout(300); await page.click('#pt-rec'); await page.waitForTimeout(500);
    expect(await page.$eval('#rw-genreAffinity', (n) => (n as HTMLInputElement).value), 'the saved weight is untouched').toBe('15');
    await page.click('#prefsBack'); await page.waitForTimeout(500);
    await reload(page);
    await openDiscover(page);
    await expect(page.locator('#libAlgoName'), 'the lean is kept in the player’s settings').toHaveText('Airwave default · For you · Adventurous · Folk');
    await page.click('#libAlgoChip'); await page.waitForTimeout(300);
    await page.click('#ctx [data-act="parent"]'); await page.waitForTimeout(200);
    await page.click('#ctx [data-act="algo-lean-reset"]'); await page.waitForTimeout(400);
    await expect(page.locator('#libAlgoName')).toHaveText('Airwave default · For you');
  });

  test('every algorithm has a colour of its own: new ones take the next free hue, a taken one is refused, and they survive a reload and an import without one', async ({ page }) => {
    await boot(page, '#settings/rec');
    expect(await algoVar(page, '#algoColor'), 'Airwave default is blue').toBe('#2f61c1');
    expect(await page.$eval('#algoColor', (n) => (n as HTMLButtonElement).disabled), 'a built-in keeps its colour').toBe(true);
    await page.click('#algoDup'); await page.waitForTimeout(300);
    const c1 = await algoVar(page, '#algoColor');
    await page.click('#algoDup'); await page.waitForTimeout(300);
    const c2 = await algoVar(page, '#algoColor');
    expect([c1, c2].every((c) => !['#2f61c1', '#5c55c9', '#d4782a'].includes(c)) && c1 !== c2, 'the copies take hues nobody has: ' + c1 + ', ' + c2).toBe(true);
    expect(c1, 'in palette order, the first free').toBe('#c8403a');
    await page.click('#algoColor'); await page.waitForTimeout(300);
    const swatches = await page.$$eval('#ctx [data-act="algo-color"]', (n) => n.map((x) => [(x.textContent ?? '').replace(/^\s*✓/, '').trim(), x.getAttribute('aria-disabled')]));
    expect(swatches, 'twelve hues, the taken ones named').toHaveLength(12);
    expect(swatches.find((s) => s[0]?.startsWith('Blue'))?.[0], 'with who has it').toBe('Blue· Airwave default');
    // aria-disabled, not disabled: it can still be chosen, and the refusal is said in words
    await page.click('#ctx [data-act="algo-color"][data-color="#2f61c1"]', { force: true }); await page.waitForTimeout(300);
    await expect(page.locator('#algoMsg'), 'a colour another algorithm uses is refused, in a sentence').toContainText('“Airwave default” already uses blue');
    expect(await algoVar(page, '#algoColor')).toBe(c2);
    await page.click('#algoColor'); await page.waitForTimeout(300);
    await page.click('#ctx [data-act="algo-color"][data-color="#3a9a5e"]'); await page.waitForTimeout(300);
    expect(await algoVar(page, '#algoColor'), 'a free one is taken').toBe('#3a9a5e');
    await expect(page.locator('#algoMsg')).toContainText('is now green');
    await page.evaluate(() => (window as unknown as { algoImportText(t: string, n: string): void }).algoImportText(JSON.stringify({ format: 'airwave-algorithm', version: 1, name: 'From a friend', mode: 'for-you', config: { ranking: { tasteMatch: 0.5 } } }), 'friend.airwave-algorithm.json'));
    await page.waitForTimeout(400);
    const imported = await algoVar(page, '#algoColor');
    expect(['#2f61c1', '#5c55c9', '#d4782a', c1, '#3a9a5e'].includes(imported), 'a file without a colour still gets one nobody has: ' + imported).toBe(false);
    await reload(page);
    const legend = await page.$$eval('#algoLegend button', (n) => n.map((x) => (x as HTMLElement).style.getPropertyValue('--algo').trim()));
    expect(legend, 'six algorithms, six colours, after a reload').toHaveLength(6);
    expect(new Set(legend).size).toBe(6);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#algoExportFile')]);
    const text = await (await dl.createReadStream()).toArray().then((b) => Buffer.concat(b as Buffer[]).toString('utf8'));
    expect(JSON.parse(text).color, 'the file carries the colour').toBe(imported);
  });
});
