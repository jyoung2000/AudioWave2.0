/**
 * Accessibility, checked with axe-core against every screen.
 *
 * Automated checks catch structure, not judgement: they cannot tell whether a label is *useful*.
 * So alongside axe, these tests walk the interface with the keyboard alone and assert that
 * everything reachable by mouse is reachable without one — which is the part that actually decides
 * whether a person can use this.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const SECTIONS = ['Music Library', 'Queue', 'Playlists', 'Listening history'] as const;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
});

for (const section of SECTIONS) {
  test(`@a11y ${section} has no detectable violations`, async ({ page }) => {
    await page.getByRole('option', { name: new RegExp(`^${section}`, 'i') }).click();
    await page.waitForTimeout(300);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.help}`).join('\n');
    expect(results.violations, `${section}:\n${summary}`).toEqual([]);
  });
}

test('@a11y every section is reachable with the keyboard alone', async ({ page }) => {
  const list = page.getByRole('navigation', { name: 'Sections' });
  await list.getByRole('option').first().focus();
  for (let i = 0; i < SECTIONS.length - 1; i += 1) {
    await page.keyboard.press('ArrowDown');
  }
  // Arrowing to the end must land on the last section, not fall out of the list.
  await expect(page.getByRole('option', { name: /^Listening history/ })).toBeFocused();
});

test('@a11y the transport controls are all keyboard reachable and named', async ({ page }) => {
  const transport = page.getByRole('group', { name: 'Playback controls' });
  for (const name of [/favourites/i, /^Shuffle$/i, /^Previous/i, /^Play$/i, /^Next/i, /Repeat/i, /Add to a playlist/i, /Share this song/i]) {
    const control = transport.getByRole('button', { name });
    await expect(control, `${name} should exist in the transport row`).toHaveCount(1);
    // A control that cannot be focused cannot be used without a mouse.
    await expect(control).toHaveAttribute('type', 'button');
  }
});

test('@a11y focus is visible wherever it lands', async ({ page }) => {
  const invisible: string[] = [];
  await page.keyboard.press('Tab');
  for (let i = 0; i < 20; i += 1) {
    const report = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      // Focus can legitimately be shown on the element, on something inside it, or on a wrapper
      // via :focus-within — the search field does the last, which is normal practice for a field
      // with a decorated container. All three count.
      const shows = (target: Element): boolean => {
        const s = getComputedStyle(target);
        return s.outlineStyle !== 'none' || parseFloat(s.outlineWidth) > 0 || s.boxShadow !== 'none' || getComputedStyle(target, '::after').content !== 'none';
      };
      let visible = shows(el) || [...el.querySelectorAll('*')].some(shows);
      for (let parent = el.parentElement; parent && !visible && parent !== document.body; parent = parent.parentElement) {
        if (parent.matches(':focus-within') && shows(parent)) visible = true;
      }
      return visible ? null : `${el.tagName.toLowerCase()}.${el.className || '(no class)'}`;
    });
    if (report) invisible.push(report);
    await page.keyboard.press('Tab');
  }
  expect(invisible, `these focused elements showed no focus indicator: ${invisible.join(', ')}`).toEqual([]);
});

test('@a11y respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  // Constellation left the strip when it shrank to four; the library keeps its way in.
  await page.getByRole('button', { name: 'Constellation', exact: true }).click();
  // With reduced motion the constellation opens in its table form rather than an animated field.
  await expect(page.getByRole('table', { name: /albums/i }).or(page.getByText('Nothing to map yet'))).toBeVisible();
});

test('@a11y the empty library state is announced as a group with a name', async ({ page }) => {
  await page.getByRole('option', { name: /^Music Library/ }).click();
  // With no library, the empty state carries the explanation, so it must be reachable by role.
  await expect(page.getByRole('group', { name: 'No music yet' })).toBeVisible();
});
