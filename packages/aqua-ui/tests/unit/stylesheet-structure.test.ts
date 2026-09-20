/**
 * Each stylesheet says everything it has to say about a selector in one place.
 *
 * `now-playing.css` had declared `:root` four times, `@media (prefers-color-scheme: dark)` seven
 * times and `@media (pointer: coarse)` six times, with the later blocks quietly overriding the
 * earlier ones — `.np-mode__item` 34px then 44px, `.np-avatar` 34px then 44px,
 * `.np-search__input` 40px then 44px. Nothing was wrong with what shipped; what was wrong is that
 * reading any one block told you nothing about what the page would actually do, and a change made
 * in the first block could be silently undone three hundred lines later.
 *
 * So: one block per selector, per file. Merging is safe precisely because it is mechanical — the
 * order of the declarations inside the merged block is preserved, so last-wins still wins.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const stylesDir = fileURLToPath(new URL('../../src/styles/', import.meta.url));
const sheets = [
  ...readdirSync(stylesDir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => [`src/styles/${name}`, `${stylesDir}${name}`] as const),
  ['styleguide/styleguide.css', fileURLToPath(new URL('../../styleguide/styleguide.css', import.meta.url))] as const,
];

/**
 * The top-level selectors of a stylesheet, in source order.
 *
 * Hand-rolled rather than regex-matched because a comment may contain `{`, `}` or `;` — several in
 * these files do — and a splitter that does not skip comments whole will cut one in half. That is
 * not hypothetical: it is how this check's own tooling first corrupted a stylesheet.
 */
function topLevelSelectors(css: string): string[] {
  const selectors: string[] = [];
  let buffer = '';
  let i = 0;
  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (css[i] === '{') {
      selectors.push(buffer.split(/\s+/).filter(Boolean).join(' '));
      let depth = 1;
      i += 1;
      while (i < css.length && depth > 0) {
        if (css[i] === '/' && css[i + 1] === '*') {
          const end = css.indexOf('*/', i + 2);
          i = end === -1 ? css.length : end + 2;
          continue;
        }
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') depth -= 1;
        i += 1;
      }
      buffer = '';
      continue;
    }
    buffer += css[i];
    i += 1;
  }
  return selectors;
}

describe.each(sheets)('%s', (name, path) => {
  const css = readFileSync(path, 'utf8');

  it('declares each top-level selector and media block exactly once', () => {
    const counts = new Map<string, number>();
    for (const selector of topLevelSelectors(css)) counts.set(selector, (counts.get(selector) ?? 0) + 1);
    const repeated = [...counts].filter(([, n]) => n > 1).map(([selector, n]) => `${selector} (${n}x)`);
    expect(repeated, `${name} repeats: ${repeated.join(', ')}. Merge them into one block, keeping the order of the declarations so last-wins still wins.`).toEqual([]);
  });

  it('has balanced braces and comments', () => {
    // The cheap check that catches a botched merge before anything else does.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments.includes('*/'), `${name} has a comment that was cut in half`).toBe(false);
    expect((css.match(/\{/g) ?? []).length).toBe((css.match(/\}/g) ?? []).length);
  });
});
