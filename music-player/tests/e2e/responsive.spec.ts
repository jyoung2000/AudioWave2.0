/**
 * Responsiveness, measured rather than eyeballed.
 *
 * The player is the same page on a 320px phone and a 1440px desktop, and the
 * design it wears was drawn for the second of those: 11px table text, 18px
 * rows, controls 19 to 22px tall. All of that is period-correct and it stays
 * on a desktop — so these tests do not ask the design to change. They ask
 * that on a touch device, where a finger is about 9mm and the screen is
 * further away than it looks, three things hold:
 *
 *   1. nothing overflows sideways, at any width down to 320px;
 *   2. no text is smaller than 12px;
 *   3. nothing interactive is smaller than 44px, counting the transparent
 *      overlay a compact control uses to take its taps.
 *
 * Each of those was broken when this file was written, and each is the kind
 * of thing that comes back quietly: a new panel with an 11px hint, a new icon
 * button at 22px. A screenshot would not catch either.
 */
import { test, expect, type Page } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../../../packages/test-fixtures/generated/audio/Marlow & the Tidewater/Quiet Arithmetic/', import.meta.url));

/** The widths that matter: the narrowest phone still sold, a common phone, and a tablet. */
const TOUCH_WIDTHS = [320, 390, 768];

const MIN_TEXT_PX = 12;
const MIN_TARGET_PX = 44;

async function loadFixtures(page: Page): Promise<void> {
  const files = readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.wav'))
    .map((name) => `${FIXTURES}${name}`);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Choose files/i }).first().click();
  await (await chooser).setFiles(files);
  await expect(page.getByRole('row').filter({ hasText: 'Quiet Arithmetic' }).first()).toBeVisible({ timeout: 20_000 });
}

/** Everything visible, measured in the page. Returns plain data so failures name the element. */
async function measure(page: Page) {
  return page.evaluate(
    ({ minText, minTarget }) => {
      const isVisible = (el: Element): boolean => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const name = (el: Element): string => {
        const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
        return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
      };
      const ownText = (el: Element): string =>
        [...el.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent ?? '')
          .join(' ')
          .trim();

      const all = [...document.querySelectorAll('body *')].filter(isVisible);
      const vw = window.innerWidth;

      // Something sticking out that no scroller contains is a layout bug.
      const inScroller = (el: Element): boolean => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
        }
        return false;
      };
      const overflowing = all
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.right <= vw + 1 && r.left >= -1) return false;
          return getComputedStyle(el).position !== 'fixed' && !inScroller(el);
        })
        .map((el) => name(el));

      const smallText = all
        .filter((el) => ownText(el).length > 1 && parseFloat(getComputedStyle(el).fontSize) < minText)
        .map((el) => `${name(el)} @${getComputedStyle(el).fontSize}`);

      // A compact control keeps its drawn size and takes taps from a
      // transparent overlay; that overlay is the real target.
      const effective = (el: Element): { w: number; h: number } => {
        const r = el.getBoundingClientRect();
        let w = r.width;
        let h = r.height;
        for (const pseudo of ['::after', '::before']) {
          const s = getComputedStyle(el, pseudo);
          if (s.content === 'none' || s.position !== 'absolute') continue;
          const pw = parseFloat(s.width);
          const ph = parseFloat(s.height);
          if (Number.isFinite(pw)) w = Math.max(w, pw);
          if (Number.isFinite(ph)) h = Math.max(h, ph);
        }
        return { w, h };
      };

      const TAGS = ['button', 'a', 'input', 'select', 'textarea'];
      const ROLES = ['button', 'link', 'option', 'tab', 'checkbox', 'slider', 'menuitem'];
      const smallTargets = all
        .filter((el) => TAGS.includes(el.tagName.toLowerCase()) || ROLES.includes(el.getAttribute('role') ?? ''))
        .filter((el) => el.getAttribute('type') !== 'hidden')
        .filter((el) => {
          const box = effective(el);
          for (const child of el.children) {
            const c = effective(child);
            box.w = Math.max(box.w, c.w);
            box.h = Math.max(box.h, c.h);
          }
          // A checkbox is tapped through its label.
          const label = el.closest('label');
          if (label) {
            const lr = label.getBoundingClientRect();
            box.w = Math.max(box.w, lr.width);
            box.h = Math.max(box.h, lr.height);
          }
          return box.w < minTarget || box.h < minTarget;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return `${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}`;
        });

      return {
        docOverflow: document.documentElement.scrollWidth - vw,
        overflowing: [...new Set(overflowing)],
        smallText: [...new Set(smallText)],
        smallTargets: [...new Set(smallTargets)],
      };
    },
    { minText: MIN_TEXT_PX, minTarget: MIN_TARGET_PX },
  );
}

test.describe('on a touch device', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const width of TOUCH_WIDTHS) {
    test(`${width}px: nothing overflows, no text under 12px, no target under 44px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
      await loadFixtures(page);

      const m = await measure(page);
      expect(m.docOverflow, `the page must not scroll sideways at ${width}px`).toBeLessThanOrEqual(0);
      expect(m.overflowing, `these stick out of the viewport at ${width}px`).toEqual([]);
      expect(m.smallText, `these are under ${MIN_TEXT_PX}px at ${width}px`).toEqual([]);
      expect(m.smallTargets, `these are under ${MIN_TARGET_PX}px at ${width}px`).toEqual([]);
    });
  }

  test('settings, where every panel of explanatory text lives', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: /^Settings —/ }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    const m = await measure(page);
    expect(m.docOverflow).toBeLessThanOrEqual(0);
    expect(m.overflowing).toEqual([]);
    expect(m.smallText).toEqual([]);
    expect(m.smallTargets).toEqual([]);
  });
});

test('the desktop keeps the design it was drawn with', async ({ page }) => {
  /*
   * The other half of the bargain. The touch layer is gated on a coarse
   * pointer, so a desktop — including a desktop window dragged narrow — keeps
   * the 2010 scale: 11px in the table, an 18px row. If this starts failing,
   * the phone rules have leaked onto the desktop and the period design is
   * quietly gone.
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await loadFixtures(page);

  const row = page.locator('.library tbody tr').first();
  await expect(row).toBeVisible();
  const metrics = await row.evaluate((el) => {
    const cell = el.querySelector('td.lib-title') as HTMLElement;
    return { rowHeight: Math.round(el.getBoundingClientRect().height), fontSize: getComputedStyle(cell).fontSize };
  });
  // 18px of cell plus its rules: the reference's row, unchanged.
  expect(metrics.rowHeight, 'the desktop list row stays as the reference drew it').toBeLessThanOrEqual(22);
  expect(metrics.fontSize).toBe('11px');
});
