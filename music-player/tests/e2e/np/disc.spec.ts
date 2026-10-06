/**
 * The disc's motion is the listener's (NP-PREF-014).
 *
 * Settings ▸ Player ▸ The disc chooses whether the disc spins (and how fast, or with the song's
 * tempo) and whether it turns all the way round (how fast, with the tempo, held one way, or left
 * where it was put). The choices are saved, and the 3D stage follows them: read through
 * `window.NP_DISC.motion()`, which reports the rates the stage is using and the angle it is at.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, playRow, resetToLibrary, seed, watchErrors } from './_shell';

type Motion = { spin: number; turn: number; angle: number; tilt: number; pitch: number; out: number; spinning: number; bpm: number | null; prefs: Record<string, unknown>; preview: { running: boolean; frames: number } };
const motion = (page: Page) => page.evaluate(() => (window as unknown as { NP_DISC: { motion(): Motion } }).NP_DISC.motion());

let errors: string[];
test.beforeEach(({ page }) => {
  errors = watchErrors(page);
});
test.afterEach(() => {
  expect(errors, 'JS errors').toEqual([]);
});

async function choose(page: Page, id: string, value: string): Promise<void> {
  await page.selectOption(`#${id}`, value);
  await page.waitForTimeout(150);
}

async function setSpeed(page: Page, id: string, value: number): Promise<void> {
  await page.$eval(`#${id}`, (el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/** Back to the player, where the stage is on screen and runs at full rate. */
async function backToPlayer(page: Page): Promise<void> {
  await page.evaluate(() => {
    location.hash = '';
  });
  await expect(page.locator('#cfgDiscSpin')).toBeHidden();
}

/** A song playing, then Settings ▸ Player opened over it — the way the choice is really made. */
async function playingWithSettings(page: Page): Promise<void> {
  await boot(page);
  await seed(page);
  await resetToLibrary(page);
  await playRow(page, 'Gantry');
  // Let the case open and the disc come out before Settings covers the stage (which idles under it).
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    location.hash = '#settings/player';
  });
  await expect(page.locator('#cfgDiscSpin')).toBeVisible();
}

test('the controls start at today’s behaviour, show only what applies, and are kept across a reload', async ({ page }) => {
  await boot(page, '#settings/player');
  await expect(page.locator('#discPrefs legend')).toHaveText('The disc');
  await expect(page.locator('#cfgDiscSpin')).toHaveValue('steady');
  await expect(page.locator('#cfgDiscTurn')).toHaveValue('steady');
  await expect(page.locator('#cfgDiscSpinSpeedVal')).toHaveText('1×');
  await expect(page.locator('#cfgDiscTurnSpeedVal')).toHaveText('1×');
  await expect(page.locator('#cfgDiscYawVal'), 'the label face on, as it always was').toHaveText('0°');
  await expect(page.locator('#cfgDiscPitchVal'), 'tipped back as it always was').toHaveText('40°');

  await choose(page, 'cfgDiscSpin', 'off');
  await expect(page.locator('#cfgDiscSpinSpeedRow'), 'no speed for a disc that does not spin').toBeHidden();
  await choose(page, 'cfgDiscTurn', 'lock');
  await expect(page.locator('#cfgDiscTurnSpeedRow'), 'no speed for a disc held still').toBeHidden();
  await choose(page, 'cfgDiscFacing', 'back');
  await expect(page.locator('#cfgDiscYawVal'), 'a preset sets the angle').toHaveText('180°');

  await page.reload();
  await page.waitForFunction(() => (window as unknown as { NP_READY?: unknown }).NP_READY);
  await expect(page.locator('#cfgDiscSpin')).toHaveValue('off');
  await expect(page.locator('#cfgDiscTurn')).toHaveValue('lock');
  await expect(page.locator('#cfgDiscFacing')).toHaveValue('back');
  await expect(page.locator('#cfgDiscYaw')).toHaveValue('180');
  expect((await motion(page)).prefs).toMatchObject({ spin: 'off', turn: 'lock', facing: 'back', yaw: 180 });
});

test('the angle and the tilt are the listener’s, and Reset Position puts the disc back there', async ({ page }) => {
  // Settings, the disc out of its case (up to 30 s of software-drawn frames on a runner), a drag and a reload.
  test.setTimeout(150_000);
  await playingWithSettings(page);
  await setSpeed(page, 'cfgDiscYaw', 90);
  await expect(page.locator('#cfgDiscFacing'), 'an angle that is a preset names it').toHaveValue('edge');
  await setSpeed(page, 'cfgDiscYaw', 120);
  await expect(page.locator('#cfgDiscFacing'), 'and one that is not is the listener’s own').toHaveValue('custom');
  await expect(page.locator('#cfgDiscYawVal')).toHaveText('120°');
  await setSpeed(page, 'cfgDiscPitch', 60);
  await expect(page.locator('#cfgDiscPitchVal')).toHaveText('60°');
  let m = await motion(page);
  expect(m.pitch, 'tipped back 60°').toBeCloseTo((-60 * Math.PI) / 180, 5);
  expect(m.prefs).toMatchObject({ yaw: 120, pitch: 60, facing: 'custom' });

  // Dragged somewhere else on the player, then Reset Position: back at 120° and no extra tilt.
  await choose(page, 'cfgDiscTurn', 'off');
  await backToPlayer(page);
  // A drag holds the disc only once it is out of the case: wait for that, not for a fixed time (a slow
  // runner draws the opening at a fraction of this machine's rate).
  await expect.poll(async () => (await motion(page)).out, { message: 'the disc is out of its case', timeout: 30_000 }).toBeGreaterThan(0.95);
  const box = (await page.locator('#stage').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  m = await motion(page);
  expect(Math.abs(m.angle - (120 * Math.PI) / 180), 'the drag moved it').toBeGreaterThan(0.3);
  expect(m.tilt, 'and tipped it').not.toBe(0);
  await page.evaluate(() => {
    location.hash = '#settings/player';
  });
  await page.click('#cfgDiscReset');
  m = await motion(page);
  expect(m.angle).toBeCloseTo((120 * Math.PI) / 180, 5);
  expect(m.tilt).toBe(0);

  await page.reload();
  await page.waitForFunction(() => (window as unknown as { NP_READY?: unknown }).NP_READY);
  await expect(page.locator('#cfgDiscYaw')).toHaveValue('120');
  await expect(page.locator('#cfgDiscPitch')).toHaveValue('60');
});

test('the preview in Settings draws the disc, and says what it is showing', async ({ page }) => {
  await boot(page, '#settings/player');
  await page.locator('#discPreview').scrollIntoViewIfNeeded();
  await expect(page.locator('#discPreview canvas'), 'a disc to look at').toHaveCount(1);
  await expect.poll(async () => (await motion(page)).preview.frames, { message: 'it is drawing', timeout: 10_000 }).toBeGreaterThan(20);
  await expect(page.locator('#discPreviewNote')).toHaveText('As it moves while a song plays.');
  await choose(page, 'cfgDiscSpin', 'tempo');
  await expect(page.locator('#discPreviewNote'), 'no song playing: shown at a stated tempo').toHaveText('As it moves with a song at 120 BPM.');
  // Away from Settings it stops drawing: nobody can see it.
  await page.evaluate(() => {
    location.hash = '';
  });
  await expect.poll(async () => (await motion(page)).preview.running, { timeout: 5_000 }).toBe(false);
});

test('the stage follows the choices: steady, a speed, off, and with the song’s tempo', async ({ page }) => {
  await playingWithSettings(page);
  let m = await motion(page);
  expect(m.spin, 'today’s spin, unchanged by default').toBeCloseTo(8, 5);
  expect(m.turn, 'and today’s turn').toBeCloseTo(0.42, 5);

  await setSpeed(page, 'cfgDiscSpinSpeed', 2);
  await setSpeed(page, 'cfgDiscTurnSpeed', 0.5);
  m = await motion(page);
  expect(m.spin).toBeCloseTo(16, 5);
  expect(m.turn).toBeCloseTo(0.21, 5);

  await choose(page, 'cfgDiscSpin', 'off');
  await choose(page, 'cfgDiscTurn', 'off');
  m = await motion(page);
  expect(m.spin).toBe(0);
  expect(m.turn).toBe(0);

  // With the tempo: a song at 180 BPM moves half as fast again as one at 120.
  await choose(page, 'cfgDiscSpin', 'tempo');
  await choose(page, 'cfgDiscTurn', 'tempo');
  await setSpeed(page, 'cfgDiscSpinSpeed', 1);
  await setSpeed(page, 'cfgDiscTurnSpeed', 1);
  m = await motion(page);
  expect(m.bpm, 'the seeded songs carry no tempo').toBeNull();
  expect(m.spin, 'no known tempo: the steady speed').toBeCloseTo(8, 5);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('library:bpm', { detail: { title: 'Gantry', artist: 'Alder Quartet', bpm: 180 } })));
  m = await motion(page);
  expect(m.bpm).toBe(180);
  expect(m.spin).toBeCloseTo(12, 5);
  expect(m.turn, 'one full turn every 32 beats').toBeCloseTo((2 * Math.PI * 3) / 32, 5);
  await backToPlayer(page);
  await expect.poll(async () => (await motion(page)).spinning, { message: 'the disc is really spinning at that rate', timeout: 10_000 }).toBeGreaterThan(10);
});

test('held one way, the disc settles on that facing while it plays', async ({ page }) => {
  await playingWithSettings(page);
  await choose(page, 'cfgDiscTurn', 'lock');
  await choose(page, 'cfgDiscFacing', 'edge');
  await backToPlayer(page);
  // Settled when the angle sits on the facing (π/2), whichever full turn it is on.
  const off = async () => {
    const a = (await motion(page)).angle;
    const d = (((a - Math.PI / 2) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    return Math.abs(d);
  };
  await expect.poll(off, { message: 'the disc comes to face edge-on', timeout: 15_000 }).toBeLessThan(0.02);
  expect((await motion(page)).turn).toBe(0);
});

test('Reduce animation still wins: a slow spin and no turning, whatever is chosen', async ({ page }) => {
  await boot(page, '#settings/player');
  await setSpeed(page, 'cfgDiscSpinSpeed', 3);
  await page.check('#cfgMotion');
  await page.waitForTimeout(150);
  const m = await motion(page);
  expect(m.spin).toBeLessThanOrEqual(1);
  expect(m.turn).toBe(0);
});
