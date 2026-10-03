/**
 * The mockups, checked the way the page asks you to check them.
 *
 * The styleguide's device frames exist to answer one question — *does this fit, on that?* — and the
 * answer is a measurement taken inside a real viewport rather than an opinion about a picture. These
 * tests read that measurement back for every screen at every size, which makes "readable, and
 * nothing cut off on any device" a gate rather than a claim.
 *
 * Two of them guard mistakes already made once. A frame whose touch layer silently fails to apply
 * shows desktop sizes in a phone-shaped box and reports them as passing, which is worse than no
 * mockup at all; and a fit summary that only counts page overflow calls a window that has clipped
 * its own search field "nothing off the side".
 */
import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PAGE = `file://${fileURLToPath(new URL('../../../../docs/design/styleguide.html', import.meta.url))}`;

/** The frames are heavy; one page for the whole file, and each test drives the controls it needs. */
async function open(page: Page): Promise<void> {
  await page.goto(PAGE);
  await expect(page.locator('#mockups')).toBeVisible();
  await page.locator('#mockups').scrollIntoViewIfNeeded();
  await expect(page.locator('.sg-mockups__frame').first()).toBeVisible();
}

function products(page: Page) {
  return page.locator('.sg-mockups__controls').locator('xpath=.//*[@role="radiogroup" or @role="tablist"]//*[self::button or @role="radio" or @role="tab"]');
}

/** Tick every size. The inputs sit under their labels, so the click goes to the input itself. */
async function everySize(page: Page): Promise<void> {
  const boxes = page.locator('.sg-mockups__devices input[type="checkbox"]');
  for (let i = 0; i < (await boxes.count()); i += 1) {
    const box = boxes.nth(i);
    if (!(await box.isChecked())) await box.evaluate((el: HTMLInputElement) => el.click());
  }
}

interface FitRow {
  caption: string;
  offenders: string[];
}

async function fitRows(page: Page): Promise<FitRow[]> {
  // Two frames' worth of layout and measurement; the report is written after it settles.
  await page.waitForTimeout(1500);
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.sg-mockups__frame')).map((figure) => ({
      caption: figure.querySelector('figcaption')?.textContent?.trim() ?? '',
      offenders: Array.from(figure.querySelectorAll('.sg-fit__list li')).map((item) => item.textContent ?? ''),
    })),
  );
}

test('a frame is a real viewport, not a phone-shaped box', async ({ page }) => {
  await open(page);
  const widths = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLIFrameElement>('.sg-mockups__frame iframe')).map((iframe) => iframe.contentWindow?.innerWidth ?? 0),
  );
  // The defaults are the phone and the laptop, and the point of the whole section is that these are
  // the numbers the media queries inside are answering.
  expect(widths).toEqual([390, 1280]);
});

test('the touch layer is applied inside a touch frame, and only there', async ({ page }) => {
  await open(page);
  const heights = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLIFrameElement>('.sg-mockups__frame iframe')).map((iframe) => {
      const doc = iframe.contentDocument;
      const header = doc?.querySelector('.library th');
      return { touchCss: doc?.getElementById('np-touch-layer')?.textContent?.length ?? 0, header: header ? (doc?.defaultView?.getComputedStyle(header).height ?? '') : '' };
    }),
  );
  const [phone, laptop] = heights;
  // An iframe inherits the host's pointer, so this layer is derived from the stylesheets and
  // re-applied — and the derivation reads the frame's own CSSOM, where the rule classes belong to
  // the frame's realm. An `instanceof` against the outer page's `CSSMediaRule` matches nothing at
  // all, which is a silent, total failure: every frame would show desktop sizes and pass.
  expect(phone?.touchCss).toBeGreaterThan(1000);
  expect(phone?.header).toBe('44px');
  expect(laptop?.touchCss).toBe(0);
  expect(laptop?.header).not.toBe('44px');
});

test('every screen of every product fits at every size', async ({ page }) => {
  test.slow();
  await open(page);
  await everySize(page);

  const failures: string[] = [];
  const count = await products(page).count();
  for (let index = 0; index < count; index += 1) {
    const product = (await products(page).nth(index).textContent())?.trim() ?? '';
    await products(page).nth(index).click();
    const screens = page.locator('.sg-mockups__screens button');
    for (let screen = 0; screen < (await screens.count()); screen += 1) {
      const name = (await screens.nth(screen).textContent())?.trim() ?? '';
      await screens.nth(screen).click();
      for (const row of await fitRows(page)) {
        for (const offender of row.offenders) failures.push(`${product} · ${name} · ${row.caption}: ${offender}`);
      }
    }
  }
  // Printed in full rather than counted: the value of this test is the list.
  expect(failures, failures.join('\n')).toHaveLength(0);
});

test('a control a window has clipped is reported, though the page never widened', async ({ page }) => {
  await open(page);
  await products(page).nth(1).click();
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.sg-mockups__frame iframe')?.contentDocument;
    const planted = doc?.createElement('div');
    if (!planted || !doc) throw new Error('no frame');
    planted.textContent = 'planted';
    planted.style.cssText = 'width:900px;height:10px;flex:none';
    // The Airwave window clips what overflows it (`.win { overflow: hidden }`); its status strip is
    // a row that does not scroll.
    const strip = doc.querySelector('.win > .status');
    if (!strip) throw new Error('the hub frame has no status strip');
    strip.appendChild(planted);
  });
  await page.getByRole('button', { name: 'Re-check fit' }).click();
  const [first] = await fitRows(page);
  expect(first?.offenders.join('\n')).toContain('planted');
  // A window clips rather than scrolls, so nothing about the page got wider: the summary has to
  // take the offenders into account or this reads as a pass.
  await expect(page.locator('.sg-fit').first()).toContainText('Look at this');
});

test('editing a property repaints every frame, and exports what the products read', async ({ page }) => {
  await open(page);
  await page.getByLabel('Find a property').fill('--np-accent');
  const field = page.getByRole('textbox', { name: '--np-accent value' });
  await expect(field).toBeVisible();
  await field.fill('rgb(214, 74, 68)');

  await expect
    .poll(async () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLIFrameElement>('.sg-mockups__frame iframe')).map((iframe) => iframe.contentDocument?.documentElement.style.getPropertyValue('--np-accent') ?? ''),
      ),
    )
    .toEqual(['rgb(214, 74, 68)', 'rgb(214, 74, 68)']);

  // What comes out is a block for the stylesheet the library's consumers import, not a note to self.
  await expect(page.locator('.sg-editor__out')).toContainText('--np-accent: rgb(214, 74, 68);');
  await expect(page.locator('.sg-editor__out')).toContainText('overrides.css');

  await page.getByRole('button', { name: 'Reset everything' }).click();
  await expect
    .poll(async () => page.evaluate(() => document.querySelector<HTMLIFrameElement>('.sg-mockups__frame iframe')?.contentDocument?.documentElement.style.getPropertyValue('--np-accent') ?? ''))
    .toBe('');
});

test('the Airwave windows wear the design’s stylesheets and AquaArt, and nothing from the library', async ({ page }) => {
  await open(page);
  for (const index of [1, 2]) {
    await products(page).nth(index).click();
    await page.waitForTimeout(800);
    const frame = await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.sg-mockups__frame iframe')?.contentDocument;
      const root = doc?.documentElement;
      const push = doc?.querySelector('.push');
      return {
        sheets: doc ? Array.from(doc.querySelectorAll('style')).map((style) => style.id || 'cloned') : [],
        button: root?.style.getPropertyValue('--aq-btn-22').slice(0, 24) ?? '',
        worn: push ? (doc?.defaultView?.getComputedStyle(push).borderImageSource ?? '') : '',
        libraryToken: root ? (doc?.defaultView?.getComputedStyle(root).getPropertyValue('--aqua-focus') ?? '') : 'missing',
        window: Boolean(doc?.querySelector('.win > .chrome .toolbar [role="tab"]')),
      };
    });
    // Only the reset and the product's own stylesheet: none of the host page's sheets were cloned in.
    expect(frame.sheets.filter((id) => id === 'cloned')).toHaveLength(1);
    expect(frame.sheets).toContain('np-product-css');
    expect(frame.libraryToken.trim()).toBe('');
    expect(frame.button).toContain('url("data:image/svg+xml');
    expect(frame.worn).toContain('data:image/svg+xml');
    expect(frame.window).toBe(true);
  }
});

test('an Airwave window property is edited in the frames and exported as a design change, not an override', async ({ page }) => {
  await open(page);
  await products(page).nth(1).click();
  await page.getByLabel('Find a property').fill('--win-body');
  const field = page.getByRole('textbox', { name: '--win-body value' });
  await expect(field).toBeVisible();
  await field.fill('#dddddd');
  await expect
    .poll(async () => page.evaluate(() => document.querySelector<HTMLIFrameElement>('.sg-mockups__frame iframe')?.contentDocument?.documentElement.style.getPropertyValue('--win-body') ?? ''))
    .toBe('#dddddd');
  await expect(page.locator('.sg-editor__out')).toContainText('--win-body: #dddddd;');
  await expect(page.locator('.sg-editor__out')).toContainText('pnpm build:window-css');
  await expect(page.locator('.sg-editor__out')).not.toContainText(':root:root');
});
