/**
 * Accessibility of the admin GUI, checked with axe against every view.
 *
 * The player's screens are covered by its own suite; these are the hub's, and they are the ones an
 * operator uses under pressure — while something is broken, often on a laptop in a cupboard. Both
 * of the interface's states are checked: the first-run screens, which a person meets before they
 * have any session, and the shell once signed in.
 *
 * Automated checks catch structure, not judgement. Alongside axe these walk the tab strip with
 * the keyboard alone, because a tab strip that only responds to a mouse is a navigation the
 * keyboard cannot reach.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** The seven tabs. Each stacks the sections the source list once listed (Profiles under Devices;
 * Library, Providers, Downloads and Recommendations under Music; Shared links and Discord under
 * Sharing; Network, Backup and Diagnostics under System), so a pass over the tabs is a pass over
 * every section. */
const TABS = ['Overview', 'Devices', 'Music', 'Search', 'Groups', 'Sharing', 'System'] as const;

/** axe needs a page from a real context, which is why the signed-out test builds one rather than
 * calling `browser.newPage()`. */
async function analyse(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  // The message carries the rule and the element, so a failure says what to fix rather than a count.
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`).join('\n');
  expect(results.violations, summary).toEqual([]);
}

test.describe('signed in', () => {
  for (const tab of TABS) {
    test(`@a11y ${tab} has no detectable violations`, async ({ page }) => {
      await page.goto('/');
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByRole('tablist', { name: 'Sections' })).toBeVisible();
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await analyse(page);
    });
  }

  test('@a11y the tab strip is navigable with the keyboard alone', async ({ page }) => {
    await page.goto('/');
    const tabs = page.getByRole('tablist', { name: 'Sections' });
    await expect(tabs).toBeVisible();

    // One tab stop into the group, then arrows: the roving-tabindex model (UX-KEY-001). The arrow
    // moves the selection with it, as a tab strip does, so the pane follows the focus.
    const music = page.getByRole('tab', { name: 'Music' });
    await music.focus();
    expect(await music.evaluate((node) => node === document.activeElement)).toBe(true);

    await page.keyboard.press('ArrowRight');
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
    expect(focused, 'arrow-right should move focus to the next tab').toContain('Search');
    await expect(page.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('searchbox', { name: 'Search for music' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Groups' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('New group’s name')).toBeVisible();

    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
    // Only the selected tab is in the tab order; the rest are reached with arrows.
    expect(await tabs.getByRole('tab', { name: 'Overview' }).getAttribute('tabindex')).toBe('-1');
  });
});

test.describe('asking first', () => {
  test('@a11y the confirmation sheet has no detectable violations, holds the keyboard, and Escape cancels', async ({ page }) => {
    await page.goto('/#groups');
    await page.getByLabel('New group’s name').fill('Sheet a11y');
    await page.getByRole('button', { name: 'New Group' }).click();
    const archive = page.getByRole('button', { name: 'Archive…' });
    await archive.click();
    const sheet = page.getByRole('alertdialog', { name: 'Archive Sheet a11y?' });
    await expect(sheet).toBeVisible();
    await analyse(page);
    // Cancel has the focus, Tab stays inside the sheet, and Escape puts the focus back.
    await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sheet.getByRole('button', { name: 'Archive' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(archive).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Invites to Sheet a11y' })).toBeVisible();
  });
});

test.describe('signed out', () => {
  test('@a11y the sign-in screen has no detectable violations', async ({ browser, baseURL }) => {
    // A context, not `browser.newPage()`: axe refuses a page that has no context of its own.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, ...(baseURL ? { baseURL } : {}) });
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Airwave Hub' })).toBeVisible();
      await analyse(page);
    } finally {
      await context.close();
    }
  });
});
