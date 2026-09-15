/**
 * Platforms, through the interface.
 *
 * Two claims are checked here, and they are the two the app makes about other people's services.
 *
 * The first is that it never says it can do something a platform forbids: Settings shows Spotify
 * and YouTube as "No" for saving a file, with the reason, whether or not a hub is paired.
 *
 * The second is the route that *does* work — importing the archive a platform hands you. A real
 * .zip is built here, deflated the way a shop's download is, and dropped into the picker; the songs
 * inside have to turn up in the library as ordinary tracks.
 */
import { test, expect, type Page } from '@playwright/test';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../../../packages/test-fixtures/generated/audio/Marlow & the Tidewater/Quiet Arithmetic/', import.meta.url));

/** A zip in the shape a shop produces: a folder per album, deflated audio, a cover alongside. */
function buildZip(members: readonly { name: string; body: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const payload = deflateRawSync(member.body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x9d40, 10);
    header.writeUInt16LE(0x5a21, 12);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(member.body.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, payload);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0x9d40, 12);
    entry.writeUInt16LE(0x5a21, 14);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(member.body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + payload.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function purchaseZip(): string {
  const songs = readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.wav'))
    .slice(0, 2);
  const zip = buildZip([
    ...songs.map((name) => ({ name: `Marlow & the Tidewater - Quiet Arithmetic/${name}`, body: readFileSync(join(FIXTURES, name)) })),
    { name: 'Marlow & the Tidewater - Quiet Arithmetic/cover.jpg', body: Buffer.from('not really a jpeg') },
    { name: 'Marlow & the Tidewater - Quiet Arithmetic/thank you.txt', body: Buffer.from('thanks for buying') },
  ]);
  const path = join(mkdtempSync(join(tmpdir(), 'np-purchase-')), 'Quiet Arithmetic.zip');
  writeFileSync(path, zip);
  return path;
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Settings —/ }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
});

test('every platform says what it can and cannot do, with no hub paired', async ({ page }) => {
  await openSettings(page);
  const platforms = page.locator('.player-platforms');
  await expect(platforms).toBeVisible();

  // Ten platforms, each with its own mark rather than a grey pill.
  await expect(platforms.locator('.player-platform')).toHaveCount(10);
  await expect(platforms.locator('.player-platform__mark svg')).toHaveCount(10);

  const spotify = platforms.locator('.player-platform').filter({ hasText: 'Spotify' });
  await expect(spotify).toContainText('Save a file: No');
  await expect(spotify).toContainText('Keep offline: No');

  const youtube = platforms.locator('.player-platform').filter({ hasText: 'YouTube' });
  await expect(youtube).toContainText('Save a file: No');

  // And the reason is one click away, not buried in a document.
  await spotify.getByRole('button', { name: 'Why?' }).click();
  await expect(spotify).toContainText('no audio download');
  await expect(spotify).toContainText('Import your playlists and likes');
});

test('a purchase downloaded as a .zip becomes library tracks', async ({ page }) => {
  const archive = purchaseZip();
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /Import a \.zip/i })
    .first()
    .click();
  await (await chooser).setFiles([archive]);

  // Both songs land, under their own names, with the cover and the text file left in the archive.
  await expect(page.locator('tbody tr')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('td.lib-title').first()).not.toHaveText('cover.jpg');
  await expect(page.getByRole('heading', { name: 'Music', level: 2 })).toContainText('Music');
  await expect(page.locator('.np-section-head p')).toContainText('2 tracks');
});
