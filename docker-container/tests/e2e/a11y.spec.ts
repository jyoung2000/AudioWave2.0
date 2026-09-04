/**
 * Accessibility of the admin GUI, checked with axe against every view.
 *
 * The player's screens are covered by its own suite; these are the hub's, and they are the ones an
 * operator uses under pressure — while something is broken, often on a laptop in a cupboard. Both
 * of the interface's states are checked: the first-run screens, which a person meets before they
 * have any session, and the shell once signed in.
 *
 * Automated checks catch structure, not judgement. Alongside axe these walk the source list with
 * the keyboard alone, because a source list that only responds to a mouse is a navigation the
 * keyboard cannot reach.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const VIEWS = ['Overview', 'Devices', 'Groups', 'Library', 'Providers', 'Downloads', 'Shared links', 'Recommendations', 'Discord', 'Network', 'Backup', 'Diagnostics'] as const;

/** axe needs a page from a real context, which is why the signed-out test builds one rather than
 * calling `browser.newPage()`. */
async function analyse(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  // The message carries the rule and the element, so a failure says what to fix rather than a count.
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`).join('\n');
  expect(results.violations, summary).toEqual([]);
}

test.describe('signed in', () => {
  for (const view of VIEWS) {
    test(`@a11y ${view} has no detectable violations`, async ({ page }) => {
      await page.goto('/');
      await page.getByRole('option', { name: new RegExp(`^${view}\\b`) }).click();
      await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
      await analyse(page);
    });
  }

  test('@a11y the source list is navigable with the keyboard alone', async ({ page }) => {
    await page.goto('/');
    const list = page.getByRole('navigation', { name: 'Sections' });
    await expect(list).toBeVisible();

    // Every option is a tab target or reachable from one: focus the first, then walk with arrows.
    // This is the roving-tabindex model the spec asks for — one stop into the group, then arrows.
    const library = page.getByRole('option', { name: /^Library\b/ });
    await library.focus();
    expect(await library.evaluate((node) => node === document.activeElement)).toBe(true);

    await page.keyboard.press('ArrowDown');
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
    expect(focused, 'arrow-down should move focus to the next option').toContain('Providers');

    // Enter activates what is focused, and the working area follows.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option', { name: /^Providers\b/ })).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('signed out', () => {
  test('@a11y the sign-in screen has no detectable violations', async ({ browser, baseURL }) => {
    // A context, not `browser.newPage()`: axe refuses a page that has no context of its own.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, ...(baseURL ? { baseURL } : {}) });
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Now Playing Hub' })).toBeVisible();
      await analyse(page);
    } finally {
      await context.close();
    }
  });
});
