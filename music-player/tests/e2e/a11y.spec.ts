/**
 * Accessibility of the player, checked with axe against every screen of the shell, with the
 * keyboard alone for the transport.
 *
 * Rewritten for the shell (DEC-019): the React section strip is gone, so the screens are the
 * shell's own — the library with rows in it, the five Settings panes, and the search popover.
 * Automated checks catch structure, not judgement; the keyboard walks below are the judgement part.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { boot, seed, stubOffline, SEED } from './np/_shell.js';

async function analyse(page: Page, what: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 6).map((n) => n.target.join(' ')).join(', ')}`).join('\n');
  expect(results.violations, `${what}\n${summary}`).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await stubOffline(page);
  await boot(page);
});

test('@a11y the library, with music in it, has no detectable violations', async ({ page }) => {
  await seed(page, SEED.slice(0, 4));
  await analyse(page, 'library');
});

for (const [tab, name] of [['#pt-stats', 'Statistics'], ['#pt-rec', 'Recommendations'], ['#pt-src', 'Sources'], ['#pt-player', 'Player'], ['#pt-eq', 'Equalizer']] as const) {
  test(`@a11y Settings ▸ ${name} has no detectable violations`, async ({ page }) => {
    await page.click('#profile');
    await page.click(tab);
    if (tab === '#pt-stats') await page.waitForSelector('#pp-stats[data-ready="true"]', { timeout: 20_000 });
    await page.waitForTimeout(300);
    await analyse(page, `Settings ▸ ${name}`);
  });
}

test('@a11y the transport is reachable and named from the keyboard alone', async ({ page }) => {
  for (const id of ['#prev', '#play', '#next', '#track']) {
    const control = page.locator(id);
    await control.focus();
    expect(await control.evaluate((n) => n === document.activeElement), `${id} takes focus`).toBe(true);
    const name = await control.evaluate((n) => n.getAttribute('aria-label') ?? n.textContent ?? '');
    expect(name.trim().length, `${id} has a name`).toBeGreaterThan(0);
  }
});

test('@a11y respects reduced motion: nothing loops that a person did not start', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForFunction(() => window.NP_READY);
  await page.evaluate(() => window.NP_READY);
  await seed(page, SEED.slice(0, 2));
  await page.waitForTimeout(600);
  const looping = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity)
      .map((a) => {
        const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
        return `${target?.id || target?.className || target?.tagName || '?'} ${(a as CSSAnimation).animationName ?? ''}`;
      }),
  );
  expect(looping, `under reduced motion these still loop: ${looping.join(', ')}`).toEqual([]);
});

test('@a11y focus is visible wherever it lands', async ({ page }) => {
  await page.locator('#play').focus();
  const outline = await page.locator('#play').evaluate((n) => {
    const s = getComputedStyle(n);
    return s.outlineStyle !== 'none' || s.boxShadow !== 'none';
  });
  expect(outline, 'a focused control draws a ring').toBe(true);
});
