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
 * once. What you get out is the CSS the products already read, so the round trip from "that blue is
 * wrong" to "the apps have a different blue" is paste one block and rebuild.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, SegmentedControl, StatusDot, TextField } from '../src/index.js';
import { DEVICES, DeviceFrame, EMPTY_FIT, type FitReport } from './DeviceFrame.js';
import { PRODUCTS, PRODUCT_CSS, SCREENS, type ProductId } from './screens.js';

/* ------------------------------------------------------------------ tokens */

export interface TokenDef {
  name: string;
  value: string;
  group: string;
}

const GROUPS: Array<{ prefix: string; label: string }> = [
  { prefix: '--aqua-', label: 'Window skin' },
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

const COLOUR = /^(#|rgb|hsl|color\()/i;

/**
 * The CSS to paste back.
 *
 * `:root:root` rather than `:root` on purpose: it is the same element, so it changes nothing about
 * what is selected, but it carries one more point of specificity — which means the block wins
 * wherever it is imported from, instead of depending on which stylesheet a product happens to load
 * last. Overrides that only work in some import orders are worse than no overrides.
 */
export function overridesCss(edits: Readonly<Record<string, string>>): string {
  const names = Object.keys(edits).sort();
  if (!names.length) return '/* Nothing overridden yet. */\n';
  const body = names.map((name) => `  ${name}: ${edits[name]!};`).join('\n');
  return `/*\n * Written from the styleguide's token editor.\n *\n * Save this over packages/aqua-ui/src/styles/overrides.css and rebuild: every product reads these,\n * because every product imports that stylesheet through the component library.\n */\n:root:root {\n${body}\n}\n`;
}

/* ------------------------------------------------------------------ frames */

function FitLine({ report, touch }: { report: FitReport; touch: boolean }) {
  const cut = report.overflowPx > 0;
  const small = report.smallestTextPx < (touch ? 12 : 10);
  const tight = touch && report.smallestTargetPx < 44;
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
  const screensFor = SCREENS.filter((screen) => screen.product === product);
  const [screenId, setScreenId] = useState(screensFor[0]?.id ?? '');
  const screen = screensFor.find((item) => item.id === screenId) ?? screensFor[0];

  const [deviceIds, setDeviceIds] = useState<string[]>(['phone', 'laptop']);
  const [fit, setFit] = useState<Record<string, FitReport>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [revision, setRevision] = useState(0);

  const tokens = useMemo(() => (typeof document === 'undefined' ? [] : readRootTokens(document)), []);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return [] as TokenDef[];
    return tokens.filter((token) => token.name.includes(needle) || token.group.toLowerCase().includes(needle)).slice(0, 60);
  }, [tokens, filter]);

  const devices = DEVICES.filter((device) => deviceIds.includes(device.id));
  const report = useCallback((id: string) => (next: FitReport) => setFit((all) => (sameFit(all[id], next) ? all : { ...all, [id]: next })), []);

  const chooseProduct = (next: string): void => {
    const id = next as ProductId;
    setProduct(id);
    setScreenId(SCREENS.find((item) => item.product === id)?.id ?? '');
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
        In print, every screen is shown at the laptop and phone sizes with the fit measured inside each frame. The interactive version — every size, the product switch and the
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
          {DEVICES.map((device) => (
            <Checkbox
              key={device.id}
              checked={deviceIds.includes(device.id)}
              onChange={(event) => setDeviceIds((all) => (event.currentTarget.checked ? [...all, device.id] : all.filter((id) => id !== device.id)))}
            >
              {`${device.label} · ${device.width}`}
            </Checkbox>
          ))}
        </fieldset>
      </div>

      {screen ? <p className="sg-note sg-mockups__note">{screen.note}</p> : null}

      <div className="sg-mockups__frames">
        {devices.map((device) => (
          <figure key={`${device.id}-${screen?.id ?? ''}`} className="sg-mockups__frame">
            <figcaption>
              <strong>{device.label}</strong> <span className="sg-dim">{device.width} × {device.height}</span>
              {device.touch ? <span className="sg-tag">touch layer emulated</span> : null}
            </figcaption>
            <DeviceFrame device={device} scale={scaleFor(device.width)} tokens={edits} css={PRODUCT_CSS[product]} revision={revision} onFit={report(`${device.id}-${screen?.id ?? ''}`)}>
              {screen?.render()}
            </DeviceFrame>
            <FitLine report={fit[`${device.id}-${screen?.id ?? ''}`] ?? EMPTY_FIT} touch={device.touch} />
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
          <Button variant="default" disabled={!Object.keys(edits).length} onClick={() => void copy(overridesCss(edits))}>
            Copy the CSS
          </Button>
        </div>

        {Object.keys(edits).length ? (
          <>
            <p className="sg-note">
              Save this over <code>packages/aqua-ui/src/styles/overrides.css</code> and run <code>pnpm build</code>. Every product reads it, because every product imports the component library.
            </p>
            <pre className="sg-editor__out">{overridesCss(edits)}</pre>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Every screen, for the PDF.
 *
 * Paper cannot hold a picker, so print gets the whole matrix instead: each screen on its own page,
 * the laptop frame across the top and the phone frame under it, both measured the same way as on
 * screen. The page is marked ready only when every frame has reported, so the export never prints
 * a frame that has not laid out yet.
 */
const PRINT_SIZES = [
  { deviceId: 'laptop', scale: 0.53 },
  { deviceId: 'phone', scale: 0.56 },
] as const;

function PrintMatrix() {
  const [reports, setReports] = useState<Record<string, FitReport>>({});
  const expected = SCREENS.length * PRINT_SIZES.length;
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
              {PRINT_SIZES.map(({ deviceId, scale }) => {
                const device = DEVICES.find((item) => item.id === deviceId)!;
                const key = `${screen.id}-${device.id}`;
                return (
                  <div key={key} className={`sg-print-screen__frame sg-print-screen__frame--${device.id}`}>
                    <DeviceFrame device={device} scale={scale} tokens={{}} css={PRODUCT_CSS[screen.product]} onFit={report(key)}>
                      {screen.render()}
                    </DeviceFrame>
                    <div className="sg-print-screen__meta">
                      <b>{device.label}</b>{' '}
                      <span className="sg-dim">
                        {device.width} × {device.height}, shown at {Math.round(scale * 100)}%
                      </span>
                      {device.touch ? <span className="sg-tag">touch layer emulated</span> : null}
                      <FitLine report={reports[key] ?? EMPTY_FIT} touch={device.touch} />
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
