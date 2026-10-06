/**
 * Canvas pictures that have not really changed keep their old bytes.
 *
 * The player's disc is drawn with WebGL, and a run of frames reaches the screen a hair out of step
 * from one run to the next: the same state photographs a sub-pixel turn apart (a mean difference of
 * about 1 in 255). Markup and stylesheets are byte-identical run to run; for the pictures, a fresh
 * one that matches the committed one to within that noise is replaced by the committed one, so
 * rebuilding an unchanged app leaves the file byte-identical, and a real change (another disc, a new
 * drawing) still comes through. Compared in the browser, which decodes PNG.
 */
import { sections } from './document.mjs';

/** Pictures in a mockup file, by state id: { [state]: { [index]: dataUri } }. */
function picturesOf(html) {
  const out = {};
  for (const section of sections(html)) {
    if (section.kind !== 'state' || !section.pictures) continue;
    out[section.id] = {};
    for (const m of section.pictures.matchAll(/\[data-mock-picture="(\d+)"\] \{ background: url\("([^"]+)"\)/g)) out[section.id][m[1]] = m[2];
  }
  return out;
}

/** Mean absolute difference per channel (0–255) of two PNG data URIs, or Infinity if they differ in size. */
async function difference(page, a, b) {
  return page.evaluate(
    async ([x, y]) => {
      const load = async (uri) => createImageBitmap(await (await fetch(uri)).blob());
      const [ia, ib] = await Promise.all([load(x), load(y)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return Infinity;
      const read = (bitmap) => {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      const pa = read(ia);
      const pb = read(ib);
      let sum = 0;
      for (let i = 0; i < pa.length; i += 1) sum += Math.abs(pa[i] - pb[i]);
      return sum / pa.length;
    },
    [a, b],
  );
}

/** Below this mean difference a fresh picture is the same picture. */
const NOISE = 3;

export async function keepUnchangedPictures(browser, previousHtml, states) {
  if (!previousHtml) return 0;
  const before = picturesOf(previousHtml);
  const page = await browser.newPage();
  let kept = 0;
  try {
    for (const state of states) {
      const old = before[state.id];
      if (!old) continue;
      for (let i = 0; i < state.pictures.length; i += 1) {
        const fresh = state.pictures[i];
        const prior = old[String(i)];
        if (!fresh || !prior || fresh === prior) continue;
        if ((await difference(page, fresh, prior)) < NOISE) {
          state.pictures[i] = prior;
          kept += 1;
        }
      }
    }
  } finally {
    await page.close();
  }
  return kept;
}
