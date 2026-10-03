/**
 * Settings as a page (NP-PREF-*): its address, the toolbar, Statistics counted from what happened,
 * the recommender's weights and validation, Sources, Player preferences, the equalizer, group mode,
 * the media playlists behind the library button, the phone index and persistence across a reload.
 * Ported from airwave-np tests/prefs.mjs, one long script split into tests by section.
 *
 * What changed: the original asserted that with nothing played Statistics showed the generated demo
 * year (`#srcSel` == 'demo', the note saying “generated demo year”). The shell generates nothing, so
 * the page is asserted to offer only this player's history and an imported file, and to say nothing
 * has been recorded. The “use every mode for real” half played four demo rows, a demo channel and a
 * demo film; here the rows are seeded WAVs, the channel comes from a loaded playlist, and the film leg
 * is dropped (the shell ships no films), so the “all” count is five, not six. The recommender ranks
 * the seeded rows. Each test gets its own browser context, so the reload checks sit with the section
 * whose state they check.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, leavePrefs, prefsShown, reload, resetToLibrary, seed, seedChannels, silentWav, statsReady, stubOffline, watchErrors } from './_shell';

const tiles = (p: Page) => p.$$eval('#pp-stats .stat__tile', (n) => n.map((x) => (x.textContent ?? '').replace(/\s+/g, '')));
const scope = async (p: Page, s: string) => { await p.click(`#cScope [data-scope="${s}"]`); await p.waitForTimeout(350); };
const order = (p: Page) => p.$$eval('.rec__row .rec__t', (n) => n.map((x) => x.textContent ?? ''));
const setRange = (p: Page, id: string, v: string | number) => p.evaluate(([id, v]) => {
  const el = document.getElementById(id as string) as HTMLInputElement;
  el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true }));
}, [id, v] as const);
type KvState = { plays?: unknown[]; sessions?: unknown[] } | null;
const stored = (p: Page) => p.evaluate(async () => {
  const s = (await (window as unknown as { kv: { get(k: string): Promise<unknown> } }).kv.get('library:state')) as KvState;
  return { plays: s?.plays?.length ?? 0, sessions: s?.sessions?.length ?? 0 };
});

let errors: string[];
test.use({ viewport: { width: 1280, height: 960 } });
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await stubOffline(page);
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test('opening: Settings is a page with its own address, and the toolbar is the navigation', async ({ page }) => {
  await boot(page);
  expect(await prefsShown(page), 'closed to start with').toBe(false);
  await page.click('#profile'); await page.waitForTimeout(500);
  expect(await prefsShown(page), 'the profile button opens Settings').toBe(true);
  expect(await page.evaluate(() => location.hash), 'and it has an address of its own').toBe('#settings');
  expect(await page.evaluate(() => (document.querySelector('.player') as HTMLElement).hidden), 'the player stands down — this is a page, not a window over one').toBe(true);
  expect(await page.getAttribute('#profile', 'aria-haspopup'), 'and says so to a screen reader').toBe('dialog');

  const tabs = await page.$$eval('.prefs__tab:not([hidden])', (n) => n.map((x) => (x.textContent ?? '').trim()));
  expect(tabs, 'five sections until the container is paired (then Profile)').toEqual(['Statistics', 'Recommendations', 'Sources', 'Player', 'Equalizer']);
  await page.click('#pt-rec'); await page.waitForTimeout(300);
  expect(await page.isVisible('#pp-rec') && !(await page.isVisible('#pp-stats')), 'clicking a tab swaps the pane').toBe(true);
  expect(await page.getAttribute('#pt-rec', 'aria-selected'), 'and only one is selected').toBe('true');
  expect(await page.getAttribute('#pt-stats', 'aria-selected')).toBe('false');
  await page.focus('#pt-rec'); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250);
  expect(await page.isVisible('#pp-src'), 'arrow keys move along the toolbar').toBe(true);

  await page.click('#pt-stats'); await statsReady(page);
  expect(await page.$$eval('#pp-stats .sec__h', (n) => n.map((x) => x.textContent)), 'the sections of the statistics page')
    .toEqual(['Overview', 'When you listen', 'Genres & tags', 'Sound space', 'Top lists', 'Sources & sessions', 'Your data']);
  expect(await page.$$eval('#cScope button', (n) => n.map((x) => (x.textContent ?? '').trim())), 'a scope for every part of the app').toEqual(['All', 'Music', 'Radio', 'Live TV', 'TV', 'Movies']);
  expect(await page.$$eval('#cRange button', (n) => n.map((x) => (x.textContent ?? '').trim())), 'five periods').toEqual(['7 Days', '30 Days', '90 Days', 'Year', 'All Time']);
  // ported: was “#srcSel == 'demo' and the browser option disabled”; nothing is generated now
  expect(await page.$$eval('#srcSel option', (o) => o.map((x) => (x as HTMLOptionElement).value)), 'the only sources are this player and an imported file').toEqual(['browser', 'import']);
  expect(await page.inputValue('#srcSel'), 'with nothing played it shows this player’s (empty) history').toBe('browser');
  // ported: was “the note says 'generated demo year'”
  await expect(page.locator('#dataNote'), 'and says plainly that nothing has been recorded yet').toContainText('Nothing has been recorded yet');
  // Coming back to Statistics with an empty history used to throw (AW.Dataset(null)); it does not.
  expect(errors, 'no page errors, including on reopening an empty Statistics').toEqual([]);
});

test('statistics: counted from what really happened', async ({ page }) => {
  await boot(page);
  await seed(page);
  await page.click('#mode [data-mode="solo"]'); await page.waitForTimeout(300);
  await resetToLibrary(page);
  // Clicking through four rows 150 ms apart is skipping them, and the log knows.
  for (const n of [1, 2, 3, 1]) { await page.click(`#libraryRows tr:nth-child(${n})`); await page.waitForTimeout(150); }
  await seedChannels(page);
  await page.click('.tb__btn[data-view="live-tv"]'); await page.waitForTimeout(500);
  await page.click('#mediaMenu .rlist tbody tr[data-i="1"]'); await page.waitForTimeout(7000);
  await page.evaluate(() => (document.getElementById('vp_video') as HTMLVideoElement).pause()); await page.waitForTimeout(300);
  // ported: the original also watched a demo film here; the shell ships none
  await page.click('.tb__btn[data-view="music"]'); await page.waitForTimeout(400);
  await expect.poll(() => stored(page), { message: 'four plays and one session are stored' }).toEqual({ plays: 4, sessions: 1 });

  await page.click('#profile'); await page.waitForTimeout(500);
  await page.click('#pt-stats'); await statsReady(page);
  expect(await page.inputValue('#srcSel'), 'once something has played, the player’s own history is shown').toBe('browser');
  // ported: new — the source line and select name this player's history and count the real events
  expect(await page.textContent('#sbSrc'), 'the source line counts the four plays and the session').toBe('This player’s history · 5 events');
  expect(await page.$eval('#srcSel option[value="browser"]', (o) => o.textContent)).toBe('This player’s history (5)');
  await scope(page, 'music');
  const t = await tiles(page);
  expect(t[0], 'music: four plays').toMatch(/^4plays/);
  expect(t[2], 'clicking through is measured as skipping: none heard to the end').toMatch(/^0%songsheardtotheend/);
  expect(t[3], 'and every timed one skipped early').toMatch(/^100%songsskippedearly/);
  // ported: the original accepted the demo title “Nightswimmer”; the seeded titles are asserted instead
  await page.click('#tKind [data-tkind="songs"]'); await page.waitForTimeout(250);
  await expect(page.locator('#pp-stats #topTable'), 'the top list names what was played').toContainText(/Harbour Morning|Gantry|Blue Hour/);
  expect(await page.$eval('#cScope [data-scope="radio"]', (b) => (b as HTMLButtonElement).disabled), 'a part of the app that was not used cannot be chosen').toBe(true);

  await scope(page, 'live-tv');
  expect((await tiles(page))[0], 'live TV is counted as a session').toMatch(/^1plays/);
  await scope(page, 'all');
  // ported: was “6 plays” (four songs, a channel and a film)
  expect((await tiles(page))[0], 'all: four plays and one session').toMatch(/^5plays/);
  const where = await page.$$eval('#srcBars .bars__row', (n) => n.map((r) => [r.querySelector('.bars__name')?.textContent ?? '', parseFloat((r.querySelector('.bars__fill') as HTMLElement).style.width) || 0] as [string, number]));
  expect(where.filter((x) => x[1] > 0).map((x) => x[0]).sort(), 'where the time went has time only against what was used: ' + JSON.stringify(where)).toEqual(['Live TV', 'Music']);
  await page.click('#cRange [data-range="7"]'); await page.waitForTimeout(350);
  await expect(page.locator('#lead'), 'the period is stated').toContainText('last 7 days');
  expect((await tiles(page))[0], 'and today is inside the last seven days').toMatch(/^5plays/);
});

test('the recommender ranks, and its validation is enforced here', async ({ page }) => {
  await boot(page);
  await seed(page);
  await page.click('#profile'); await page.waitForTimeout(400);
  await page.click('#pt-rec'); await page.waitForTimeout(600);
  // ported: the original ranked the demo library; the eight seeded rows are what there is to rank
  expect(await order(page), 'eight recommendations, from the seeded library').toHaveLength(8);
  expect(await page.$$('#algoGroups [data-factor]'), 'the engine’s eight ranking weights').toHaveLength(8);
  expect(await page.$$('#pp-rec details.disc summary'), 'thirteen groups of settings').toHaveLength(13);
  expect(await page.$$eval('#algoMode option', (n) => n.map((x) => (x as HTMLOptionElement).value)), 'all seven modes')
    .toEqual(['for-you', 'playlist', 'genre', 'similar', 'deep', 'new-releases', 'recent']);

  await page.click('#algoModeSeg [data-mode="deep"]'); await page.waitForTimeout(500);
  expect(await page.getAttribute('#algoModeSeg [data-mode="deep"]', 'aria-checked'), 'the mode is a segmented control').toBe('true');
  await expect(page.locator('#algoModeWhy'), 'the mode explains itself').toContainText('Discovery counts triple');
  expect(await page.textContent('#rwv-discoveryBonus'), 'and shows the multiplied value beside the weight').toMatch(/0\.05 × 3 = 0\.15/);
  await page.click('#algoGroups details.disc[data-disc="mode"] summary'); await page.waitForTimeout(250);
  expect(await page.$$eval('#algoGroups [data-mflag]', (n) => n.map((x) => [(x as HTMLInputElement).dataset['mflag'], (x as HTMLInputElement).checked])), 'deep sets all four exclusions')
    .toEqual([['popularityInverted', true], ['excludeOwned', true], ['excludeKnownArtists', true], ['excludeTopArtists', true]]);
  await page.click('#algoModeSeg [data-mode="for-you"]'); await page.waitForTimeout(500);

  for (const k of ['tasteMatch', 'artistAffinity', 'genreAffinity', 'collaborative', 'recency', 'popularityFit', 'moodContext']) await setRange(page, 'rw-' + k, 0);
  await setRange(page, 'rw-discoveryBonus', 100);
  await page.waitForTimeout(500);
  expect(await order(page), 'the list survives one weight carrying everything').toHaveLength(8);
  await expect(page.locator('#recWhy'), 'and the breakdown names the factor that did it').toContainText('Discovery');

  await setRange(page, 'rw-discoveryBonus', 0);
  await page.waitForTimeout(400);
  expect(await page.getAttribute('#algoErr', 'hidden'), 'all-zero weights are refused').toBeNull();
  await expect(page.locator('#algoErr'), 'the way the engine refuses them').toContainText('cannot all be zero');
  await setRange(page, 'tier-strong', 90); await page.waitForTimeout(400);
  await expect(page.locator('#algoErr'), 'shares that miss 100% are called out').toContainText('add up to');
  await page.click('#tierNorm'); await page.waitForTimeout(400);
  const sum = await page.evaluate(() => ['strong', 'related', 'emerging', 'experimental'].reduce((a, k) => a + +(document.getElementById('tier-' + k) as HTMLInputElement).value, 0));
  expect(Math.abs(sum - 100) <= 1, 'and can be scaled back to 100: ' + sum).toBe(true);
  await setRange(page, 'al-actionWeights-dislike', '5'); await page.waitForTimeout(350);
  await expect(page.locator('#algoErr'), 'a dislike worth +5 is refused').toContainText('actionWeights.dislike');
  await page.click('#recReset'); await page.waitForTimeout(500);
  expect(await page.getAttribute('#algoErr', 'hidden'), 'reset clears every complaint').not.toBeNull();
  expect(await page.$eval('#rw-tasteMatch', (n) => (n as HTMLInputElement).value), 'and restores the engine defaults').toBe('30');
});

test('sources: the note is honest, a playlist loads, and the paths survive a reload', async ({ page }) => {
  await page.route('**/good.m3u', (r) => r.fulfill({ status: 200, contentType: 'audio/x-mpegurl', body:
    '#EXTM3U\n#EXTINF:-1 tvg-id="n1" tvg-chno="101" group-title="News",North One\nhttps://x.invalid/a.mp4\n' +
    '#EXTINF:-1 tvg-chno="102" group-title="Film",Reel Two\nhttps://x.invalid/b.mp4\n' }));
  await page.route('**/x.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }));
  await boot(page);
  await page.click('#profile'); await page.waitForTimeout(400);
  await page.click('#pt-src'); await page.waitForTimeout(300);
  await page.fill('#srcM3u', 'https://example.invalid/channels.m3u');
  await page.dispatchEvent('#srcM3u', 'change'); await page.waitForTimeout(300);
  await expect(page.locator('#srcNote'), 'the note tracks what is set').toContainText('can be loaded');
  await page.fill('#srcMusic', 'C:\\Music'); await page.dispatchEvent('#srcMusic', 'change'); await page.waitForTimeout(250);
  await expect(page.locator('#srcNote'), 'and is straight about what a browser cannot do').toContainText('cannot read a folder');
  await page.fill('#srcM3u', 'https://example.invalid/good.m3u');
  await page.click('#srcLoad');
  await expect(page.locator('#srcLoadMsg'), 'a playlist loads').toContainText('2 channels', { timeout: 5000 });
  await leavePrefs(page);
  await page.click('.tb__btn[data-view="live-tv"]'); await page.waitForTimeout(600);
  const chans = await page.$$eval('#mediaMenu .rlist tbody tr', (n) => n.map((r) => r.textContent ?? ''));
  expect(chans.length === 2 && /North One/.test(chans[0]!), 'and the guide is the user’s own channels now: ' + JSON.stringify(chans)).toBe(true);
  expect(/Live/.test(chans[0]!) && !/\d:\d\d/.test(chans[0]!), 'with no schedule invented for them: ' + chans[0]).toBe(true);

  await page.click('.tb__btn[data-view="music"]'); await page.waitForTimeout(300);
  await page.click('#profile'); await page.waitForTimeout(400);
  await page.click('#pt-src'); await page.waitForTimeout(300);
  await page.fill('#cfgCompanion', 'http://127.0.0.1:65535');
  await page.click('#cfgConnect');
  await expect(page.locator('#cfgConnMsg'), 'a companion that is not there says so').toContainText(/No answer|not the companion/, { timeout: 10_000 });

  await leavePrefs(page);
  await reload(page);
  await page.click('#profile'); await page.waitForTimeout(500);
  await page.click('#pt-src'); await page.waitForTimeout(300);
  expect(await page.inputValue('#srcMusic'), 'the source paths come back after a reload').toBe('C:\\Music');
});

test('player preferences, the equalizer and group mode; the equalizer survives a reload', async ({ page }) => {
  await boot(page);
  await page.click('#profile'); await page.waitForTimeout(400);
  await page.click('#pt-player'); await page.waitForTimeout(300);
  await page.selectOption('#cfgTheme', 'dark'); await page.waitForTimeout(350);
  expect(await page.getAttribute('html', 'data-theme'), 'Dark is chosen, not inherited').toBe('dark');
  await page.selectOption('#cfgTheme', 'light'); await page.waitForTimeout(300);
  expect(await page.getAttribute('html', 'data-theme'), 'and Light too').toBe('light');
  await page.selectOption('#cfgTheme', 'auto'); await page.waitForTimeout(300);
  expect(await page.getAttribute('html', 'data-theme'), 'Automatic goes back to the system').toBeNull();
  await page.check('#cfgMotion'); await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.documentElement.hasAttribute('data-reduce-motion')), 'motion can be reduced').toBe(true);
  await page.uncheck('#cfgStage'); await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.documentElement.hasAttribute('data-no-stage')), 'and the artwork turned off').toBe(true);
  await page.check('#cfgStage'); await page.uncheck('#cfgMotion');

  await page.click('#pt-eq'); await page.waitForTimeout(300);
  expect(await page.$$('.mslider'), 'ten bands and a preamp').toHaveLength(11);
  expect(await page.$$('.mticks'), 'each on its own tick scale').toHaveLength(11);
  expect(await page.$$eval('.mlabel.band', (n) => n.map((x) => x.textContent)), 'at the frequencies the style guide uses')
    .toEqual(['Preamp', '32', '64', '125', '250', '500', '1K', '2K', '4K', '8K', '16K']);
  await page.click('#eqPreset'); await page.waitForTimeout(350);
  expect(await page.getAttribute('#ctx', 'hidden'), 'the pop-up opens a menu').toBeNull();
  const presets = await page.$$eval('#ctx [data-preset]', (n) => n.map((x) => (x as HTMLElement).dataset['preset']));
  expect(presets.includes('Rock') && presets.includes('pawa') && presets.includes('Solfeggio 528 Hz'), 'carrying the built-ins and the Solfeggio tones: ' + presets.length).toBe(true);
  await page.click('#ctx [data-preset="Rock"]'); await page.waitForTimeout(600);
  expect(await page.textContent('#eqPresetVal'), 'choosing one names it on the pop-up').toBe('Rock');
  const knobs = await page.$$eval('.mslider', (n) => n.map((x) => x.getAttribute('aria-valuetext')));
  expect([knobs[1], knobs[10]], 'and moves the sliders to it').toEqual(['+5.0 dB', '+4.5 dB']);
  await page.evaluate(() => (document.querySelectorAll('.mslider')[10] as HTMLElement).focus());
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(350);
  expect(await page.textContent('#eqPresetVal'), 'moving a band leaves the preset behind').toBe('Manual');
  await expect(page.locator('#eqCurveDesc'), 'the caption says it is off').toContainText('switched off');
  await page.click('#eqOn'); await page.waitForTimeout(400);
  await expect(page.locator('#eqCurveDesc'), 'and changes when it is on').toContainText('bands are');
  await expect(page.locator('#eqNote'), 'the note is honest about the streams it cannot touch').toContainText('would silence it');

  await page.click('#pt-player'); await page.waitForTimeout(300);
  expect(await page.isChecked('#cfgGroup'), 'group listening is on to start with').toBe(true);
  await page.uncheck('#cfgGroup'); await page.waitForTimeout(350);
  expect(await page.getAttribute('.segmented__item[data-mode="solo"]', 'aria-checked'), 'turning it off moves the pills too').toBe('true');
  await page.check('#cfgGroup'); await page.waitForTimeout(350);
  expect(await page.getAttribute('.segmented__item[data-mode="group"]', 'aria-checked'), 'and back').toBe('true');
  await leavePrefs(page);
  await page.click('.segmented__item[data-mode="solo"]'); await page.waitForTimeout(300);
  await page.click('#profile'); await page.waitForTimeout(400);
  await page.click('#pt-player'); await page.waitForTimeout(300);
  expect(await page.isChecked('#cfgGroup'), 'the pills move the checkbox: the two never disagree').toBe(false);
  await page.check('#cfgGroup'); await page.waitForTimeout(300);

  await leavePrefs(page);
  await reload(page);
  await page.click('#profile'); await page.waitForTimeout(500);
  await page.click('#pt-eq'); await page.waitForTimeout(500);
  expect(await page.$$eval('.mslider', (n) => n[10]!.getAttribute('aria-valuetext')), 'the equalizer comes back as it was left').toBe('+3.5 dB');
  expect(await page.isChecked('#eqOn'), 'switched on').toBe(true);
});

test('media playlists live behind the library button', async ({ page }) => {
  await boot(page);
  // ported: Live TV's rows come from a loaded playlist; TV and Movies have no invented catalogue,
  // so “the first row goes back to the list” is checked by the list's return, not by its row count
  await seedChannels(page);
  for (const v of ['live-tv', 'tv', 'movies']) {
    await page.click(`.tb__btn[data-view="${v}"]`); await page.waitForTimeout(500);
    expect(await page.$$('#mediaMenu .ipod__item'), 'no menu rows hanging under the ' + v + ' list').toHaveLength(0);
    await page.click('#libMenuBtn'); await page.waitForTimeout(400);
    const rows = await page.$$eval('#mediaMenu .ipod__item .ipod__label', (n) => n.map((x) => (x.textContent ?? '').trim()));
    expect(rows.indexOf('Playlists'), 'the library button opens a root menu ending in Playlists on ' + v + ': ' + JSON.stringify(rows)).toBe(rows.length - 1);
    await page.click('#mediaMenu .ipod__item:last-child'); await page.waitForTimeout(400);
    expect(await page.textContent('#libScopeLabel'), 'which opens the shelf on ' + v).toBe('Playlists');
    await page.click('#libMenuBtn'); await page.waitForTimeout(350);
    await page.click('#mediaMenu .ipod__item:first-child'); await page.waitForTimeout(400);
    if (v === 'live-tv') expect((await page.$$('#mediaMenu .rlist tbody tr')).length, 'and the first row goes back to the channel list').toBe(2);
    else expect(await page.$$('#mediaMenu .ipod__item'), 'and the first row goes back to the list on ' + v).toHaveLength(0);
  }
});

test('it is a page at both widths, and a section has its own address', async ({ page }) => {
  await boot(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#profile'); await page.waitForTimeout(500);
  expect(await page.evaluate(() => (document.getElementById('prefs') as HTMLElement).dataset['level']), 'a phone opens on the index').toBe('index');
  expect(await page.isVisible('.prefs__tabs'), 'and has no toolbar').toBe(false);
  const iosRows = await page.$$eval('#prefsIndexList li:not([hidden]) .ios-row .ios-row__t', (n) => n.map((x) => (x.firstChild?.textContent ?? '').trim()));
  expect(iosRows, 'one grouped row per section').toEqual(['Statistics', 'Recommendations', 'Sources', 'Player', 'Equalizer']);
  expect(await page.$eval('#prefsIndexList .ios-row', (n) => Math.round(n.getBoundingClientRect().height)), 'rows are finger-sized').toBeGreaterThanOrEqual(44);
  await page.click('[data-pane="player"]'); await page.waitForTimeout(500);
  expect(await page.evaluate(() => location.hash), 'tapping one pushes to its own address').toBe('#settings/player');
  expect(await page.textContent('#prefsTitle'), 'the bar names where you are').toBe('Player');
  expect(await page.textContent('#prefsBackLbl'), 'and the back button names where it returns to').toBe('Settings');
  await page.click('#prefsBack'); await page.waitForTimeout(400);
  expect(await page.evaluate(() => (document.getElementById('prefs') as HTMLElement).dataset['level']), 'back goes up one level, not out').toBe('index');
  expect(await page.textContent('#prefsBackLbl'), 'and now offers the way out').toBe('Airwave');
  await page.goBack(); await page.waitForTimeout(400);
  expect(await page.evaluate(() => location.hash), 'the browser Back button walks the same history').toBe('#settings/player');

  await page.setViewportSize({ width: 1280, height: 900 }); await page.waitForTimeout(500);
  expect(await page.isVisible('.prefs__tabs') && await page.isVisible('#pp-player'), 'widening brings the toolbar back and keeps the section').toBe(true);
  expect(await page.textContent('#prefsBackLbl'), 'where back means out again').toBe('Airwave');
  await leavePrefs(page);
  expect(!(await prefsShown(page)) && !(await page.evaluate(() => (document.querySelector('.player') as HTMLElement).hidden)), 'and leaving gives the player back').toBe(true);

  await boot(page, '#settings/eq');
  expect(await prefsShown(page) && await page.isVisible('#pp-eq'), 'opening at a section lands on that section').toBe(true);
  await boot(page);
  expect(await prefsShown(page), 'and with no hash it opens on the player').toBe(false);
});
