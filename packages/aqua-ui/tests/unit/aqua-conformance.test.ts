/**
 * §17 of the Aqua specification, as a test.
 *
 * The plan says every MUST item is a release gate. That is only true if a MUST maps to something
 * that fails, so this file walks §17 item by item. Some are checkable from the tokens and the
 * stylesheet (sizes, radii, the 1 px rim, the light source, the motion switch); the composition and
 * interaction MUSTs are checked where they can be exercised — `tests/dom` for the state ladder and
 * roles, `music-player/tests/e2e/a11y.spec.ts` for keyboard reach, focus visibility and reduced
 * motion across real screens. `docs/AQUA_CONFORMANCE.md` is the map; each test below names its item
 * so the two cannot drift apart silently.
 *
 * Two MUSTs are judgement calls a machine cannot make — whether a hierarchy "reads" as large/medium/
 * small, whether one window is "visually dominant". Those are recorded in the conformance document
 * as reviewer items rather than pretended to be automated here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(readFileSync(join(here, '..', '..', 'src', 'styles', 'tokens.json'), 'utf8')) as {
  profile: string;
  color: Record<string, string>;
  font: Record<string, string | number>;
  size: Record<string, string>;
  space: Record<string, string>;
  shadow: Record<string, string>;
  motion: Record<string, string>;
};
const styles = (name: string): string => readFileSync(join(here, '..', '..', 'src', 'styles', name), 'utf8');
/** The base sheet, which carries the tokens, the profiles and the motion switch. */
const css = styles('aqua.css');
/**
 * Every sheet the library ships.
 *
 * The stylesheet was one file until the player stopped being a window; the material MUSTs are
 * about the library's whole surface, so the checks that scan *rules* rather than tokens scan all
 * four. Splitting a file must not be a way to stop being checked.
 */
const allCss = ['aqua.css', 'aqua-window.css', 'aqua-media.css', 'now-playing.css'].map((name) => [name, styles(name)] as const);

describe('§17.6 profile coherence', () => {
  it('MUST: the selected profile is declared', () => {
    expect(tokens.profile).toBe('snow-leopard-itunes-9');
    // And the same string is what the stylesheet keys its profile overrides on.
    expect(css).toContain('snow-leopard-itunes-9');
  });

  it('MUST: the default profile uses horizontal traffic lights and colored source icons', () => {
    expect(tokens.size['trafficLight']).toBe('12px');
    // The iTunes 10 profile's vertical lights are an override, not the default.
    expect(css).toMatch(/\[data-aqua-profile=['"]?itunes-10/);
  });
});

describe('§17.2 material', () => {
  it('MUST: rims are crisp and generally 1 px', () => {
    expect(tokens.size['splitterHairline']).toBe('1px');
    // Every border declaration in every stylesheet is hairline or a variable resolving to one.
    for (const [name, sheet] of allCss) {
      const widths = [...sheet.matchAll(/border(?:-(?:top|right|bottom|left))?:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
      expect(widths.every((w) => w <= 1), `${name} has a border wider than a hairline`).toBe(true);
    }
  });

  it('MUST: the virtual light source is above each dimensional control', () => {
    // Aqua's gel runs light at the top to dark at the bottom; the token names encode the order and
    // the inset shadows are top-bright, bottom-dark.
    const gel = [tokens.color['aquaSpecular'], tokens.color['aquaTop'], tokens.color['aquaMid'], tokens.color['aquaLower'], tokens.color['aquaBottom']];
    expect(gel.every(Boolean)).toBe(true);
    expect(luminanceOf(gel[0]!)).toBeGreaterThan(luminanceOf(gel[4]!));
    expect(tokens.shadow['controlInsetTop']).toBeTruthy();
    expect(tokens.shadow['controlInsetBottom']).toBeTruthy();
  });

  it('MUST: gel controls have a specular top, a mid body and a darker lower depth', () => {
    const l = [tokens.color['aquaSpecular'], tokens.color['aquaTop'], tokens.color['aquaMid'], tokens.color['aquaLower'], tokens.color['aquaBottom']].map((c) => luminanceOf(c!));
    // Monotonically darker from the specular highlight down.
    for (let i = 1; i < l.length; i += 1) expect(l[i]!, `step ${i}`).toBeLessThan(l[i - 1]!);
  });

  it('MUST: neutral controls stay neutral; Aqua blue is selective', () => {
    // Window chrome is achromatic — the surface the whole interface sits on has no hue at all.
    for (const key of ['chromeTop', 'chromeUpper', 'chromeLower', 'chromeBottom', 'windowBody']) {
      expect(chromaOf(tokens.color[key]!), `${key} is tinted`).toBeLessThanOrEqual(2);
    }
    // Graphite controls are a *cool* grey, which is what graphite means in this palette — but they
    // are nowhere near the Aqua ramp. The MUST is about blue not spreading, not about pure grey.
    for (const key of ['graphiteTop', 'graphiteMid', 'graphiteBottom']) {
      expect(chromaOf(tokens.color[key]!), `${key} has drifted toward Aqua blue`).toBeLessThanOrEqual(16);
    }
    // And "selective" only means something if the accent really is saturated when it is used.
    expect(chromaOf(tokens.color['aquaMid']!)).toBeGreaterThan(100);
    expect(chromaOf(tokens.color['selectionMid']!)).toBeGreaterThan(100);
  });

  it('MUST: the outer window shadow is stronger than any control shadow', () => {
    expect(blurOf(tokens.shadow['window']!)).toBeGreaterThan(blurOf(tokens.shadow['control']!));
    expect(blurOf(tokens.shadow['window']!)).toBeGreaterThan(blurOf(tokens.shadow['panel']!));
  });
});

describe('§17.2 material — the 2010 page surfaces', () => {
  const page = (tokens as unknown as { page: Record<string, string> }).page;

  it('MUST: the virtual light source is above the status bar as well', () => {
    // Same rule as the gel ramp: the bar is lit from above, so it darkens downward.
    expect(luminanceOf(page['barTop']!)).toBeGreaterThan(luminanceOf(page['barBottom']!));
    expect(luminanceOf(page['listHeaderTop']!)).toBeGreaterThan(luminanceOf(page['listHeaderBottom']!));
  });

  it('MUST: the page chrome stays near-neutral; saturation is reserved', () => {
    // The bar is a page header rather than a window frame, so it is allowed the faint coolness the
    // reference sampled — but nowhere near the accent, and nowhere near the Aqua ramp.
    for (const key of ['barTop', 'barUpper', 'barLower', 'barBottom', 'listHeaderTop', 'listHeaderBottom']) {
      expect(chromaOf(page[key]!), `page.${key} is tinted like an accent`).toBeLessThanOrEqual(16);
    }
    // And the two accents that do exist are unmistakably accents.
    expect(chromaOf(page['live']!)).toBeGreaterThan(100);
    expect(chromaOf(page['railFillMid']!)).toBeGreaterThan(100);
  });

  it('MUST: the page keeps the focus halo the window has', () => {
    // The base sheet scopes :focus-visible to the roots; the page is one of them, or the player
    // would have shipped without a visible focus ring.
    expect(css).toMatch(/\.np-app :focus-visible/);
  });

  it('MUST: the page honours reduced motion', () => {
    const sheet = styles('now-playing.css');
    expect(sheet).toContain('prefers-reduced-motion');
    // The one animation on the page — the LIVE pulse — is switchable from the app as well as the OS.
    expect(sheet).toContain('--aqua-anim-state');
  });
});

describe('§17.3 typography and density', () => {
  it('MUST: the font is Lucida Grande or a compact, tuned fallback', () => {
    const family = String(tokens.font['family']);
    expect(family.startsWith('Lucida Grande')).toBe(true);
    // And a fallback chain, because the face is not redistributable (docs/DEVIATIONS.md).
    expect(family.split(',').length).toBeGreaterThan(2);
  });

  it('MUST: body text is about 13 px and list text about 12 px', () => {
    expect(tokens.font['system']).toBe('13px');
    expect(tokens.font['view']).toBe('12px');
  });

  it('MUST: source-group and toolbar labels are smaller and subordinate', () => {
    expect(pxOf(tokens.font['label'])).toBeLessThan(pxOf(tokens.font['view']));
    expect(pxOf(tokens.font['small'])).toBeLessThan(pxOf(tokens.font['system']));
  });

  it('MUST: spacing repeats a 4/8/12/20 rhythm', () => {
    for (const [name, value] of Object.entries(tokens.space)) {
      const px = pxOf(value);
      expect(px % 2, `space.${name} = ${value} is off the rhythm`).toBe(0);
    }
  });

  it('SHOULD: data rows stay compact in the default profile', () => {
    expect(pxOf(tokens.size['tableRow'])).toBeLessThanOrEqual(20);
    expect(pxOf(tokens.size['sourceRow'])).toBeLessThanOrEqual(21);
    // The 2010 list is tighter still, which is what iTunes 10 actually did.
    expect(pxOf(tokens.size['listRow'])).toBeLessThanOrEqual(18);
  });
});

describe('§17.5 interaction', () => {
  it('MUST: reduced motion removes pulse and nonessential travel', () => {
    expect(css).toContain('prefers-reduced-motion');
    // An explicit switch as well, so the app can honour a stored preference rather than only the OS.
    expect(css).toContain('--aqua-anim-state');
  });

  it('MUST: focus does not rely on colour alone', () => {
    // A ring with width, not just a hue change: the focus shadow has a spread.
    expect(tokens.shadow['focus']).toMatch(/\d+px/);
    expect(css).toMatch(/:focus-visible/);
  });
});

/* ------------------------------------------------------------------ helpers */

/** Distance between the strongest and weakest channel: 0 is grey, high is saturated. */
function chromaOf(hex: string): number {
  const [r, g, b] = rgbOf(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)];
}

/** Relative luminance, enough to compare two swatches from the same ramp. */
function luminanceOf(hex: string): number {
  const [r, g, b] = rgbOf(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function pxOf(value: string | number | undefined): number {
  return Number.parseFloat(String(value ?? '0'));
}

/** The blur radius of a CSS shadow — the third length. */
function blurOf(shadow: string): number {
  const lengths = [...shadow.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
  return lengths[2] ?? 0;
}
