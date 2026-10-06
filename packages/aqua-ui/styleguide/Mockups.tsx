/**
 * The mockups: every product, at every size, editable.
 *
 * Three things this section is trying to be, in order of how much they matter.
 *
 * **Honest about size.** Each frame is an iframe with its own viewport, so a 320px column really is
 * a 320px viewport and the media queries behave. A scaled `div` would have looked the same and told
 * you nothing.
 *
 * **Honest about fit.** Under every frame is a measurement taken inside it: how far the page runs
 * past its own edge, the smallest text, the smallest thing you could tap. "Readable and nothing cut
 * off" is then something you can see failing rather than something a document asserts.
 *
 * **A way in, not a drawing.** The token editor reads the custom properties the stylesheets actually
 * define — not a hand-kept list, which would drift — and writes changes into every open frame at
 * once. What you get out says where each change belongs: the component library's properties go in
 * `overrides.css`; the Airwave windows' stylesheets are generated, so theirs go in the design files.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, SegmentedControl, StatusDot, TextField } from '../src/index.js';
import { DEVICES, DeviceFrame, EMPTY_FIT, type FitReport } from './DeviceFrame.js';
import { AIRWAVE_TOKEN_SOURCES } from './airwave-screens.js';
import { PRODUCTS, PRODUCT_CSS, SCREENS, type ProductId, type ProductSpec } from './screens.js';

/* ------------------------------------------------------------------ tokens */

export interface TokenDef {
  name: string;
  value: string;
  group: string;
}

const GROUPS: Array<{ prefix: string; label: string }> = [
  { prefix: '--aqua-', label: 'Aqua library (earlier window skin)' },
  { prefix: '--np-', label: 'Page skin' },
  { prefix: '--lib-', label: 'The list' },
  { prefix: '--srch-', label: 'Search popover' },
];

/**
 * Every custom property the stylesheets define on the root, read from the stylesheets themselves.
 *
 * Deliberately not read from `tokens.json`: that file is the documented source of truth for the
 * *values*, but the CSS is mirrored from it by hand, and an editor built on the list rather than on
 * the reality would offer names the page does not use the moment the two drift.
 */
export function readRootTokens(doc: Document): TokenDef[] {
  const found = new Map<string, string>();
  // Against this document's own realm, not the calling one — see the note in `touchLayerCss`.
  const view = doc.defaultView ?? window;
  const MediaRule = view.CSSMediaRule;
  const StyleRule = view.CSSStyleRule;
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (typeof MediaRule !== 'undefined' && rule instanceof MediaRule) {
        // Skip the dark scheme and the touch layer: editing a value here should change the light
        // default, and showing both sets side by side under the same name would be confusing.
        if (/prefers-color-scheme|pointer/.test(rule.conditionText)) continue;
        visit(rule.cssRules);
      } else if (typeof StyleRule !== 'undefined' && rule instanceof StyleRule && /(^|,)\s*:root\b/.test(rule.selectorText)) {
        for (const property of Array.from(rule.style)) {
          if (property.startsWith('--')) found.set(property, rule.style.getPropertyValue(property).trim());
        }
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // Unreadable stylesheet; there are none in this build.
    }
  }
  return [...found.entries()]
    .map(([name, value]) => ({ name, value, group: GROUPS.find((group) => name.startsWith(group.prefix))?.label ?? 'Other' }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

/**
 * The Airwave windows' custom properties, read from the stylesheets the hub and the companion load.
 *
 * Those sheets are not on this page — they would restyle it — so they are read as text: every
 * declaration in a top-level rule whose selector names `:root`. A name the component library also
 * defines stays the library's.
 */
export function readAirwaveTokens(known: ReadonlySet<string>): TokenDef[] {
  const found = new Map<string, TokenDef>();
  for (const source of AIRWAVE_TOKEN_SOURCES) {
    const text = source.css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of text.matchAll(/(?:^|\})\s*([^{}@]*:root[^{}]*)\{([^{}]*)\}/g)) {
      for (const declaration of rule[2]!.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
        const name = declaration[1]!;
        if (!known.has(name) && !found.has(name)) found.set(name, { name, value: declaration[2]!.trim(), group: source.label });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

const COLOUR = /^(#|rgb|hsl|color\()/i;

/**
 * The CSS to paste back.
 *
 * `:root:root` rather than `:root` on purpose: it is the same element, so it changes nothing about
 * what is selected, but it carries one more point of specificity — which means the block wins
 * wherever it is imported from, instead of depending on which stylesheet a product happens to load
 * last. Overrides that only work in some import orders are worse than no overrides.
 */
export function overridesCss(edits: Readonly<Record<string, string>>, airwave: ReadonlySet<string> = new Set()): string {
  const all = Object.keys(edits).sort();
  if (!all.length) return '/* Nothing overridden yet. */\n';
  const line = (name: string): string => `  ${name}: ${edits[name]!};`;
  const windowNames = all.filter((name) => airwave.has(name));
  const names = all.filter((name) => !airwave.has(name));
  // The Airwave windows never load overrides.css: their stylesheets are generated from the designs.
  const windowBlock = windowNames.length
    ? `/*\n * Airwave window properties (hub, companion). These do not go in overrides.css: the window\n * stylesheets are generated. Change the same properties in the :root block of\n * design/frontends/origin/airwave-companion.html and airwave-hub.html, then run pnpm build:window-css.\n * (--ink-quiet, --success-ink, --danger-ink and --link are the hub's, in docker-container/src/web/styles.css.)\n */\n:root {\n${windowNames.map(line).join('\n')}\n}\n`
    : '';
  if (!names.length) return windowBlock;
  const body = names.map(line).join('\n');
  return `/*\n * Written from the styleguide's token editor.\n *\n * Save this over packages/aqua-ui/src/styles/overrides.css and rebuild: whatever imports the\n * component library reads these — the player's React interface, the gallery and this guide. The\n * Airwave windows (hub, companion) do not load that stylesheet.\n */\n:root:root {\n${body}\n}\n${windowBlock ? `\n${windowBlock}` : ''}`;
}

/* ------------------------------------------------------------------ frames */

function FitLine({ report, touch, touchFloors = true }: { report: FitReport; touch: boolean; touchFloors?: boolean }) {
  const held = touch && touchFloors;
  const cut = report.overflowPx > 0;
  const small = report.smallestTextPx < (held ? 12 : 10);
  const tight = held && report.smallestTargetPx < 44;
  // The offenders decide as much as the three numbers do: something clipped by a window never makes
  // the page any wider, so a screen can lose a control entirely and still read as "nothing off the
  // side" if the summary is all you look at.
  const good = !cut && !small && !tight && !report.offenders.length;
  return (
    <div className="sg-fit">
      <span className="sg-fit__row">
        <StatusDot kind={good ? 'ok' : 'warning'} label={good ? 'Fits' : 'Look at this'} />
        <span>{cut ? `${report.overflowPx}px off the side` : 'nothing off the side'}</span>
        <span>· smallest text {Number.isFinite(report.smallestTextPx) ? `${Math.round(report.smallestTextPx)}px` : '—'}</span>
        {touch ? <span>· smallest target {Number.isFinite(report.smallestTargetPx) ? `${Math.round(report.smallestTargetPx)}px` : '—'}</span> : null}
        {touch && !touchFloors ? <span className="sg-dim">· desktop density, not held to 44px (DEC-027)</span> : null}
      </span>
      {report.offenders.length ? (
        <ul className="sg-fit__list">
          {report.offenders.map((offender) => (
            <li key={offender}>{offender}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ section */

export function Mockups() {
  const [product, setProduct] = useState<ProductId>('player');
  const spec: ProductSpec = PRODUCTS.find((item) => item.id === product) ?? PRODUCTS[0]!;
  const screensFor = SCREENS.filter((screen) => screen.product === product);
  const [screenId, setScreenId] = useState(screensFor[0]?.id ?? '');
  const screen = screensFor.find((item) => item.id === screenId) ?? screensFor[0];

  const [deviceIds, setDeviceIds] = useState<string[]>(['phone', 'laptop']);
  const [fit, setFit] = useState<Record<string, FitReport>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [revision, setRevision] = useState(0);

  const tokens = useMemo(() => {
    const library = typeof document === 'undefined' ? [] : readRootTokens(document);
    return [...library, ...readAirwaveTokens(new Set(library.map((token) => token.name)))];
  }, []);
  const airwaveNames = useMemo(() => new Set(tokens.filter((token) => token.group.startsWith('Airwave')).map((token) => token.name)), [tokens]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return [] as TokenDef[];
    return tokens.filter((token) => token.name.includes(needle) || token.group.toLowerCase().includes(needle)).slice(0, 60);
  }, [tokens, filter]);

  const offered = DEVICES.filter((device) => spec.devices.includes(device.id));
  const devices = offered.filter((device) => deviceIds.includes(device.id));
  const report = useCallback((id: string) => (next: FitReport) => setFit((all) => (sameFit(all[id], next) ? all : { ...all, [id]: next })), []);

  const chooseProduct = (next: string): void => {
    const id = next as ProductId;
    setProduct(id);
    setScreenId(SCREENS.find((item) => item.product === id)?.id ?? '');
    setDeviceIds([...(PRODUCTS.find((item) => item.id === id)?.shown ?? ['phone', 'laptop'])]);
    setFit({});
  };

  // The PDF export asks for every screen at once; see PrintMatrix.
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const start = (): void => setPrinting(true);
    window.addEventListener('sg:print', start);
    return () => window.removeEventListener('sg:print', start);
  }, []);

  return (
    <div className="sg-mockups">
      <p className="sg-print-only sg-note">
        In print, every screen is shown at two of its product’s sizes with the fit measured inside each frame. The interactive version — every size, the product switch and the
        token editor — is <code>docs/design/styleguide.html</code>.
      </p>
      {printing ? <PrintMatrix /> : null}
      <div className="sg-mockups__controls">
        <SegmentedControl label="Product" value={product} onChange={chooseProduct} segments={PRODUCTS.map((item) => ({ value: item.id, label: item.label, showLabel: true }))} />

        <div className="sg-mockups__screens" role="group" aria-label="Screen">
          {screensFor.map((item) => (
            <Button key={item.id} size="small" aria-pressed={item.id === screen?.id} onClick={() => setScreenId(item.id)}>
              {item.label}
            </Button>
          ))}
        </div>

        <fieldset className="sg-mockups__devices">
          <legend>Sizes</legend>
          {offered.map((device) => (
            <Checkbox
              key={device.id}
              checked={deviceIds.includes(device.id)}
              onChange={(event) => {
                // Read the box here, not inside the updater: React has released the event by the time a queued updater runs.
                const on = event.currentTarget.checked;
                setDeviceIds((all) => (on ? [...all.filter((id) => id !== device.id), device.id] : all.filter((id) => id !== device.id)));
              }}
            >
              {`${device.label} · ${device.width}`}
            </Checkbox>
          ))}
        </fieldset>
      </div>

      <p className="sg-note sg-mockups__note">
        <b>{spec.skin}.</b> {spec.note}
      </p>
      {screen ? <p className="sg-note sg-mockups__note">{screen.note}</p> : null}

      <div className="sg-mockups__frames">
        {devices.map((device) => (
          <figure key={`${device.id}-${screen?.id ?? ''}`} className="sg-mockups__frame">
            <figcaption>
              <strong>{device.label}</strong> <span className="sg-dim">{device.width} × {device.height}</span>
              {device.touch ? <span className="sg-tag">touch layer emulated</span> : null}
            </figcaption>
            <DeviceFrame device={device} scale={scaleFor(device.width)} tokens={edits} css={PRODUCT_CSS[product]} isolated={spec.isolated} prepare={spec.prepare} touchFloors={spec.touchFloors} revision={revision} onFit={report(`${device.id}-${screen?.id ?? ''}`)}>
              {screen?.render()}
            </DeviceFrame>
            <FitLine report={fit[`${device.id}-${screen?.id ?? ''}`] ?? EMPTY_FIT} touch={device.touch} touchFloors={spec.touchFloors} />
            {device.note ? <p className="sg-dim sg-mockups__why">{device.note}</p> : null}
          </figure>
        ))}
      </div>

      <div className="sg-editor">
        <h4>Change something</h4>
        <p className="sg-note">
          Type part of a property name — <code>selection</code>, <code>radius</code>, <code>font</code> — and edit it. Every frame above repaints as you type, at every size, so a change is checked
          against a phone and a desktop in the same glance. Nothing here touches the repository until you export it.
        </p>
        <TextField label="Find a property" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="selection, radius, font, bar…" autoComplete="off" spellCheck={false} />

        {filter.trim() && !shown.length ? <p className="sg-note">Nothing matches “{filter.trim()}”. There are {tokens.length} properties in total.</p> : null}

        <ul className="sg-editor__list">
          {shown.map((token) => {
            const value = edits[token.name] ?? token.value;
            return (
              <li key={token.name}>
                <code>{token.name}</code>
                <span className="sg-dim">{token.group}</span>
                {COLOUR.test(value) ? (
                  <input type="color" aria-label={token.name} value={toHex(value)} onChange={(event) => setEdits((all) => ({ ...all, [token.name]: event.currentTarget.value }))} />
                ) : null}
                <input
                  type="text"
                  aria-label={`${token.name} value`}
                  className="sg-editor__text"
                  value={value}
                  onChange={(event) => setEdits((all) => ({ ...all, [token.name]: event.currentTarget.value }))}
                  spellCheck={false}
                />
                {edits[token.name] ? (
                  <Button
                    size="mini"
                    onClick={() =>
                      setEdits((all) => {
                        const { [token.name]: _removed, ...rest } = all;
                        return rest;
                      })
                    }
                  >
                    Reset
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>

        <div className="sg-row">
          <Button onClick={() => setRevision((r) => r + 1)}>Re-check fit</Button>
          <Button disabled={!Object.keys(edits).length} onClick={() => setEdits({})}>
            Reset everything
          </Button>
          <Button variant="default" disabled={!Object.keys(edits).length} onClick={() => void copy(overridesCss(edits, airwaveNames))}>
            Copy the CSS
          </Button>
        </div>

        {Object.keys(edits).length ? (
          <>
            <p className="sg-note">
              Component-library properties go in <code>packages/aqua-ui/src/styles/overrides.css</code>, which whatever imports the library reads. Airwave window properties go in the
              design files, because <code>airwave-window.css</code> and <code>airwave-hub.css</code> are generated from them (<code>pnpm build:window-css</code>). The block below says which is which.
            </p>
            <pre className="sg-editor__out">{overridesCss(edits, airwaveNames)}</pre>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Every screen, for the PDF.
 *
 * Paper cannot hold a picker, so print gets the whole matrix instead: each screen on its own page at
 * two of its product's sizes — the laptop frame across the top and the phone frame under it for the
 * player and the hub, the window as it opens and at its smallest for the companion — both measured
 * the same way as on screen. The page is marked ready only when every frame has reported, so the export never prints
 * a frame that has not laid out yet.
 */
const PRINT_SCALES: Readonly<Record<string, number>> = { laptop: 0.53, phone: 0.56, window: 0.62, 'window-min': 0.62 };

/** The wide frame first, as the page lays them out. */
function printSizes(product: ProductSpec | undefined): Array<{ deviceId: string; scale: number }> {
  const ids = [...(product?.shown ?? ['phone', 'laptop'])].sort((a, b) => (DEVICES.find((d) => d.id === b)?.width ?? 0) - (DEVICES.find((d) => d.id === a)?.width ?? 0));
  return ids.map((deviceId) => ({ deviceId, scale: PRINT_SCALES[deviceId] ?? 0.5 }));
}

/** One object for every print frame, so a re-render does not look like a token change. */
const NO_TOKENS: Readonly<Record<string, string>> = {};

function PrintMatrix() {
  const [reports, setReports] = useState<Record<string, FitReport>>({});
  const expected = SCREENS.length * 2;
  const report = useCallback((key: string) => (next: FitReport) => setReports((all) => (sameFit(all[key], next) ? all : { ...all, [key]: next })), []);

  useEffect(() => {
    if (Object.keys(reports).length >= expected) document.documentElement.dataset['styleguidePrintReady'] = 'true';
  }, [reports, expected]);

  return (
    <div className="sg-print-matrix">
      {SCREENS.map((screen) => {
        const product = PRODUCTS.find((item) => item.id === screen.product);
        return (
          <figure key={screen.id} className="sg-print-screen">
            <figcaption>
              <span className="sg-dim">
                {product?.label} · {product?.skin}
              </span>
              <b>{screen.label}</b>
              <span>{screen.note}</span>
            </figcaption>
            <div className="sg-print-screen__frames">
              {printSizes(product).map(({ deviceId, scale }) => {
                const device = DEVICES.find((item) => item.id === deviceId)!;
                const key = `${screen.id}-${device.id}`;
                return (
                  <div key={key} className={`sg-print-screen__frame sg-print-screen__frame--${device.id === 'laptop' ? 'laptop' : 'phone'}`}>
                    <DeviceFrame device={device} scale={scale} tokens={NO_TOKENS} css={PRODUCT_CSS[screen.product]} isolated={product?.isolated} prepare={product?.prepare} touchFloors={product?.touchFloors} onFit={report(key)}>
                      {screen.render()}
                    </DeviceFrame>
                    <div className="sg-print-screen__meta">
                      <b>{device.label}</b>{' '}
                      <span className="sg-dim">
                        {device.width} × {device.height}, shown at {Math.round(scale * 100)}%
                      </span>
                      {device.touch ? <span className="sg-tag">touch layer emulated</span> : null}
                      <FitLine report={reports[key] ?? EMPTY_FIT} touch={device.touch} touchFloors={product?.touchFloors} />
                    </div>
                  </div>
                );
              })}
            </div>
          </figure>
        );
      })}
    </div>
  );
}

/** Frames wider than the column get shrunk to fit; the viewport inside is untouched. */
function scaleFor(width: number): number {
  // The work column, not the window: the rail and the page padding take their share first.
  const chrome = typeof window !== 'undefined' && window.innerWidth > 900 ? 212 + 68 + 8 : 36 + 8;
  const room = typeof window === 'undefined' ? 1100 : Math.min(window.innerWidth - chrome, 1400);
  return width > room ? Math.max(0.35, room / width) : 1;
}

function sameFit(a: FitReport | undefined, b: FitReport): boolean {
  return !!a && a.overflowPx === b.overflowPx && a.smallestTextPx === b.smallestTextPx && a.smallestTargetPx === b.smallestTargetPx && a.offenders.join('|') === b.offenders.join('|');
}

/** `<input type="color">` only speaks six-digit hex, so anything else shows as its nearest hex. */
function toHex(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) return `#${trimmed.slice(1).split('').map((c) => c + c).join('')}`;
  const match = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(trimmed);
  if (match) return `#${[match[1], match[2], match[3]].map((part) => Math.round(Number(part)).toString(16).padStart(2, '0')).join('')}`;
  return '#000000';
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard refused — the block is on screen to select by hand, which is why it is printed.
  }
}
