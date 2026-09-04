/**
 * Render the app and tray icons from the committed SVGs.
 *
 * The SVGs are the source; the PNG and ICO files beside them are build outputs that happen to be
 * committed, because electron-builder needs them on a machine that has no browser. Re-run this
 * script after editing an SVG.
 *
 * The ICO is assembled here rather than by a tool: the format is a small header plus, for Vista and
 * later, whole PNG files embedded verbatim. Writing 22 bytes of header is less work than adding a
 * dependency that shells out to ImageMagick.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, '..', 'resources');

/** Windows uses every size from 16 up; supplying them stops Explorer from scaling 256 down badly. */
const APP_SIZES = [16, 24, 32, 48, 64, 128, 256];
const TRAY_SIZES = [16, 32];

async function renderSvg(browser, svgPath, size) {
  const svg = readFileSync(svgPath, 'utf8');
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  const png = await page.screenshot({ omitBackground: true, type: 'png' });
  await page.close();
  return png;
}

/** ICO directory: 6-byte header, then one 16-byte entry per image, then the PNG payloads. */
export function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach((image, index) => {
    const at = index * 16;
    // 256 is stored as 0 — the field is one byte, and 256 does not fit.
    entries.writeUInt8(image.size >= 256 ? 0 : image.size, at);
    entries.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
    entries.writeUInt8(0, at + 2); // palette colours: 0 for truecolour
    entries.writeUInt8(0, at + 3); // reserved
    entries.writeUInt16LE(1, at + 4); // colour planes
    entries.writeUInt16LE(32, at + 6); // bits per pixel
    entries.writeUInt32LE(image.data.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });
  return Buffer.concat([header, entries, ...images.map((i) => i.data)]);
}

const browser = await chromium.launch(process.env['PW_CHROMIUM_PATH'] ? { executablePath: process.env['PW_CHROMIUM_PATH'] } : {});
try {
  const app = [];
  for (const size of APP_SIZES) app.push({ size, data: await renderSvg(browser, join(resources, 'icon.svg'), size) });
  writeFileSync(join(resources, 'icon.ico'), packIco(app));
  writeFileSync(join(resources, 'icon-256.png'), app.find((i) => i.size === 256).data);

  const tray = [];
  for (const size of TRAY_SIZES) tray.push({ size, data: await renderSvg(browser, join(resources, 'tray.svg'), size) });
  writeFileSync(join(resources, 'tray.ico'), packIco(tray));
  for (const image of tray) writeFileSync(join(resources, `tray-${image.size}.png`), image.data);

  process.stdout.write(`Wrote icon.ico (${APP_SIZES.length} sizes), tray.ico (${TRAY_SIZES.length} sizes) and PNGs into resources/\n`);
} finally {
  await browser.close();
}
