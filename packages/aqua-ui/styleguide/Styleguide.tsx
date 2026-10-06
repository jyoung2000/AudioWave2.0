/**
 * The Airwave Style Guide: one guide for the player, the hub and the companion.
 *
 * It explains the system in prose and shows it with the system's own parts, so the two cannot drift
 * apart: every swatch is read from tokens.json at build time; the Airwave windows are drawn with the
 * generated stylesheets, AquaArt and the products' own kits; the component library's controls are
 * the real ones wearing the real stylesheet; and which product uses what is read from the products'
 * imports when the page is built.
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { BRANDING } from '@now-playing/contracts';
import tokens from '../src/styles/tokens.json';
import { ToastProvider, Button, Checkbox, PopUpMenu, ProgressBar, SegmentedControl, Glyph, TrackScrubber, BarSearch, Slider, StatusDot, MusicList } from '../src/index.js';
import { Card, ControlsDemo, IconsDemo, OverlaysDemo, PageDemo, StatesDemo, makeTracks } from '../gallery/specimens.js';
import { ContextMenuSpecimen, EqualizerSpecimen, PageFurnitureSpecimen, SearchPopoverSpecimen, ShareStripSpecimen, SheetSpecimen, ToastSpecimen } from './page-specimens.js';
import { ConstellationField, SpectrumSpecimen } from './visualisers.js';
import { Mockups } from './Mockups.js';
import { DeviceFrame, type DeviceSpec } from './DeviceFrame.js';
import { AirwaveKitSpecimen, HUB_CSS, prepareAirwaveDocument } from './airwave-screens.js';
import { ShellShots } from './shell-shots.js';
import { Brand, Coverage, DarkScheme, Discord, Governance, Interaction, Journeys, Platforms, Principles, PrintContents, PrintCover, Screens, type NavGroup } from './Governance.js';

/* ------------------------------------------------------------------ data */

type Palette = Record<string, string>;
const colour = tokens.color as Palette;
const page = tokens.page as Palette;
const airwave = tokens.airwave as Palette;

const AIRWAVE_GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: 'Window and content', keys: ['desktop', 'winOutline', 'winBody', 'content', 'contentMuted', 'rowStripe', 'rowDivider', 'wellEdge'] },
  { title: 'Chrome and headers', keys: ['chromeTop', 'chromeUpper', 'chromeLower', 'chromeBottom', 'chromeSep', 'chromeHi', 'headTop', 'headBot', 'headRule', 'headInk'] },
  { title: 'Selection and focus', keys: ['selTop', 'selMid', 'selBot', 'selBorder', 'selInk', 'focus', 'aqRing'] },
  { title: 'Aqua gel', keys: ['aquaSpec', 'aquaTop', 'aquaMid', 'aquaLower', 'aquaBot', 'aquaRim'] },
  { title: 'Ink', keys: ['ink', 'ink2', 'ink3', 'aqInk', 'aqInkOff'] },
  { title: 'Status and the first-run gate', keys: ['success', 'warning', 'danger', 'warnBg', 'warnEdge'] },
  { title: 'LCD plate', keys: ['lcdTop', 'lcdBot', 'lcdInk'] },
  { title: 'Faces and tracks', keys: ['btnTop', 'btnMid', 'btnBot', 'btnEdge', 'trackEdge', 'trackLo', 'trackHi'] },
  { title: 'Contrast inks (hub web, DEC-022)', keys: ['inkQuiet', 'successInk', 'dangerInk', 'link', 'capOffInk'] },
];

/** The frame the Airwave window kit is shown in: a browser tab's worth of the hub's own page. */
const KIT_FRAME: DeviceSpec = { id: 'airwave-kit', label: 'The Airwave window kit', width: 820, height: 820, touch: false };

const WINDOW_GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: 'Window and content', keys: ['desktop', 'windowOutline', 'windowBody', 'content', 'contentMuted', 'rowStripe', 'rowDivider'] },
  { title: 'Chrome', keys: ['chromeTop', 'chromeUpper', 'chromeLower', 'chromeBottom', 'chromeSeparator', 'chromeHighlight'] },
  { title: 'Source list', keys: ['sidebarTop', 'sidebarBottom', 'sidebarDivider', 'sidebarGroupText'] },
  { title: 'Selection and focus', keys: ['selectionTop', 'selectionMid', 'selectionBottom', 'selectionBorder', 'selectionText', 'focus'] },
  { title: 'Aqua gel', keys: ['aquaSpecular', 'aquaTop', 'aquaMid', 'aquaLower', 'aquaBottom', 'aquaRim'] },
  { title: 'Graphite', keys: ['graphiteTop', 'graphiteMid', 'graphiteBottom'] },
  { title: 'Text', keys: ['text', 'textSecondary', 'textDisabled'] },
  { title: 'LCD', keys: ['lcdTop', 'lcdBottom', 'lcdText'] },
  { title: 'Status', keys: ['danger', 'warning', 'success'] },
  { title: 'Traffic lights', keys: ['trafficClose', 'trafficMinimize', 'trafficZoom'] },
];

const PAGE_GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: 'Status bar', keys: ['barTop', 'barUpper', 'barLower', 'barBottom', 'barEdge'] },
  { title: 'Field', keys: ['fieldTop', 'fieldBottom'] },
  { title: 'Mode switch', keys: ['modeFaceTop', 'modeFaceBottom', 'modeOnTop', 'modeOnBottom'] },
  { title: 'Scrubber', keys: ['railTop', 'railBottom', 'railFillTop', 'railFillMid', 'railFillBottom'] },
  { title: 'List', keys: ['listHeaderTop', 'listHeaderBottom', 'listSortTop', 'listSortBottom', 'listStripe', 'listPlaying', 'listSelectTop', 'listSelectBottom'] },
  { title: 'Marks', keys: ['live', 'star'] },
];

/** Which product imports what, read from each product's source when the page is built (vite.config.ts). */
const USAGE = __STYLEGUIDE_BUILD__.usage;
const LIBRARY_IN_PLAYER = USAGE.library.filter((item) => item.player);
const LIBRARY_UNUSED = USAGE.library.filter((item) => !item.player && !item.hub && !item.companion);
const LIBRARY_IN_WINDOWS = USAGE.library.filter((item) => item.hub || item.companion);
const KIT_NAMES = [...new Set([...USAGE.kits.hub, ...USAGE.kits.companion])].sort();

/* ------------------------------------------------------------- pieces */

function Swatches({ palette, groups }: { palette: Palette; groups: Array<{ title: string; keys: string[] }> }) {
  const covered = new Set(groups.flatMap((g) => g.keys));
  const rest = Object.keys(palette).filter((k) => !covered.has(k) && palette[k]!.startsWith('#'));
  const all = rest.length ? [...groups, { title: 'Other', keys: rest }] : groups;
  return (
    <>
      {all.map((group) => (
        <div key={group.title}>
          <h3 className="sg__h3">{group.title}</h3>
          <div className="sg__swatches">
            {group.keys
              .filter((key) => palette[key])
              .map((key) => (
                <div key={key} className="sg__swatch">
                  <div className="sg__chip" style={{ background: palette[key] }} />
                  <div className="sg__swatch-meta">
                    {key}
                    <small>{palette[key]}</small>
                  </div>
                </div>
              ))}
          </div>
        </div>
      ))}
    </>
  );
}

function Bed({ children, caption, wide = false }: { children: ReactNode; caption?: ReactNode; wide?: boolean }) {
  return (
    <div className={['sg__bed', wide && 'sg__bed--wide'].filter(Boolean).join(' ')}>
      {children}
      {caption ? <p className="sg__caption">{caption}</p> : null}
    </div>
  );
}

/** `chapter` starts a new page in print; everything else flows. */
function Section({ id, title, chapter = false, children }: { id: string; title: string; chapter?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={chapter ? 'sg-chapter' : undefined}>
      <h2 className="sg__h2">{title}</h2>
      {children}
    </section>
  );
}

/** One list for the rail on screen and the contents page in print. */
const NAV: NavGroup[] = [
  { group: 'Principles', items: [{ href: '#rules', label: 'The four rules' }, { href: '#brand', label: 'Brand and voice' }, { href: '#skins', label: 'Three apps, one system' }] },
  {
    group: 'Foundations',
    items: [
      { href: '#colour', label: 'Colour' },
      { href: '#highlights', label: 'Aqua highlights' },
      { href: '#type', label: 'Type' },
      { href: '#space', label: 'Space' },
      { href: '#material', label: 'Shape and material' },
      { href: '#motion', label: 'Motion' },
    ],
  },
  {
    group: 'Elements',
    items: [
      { href: '#shell', label: 'The served shell (player)' },
      { href: '#page', label: 'The page skin (library)' },
      { href: '#window', label: 'The Airwave window (hub, companion)' },
      { href: '#controls', label: 'Library controls' },
      { href: '#overlays', label: 'Overlays' },
      { href: '#states', label: 'States' },
      { href: '#icons', label: 'Icons' },
      { href: '#products', label: 'By product' },
    ],
  },
  {
    group: 'Behaviour',
    items: [
      { href: '#interaction', label: 'Interaction rules' },
      { href: '#access', label: 'Accessibility' },
      { href: '#screens', label: 'Every screen' },
      { href: '#journeys', label: 'Journeys' },
      { href: '#discord', label: 'The Discord bot' },
      { href: '#platforms', label: 'Platforms' },
    ],
  },
  { group: 'Mockups', items: [{ href: '#mockups', label: 'Every product, every size' }] },
  {
    group: 'Upkeep',
    items: [
      { href: '#governance', label: 'Sources and commands' },
      { href: '#extend', label: 'Changing it' },
      { href: '#coverage', label: 'Coverage and decisions' },
    ],
  },
];

/* ------------------------------------------------------------ the page */

export function Styleguide() {
  const spaces = useMemo(() => Object.entries(tokens.space as Record<string, string>), []);
  const motion = useMemo(() => Object.entries(tokens.motion as Record<string, string>).filter(([, v]) => v.endsWith('ms')), []);
  const fontSteps = useMemo(() => (['system', 'view', 'small', 'label', 'mini'] as const).map((k) => ({ key: k, px: tokens.font[k] })), []);
  const pulseMs = Number.parseInt((tokens.motion as Record<string, string>).defaultPulse ?? '1650', 10);

  // Tells automation (the PDF export, the e2e suite) that the page has rendered.
  useEffect(() => {
    document.documentElement.dataset['styleguideReady'] = 'true';
  }, []);

  return (
    <>
      <ToastProvider>
        <div className="sg">
          <nav className="sg__rail" aria-label="Sections">
            <div className="sg__brand">
              {BRANDING.suiteName} Style Guide
              <small>AQUA_PROFILE={tokens.profile}</small>
            </div>
            {NAV.map((group) => (
              <div key={group.group} className="sg__navgroup">
                <div className="sg__group">{group.group}</div>
                {group.items.map((item) => (
                  <a key={item.href} href={item.href}>
                    {item.label}
                  </a>
                ))}
              </div>
            ))}
          </nav>

          <main className="sg__work">
            <PrintCover />
            <PrintContents nav={NAV} />
            <header className="sg__opening">
              <h1 className="sg__h1">{BRANDING.suiteName} Style Guide</h1>
              <div className="sg__stamp">
                {tokens.profile} · three apps · {__STYLEGUIDE_BUILD__.summary.tokensChecked} tokens checked · {__STYLEGUIDE_BUILD__.summary.surfaces} surfaces · source{' '}
                {__STYLEGUIDE_BUILD__.fingerprint}
              </div>
              <p className="sg__lede">
                One guide for the three apps of {BRANDING.suiteName} — {BRANDING.products.player}, the player (a page, also inside the Android app); {BRANDING.products.hub}, the
                admin window the container serves; and {BRANDING.products.companion}, the Windows app — and for the words the Discord bot uses. All three are a reconstruction of
                Apple's 2009–2010 interface, and each is built from a design file in <code>design/frontends/origin/</code>. Every value here is read from <code>tokens.json</code> as this
                page is built, the windows are drawn with the stylesheets and kits the products ship, and every rule, screen and journey is read from <code>design/</code> — so the
                page cannot describe one thing and show another.
              </p>
            </header>

            <Section id="rules" title="The rules that outrank the visuals">
              <p className="sg__note">A styleguide that opens with colour teaches the wrong lesson. These four decide whether a control is drawn at all, and each has overruled the aesthetics here at least once.</p>
              <Principles />
            </Section>

            <Section id="brand" title="Brand and voice">
              <Brand />
            </Section>

            <Section id="skins" title="Three apps, one system">
              <p>
                One period, one set of rules, three apps — and each app's interface comes from its own design file in <code>design/frontends/origin/</code>. The design file is the
                authority for how its app looks; this guide is the authority for what the three share: the rules, the words, the ledger of screens, and the checks that keep them
                in step.
              </p>
              <table className="sg-table">
                <thead>
                  <tr>
                    <th scope="col">App</th>
                    <th scope="col">Design</th>
                    <th scope="col">What it wears</th>
                    <th scope="col">Where to look here</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <b>{BRANDING.products.player}</b>
                      <span className="sg-dim sg-block">music-player · android · local-helper</span>
                    </td>
                    <td>
                      <code>airwave-now-playing.html</code>
                    </td>
                    <td>
                      The design file itself, served as the shell: <code>music-player/index.html</code> is generated from it by <code>make-shell.py</code>, with its own custom
                      properties, its own script for the drawn controls, and <code>src/shell/bridge.ts</code> behind its seams (DEC-019). It imports nothing from the component
                      library.
                    </td>
                    <td>
                      The served shell in Elements (screenshots of the production build), the <code>player-shell-*</code> rows in Every screen and the <code>NP-*</code> rules.
                      The page skin is the component library's version of the same look, kept in <code>music-player/src</code> but not served.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <b>{BRANDING.products.hub}</b>
                      <span className="sg-dim sg-block">docker-container/src/web</span>
                    </td>
                    <td>
                      <code>airwave-hub.html</code>
                    </td>
                    <td>
                      <code>airwave-window.css</code> and <code>airwave-hub.css</code> (generated from the designs by <code>pnpm build:window-css</code>), AquaArt's drawings, its own
                      kit <code>ui.tsx</code>, and <code>styles.css</code> for what the design left to its script.
                    </td>
                    <td>The Airwave window in Elements, and its screens in the mockups.</td>
                  </tr>
                  <tr>
                    <td>
                      <b>{BRANDING.products.companion}</b>
                      <span className="sg-dim sg-block">windows-companion/src/renderer</span>
                    </td>
                    <td>
                      <code>airwave-companion.html</code>
                    </td>
                    <td>
                      <code>airwave-window.css</code>, the same AquaArt, its own kit <code>ui.tsx</code>, and <code>styles.css</code> for what a real window needs (it fills its
                      frame; its chrome is the title bar).
                    </td>
                    <td>The Airwave window in Elements, and its screens in the mockups.</td>
                  </tr>
                </tbody>
              </table>
              <div className="sg__groups">
                <div className="sg__grp">
                  <b>The Airwave window</b>
                  <p>--win-*, --chrome-*, --ink*, --aq-* · airwave-window.css, airwave-hub.css · Lucida Grande · light only (DEC-003) · {BRANDING.products.hub}, {BRANDING.products.companion}</p>
                </div>
                <div className="sg__grp">
                  <b>The component library</b>
                  <p>
                    --aqua-*, --np-*, --lib-* · aqua.css, now-playing.css · <code>packages/aqua-ui</code> React components · imported by the player's
                    React source, the gallery and this guide; no served product (DEC-026)
                  </p>
                </div>
              </div>
            </Section>

            <Section id="colour" title="Colour" chapter>
              <p>
                Chosen by role, never by picking a hex. Blue means <em>selected</em>, <em>active</em>, or <em>the default action</em> — it is not a brand colour and it is never
                decoration. Three palettes follow, straight from the token file: the Airwave window's (what the hub and the companion wear), then the component library's two.
              </p>
              <h3 className="sg__h3" style={{ marginTop: 30 }}>The Airwave window — {Object.values(airwave).filter((v) => v.startsWith('#')).length} colours</h3>
              <p className="sg__note">
                Owned by the design files: <code>airwave-window.css</code> and <code>airwave-hub.css</code> are generated from them, and <code>tokens.json</code> records the values
                so <code>pnpm styleguide:check</code> notices when a design changes one. The last group is the hub's own: the design's <code>--ink-3</code>, <code>--success</code>{' '}
                and <code>--danger</code> fail 4.5:1 as text on white, so the hub reads sentences in darker inks of the same hues (DEC-022).
              </p>
              <Swatches palette={airwave} groups={AIRWAVE_GROUPS} />
              <h3 className="sg__h3" style={{ marginTop: 30 }}>Component library, window skin — {Object.keys(colour).length} tokens</h3>
              <Swatches palette={colour} groups={WINDOW_GROUPS} />
              <h3 className="sg__h3" style={{ marginTop: 30 }}>Component library, page skin — {Object.values(page).filter((v) => v.startsWith('#')).length} tokens</h3>
              <Swatches palette={page} groups={PAGE_GROUPS} />
              <h3 className="sg__h3">Dark</h3>
              <p className="sg__note">
                The page skin has a full dark palette and it is opt-out: every dark rule is guarded <code>@media (prefers-color-scheme: dark) {'{'} :root:not([data-np-theme='light']) {'{'} … {'}'} {'}'}</code>, so the system preference wins unless a page pins itself light. Redefine <em>only</em> tokens inside that block. Neither the Airwave window nor the library's window skin has a dark palette, because Snow Leopard had none (DEC-003); the player's shell carries its own dark values (NPD-002).
              </p>
              <DarkScheme />
            </Section>

            <Section id="highlights" title="Aqua highlights — where the blue is allowed to shine">
              <p className="sg__note">
                The specimens from here to Motion are the component library's controls. The principles are the Airwave window's too — the same light source, the same restraint
                about blue — but its controls are AquaArt's drawings, shown under The Airwave window.
              </p>
              <p>
                Snow Leopard had flattened most of Aqua's gel by 2009, but not all of it: selection, the default action, the scroller and a few controls kept the glass. Those are
                exactly the places this system keeps it, and this is each one, live.
              </p>
              <h3 className="sg__h3">The default action</h3>
              <Bed caption="The one button on a form that carries the Aqua blue: a pale cyan cap over a saturated body, a specular hairline at the top, a dark rim, and a slow pulse. The shape stays the Snow Leopard rounded rect — no pill, no glass lozenge, no gloss step across the middle.">
                <div className="sg__row aqua-root">
                  <Button>Cancel</Button>
                  <Button variant="default">Save</Button>
                  <Button variant="graphite">Graphite</Button>
                  <span className="sg__verdict sg__verdict--yes">Snow Leopard · correct</span>
                </div>
                <div className="sg__row aqua-root">
                  <span className="sg__wrong-button">Save</span>
                  <span className="sg__verdict sg__verdict--no">Aqua 10.2 · a decade early — drawn once here, as the thing not to do</span>
                </div>
              </Bed>
              <h3 className="sg__h3">Controls that keep the gel</h3>
              <Bed caption="The checked box, the pop-up's end cap, the aqua-tinted segmented control and the indeterminate progress bar's barber pole are the last four places a form is blue.">
                <div className="sg__row aqua-root">
                  <Checkbox checked readOnly>Checked</Checkbox>
                  <PopUpMenu label="Week" hideLabel options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} value="week" onChange={() => undefined} />
                  <SegmentedControl label="View" value="week" onChange={() => undefined} tint="aqua" segments={[{ value: 'day', label: 'Day', showLabel: true }, { value: 'week', label: 'Week', showLabel: true }, { value: 'month', label: 'Month', showLabel: true }]} />
                  <div style={{ width: 220 }}>
                    <ProgressBar label="Syncing artwork…" />
                  </div>
                </div>
              </Bed>
              <h3 className="sg__h3">The overlay scroller</h3>
              <Bed caption="The full five-stop Aqua gel survives at strength in exactly one place: the list's overlay scroller, which fades in while you scroll and out 900 ms after you stop.">
                <div className="np-app sg-static">
                  <div className="library is-scrolling" style={{ position: 'relative', width: 40, height: 150 }}>
                    <div className="library__bar" aria-hidden="true" style={{ top: 6 }}>
                      <div className="library__thumb" style={{ top: 10, height: 54 }} />
                    </div>
                  </div>
                </div>
              </Bed>
              <h3 className="sg__h3">The iPod rail</h3>
              <Bed caption="Not gel, but the other blue on the page: the iPod Classic's progress bar, 12 px, near-square ends, and a fill that brightens downward — sky at the top through a saturated dip at 62% to a cyan glow along the lower lip. No knob: the device had none.">
                <div className="np-app" style={{ width: 420 }}>
                  <TrackScrubber positionMs={21_000} durationMs={157_000} onSeek={() => undefined} />
                </div>
              </Bed>
              <p className="sg__note">
                And the focus ring — <code>--aqua-focus</code> {colour.focus} with a soft outer glow — is blue everywhere, because the thing that has the keyboard is the one thing on
                screen that must never be ambiguous.
              </p>
            </Section>

            <Section id="type" title="Type">
              <p>
                Two families, one scale. The window skin — the Airwave window and the library's alike — sets Lucida Grande, as OS X did; the Airwave window runs 12px body text
                with 11px secondary lines and 10px chips. The page skin sets <strong>Helvetica</strong> — the face the iPod classic drew its Now
                Playing screen in, which is what the hero is modelled on — with Arial as its metric-compatible stand-in where Helvetica is absent. Each specimen is at its true size.
              </p>
              <h3 className="sg__h3">Page skin · Helvetica</h3>
              <div className="sg__scale">
                {fontSteps.map((step) => (
                  <div key={step.key} className="sg__scale-row">
                    <span className="sg__px">{step.px}</span>
                    <span style={{ fontFamily: 'var(--np-ui-font)', fontSize: step.px, fontWeight: step.key === 'system' ? 700 : 400 }}>
                      {step.key === 'system' ? 'Sundress — A$AP Rocky' : step.key === 'view' ? 'Marlow & the Tidewater — Quiet Arithmetic' : step.key === 'small' ? 'Searches this device only until a hub is paired' : step.key === 'label' ? 'PREAMP · 32 · 64 · 125 · 250 · 500 · 1K · 2K' : 'Mini controls only'}
                    </span>
                    <span className="sg__use">--aqua-font-{step.key}</span>
                  </div>
                ))}
              </div>
              <h3 className="sg__h3">Window skin · Lucida Grande</h3>
              <div className="sg__scale">
                {fontSteps.map((step) => (
                  <div key={step.key} className="sg__scale-row">
                    <span className="sg__px">{step.px}</span>
                    <span style={{ fontFamily: 'var(--aqua-font)', fontSize: step.px, fontWeight: step.key === 'system' ? 700 : 400 }}>
                      {step.key === 'system' ? BRANDING.products.hub : step.key === 'view' ? 'Copper Meridian — Orbital Cartographers' : step.key === 'small' ? '1,240 songs, 2.6 hours, 245 MB' : step.key === 'label' ? 'LIBRARY · PLAYLISTS · CONNECTED' : 'Mini controls only'}
                    </span>
                    <span className="sg__use">--aqua-font-{step.key}</span>
                  </div>
                ))}
              </div>
              <p className="sg__note">
                Weights are <strong>{tokens.font.weightRegular}</strong> and <strong>{tokens.font.weightEmphasized}</strong>. There is no 500 and no 600: the profile predates variable UI fonts,
                and a half-weight reads as a rendering fault beside a true bold. Numbers that change in place — timers, dB values, tempo, track times — take{' '}
                <code>font-variant-numeric: tabular-nums</code>, so a changing digit does not shift the ones beside it.
              </p>
            </Section>

            <Section id="space" title="Space">
              <p>One scale, no arbitrary values. Each bar is drawn at its true width.</p>
              <div className="sg__ruler">
                {spaces.map(([key, value]) => (
                  <div key={key} className="sg__ruler-row">
                    <span className="sg__px">--aqua-space-{key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}</span>
                    <span className="sg__px">{value}</span>
                    <span className="sg__bar" style={{ width: value }} />
                  </div>
                ))}
              </div>
              <h3 className="sg__h3">Sizes</h3>
              <div className="sg__swatches">
                {(['visualControlRegular', 'visualControlSmall', 'searchRegular', 'tableRow', 'listRow', 'railHeight', 'transportKey', 'playKey', 'barHeight', 'sidebarDefault'] as const).map((key) => (
                  <div key={key} className="sg__swatch">
                    <div className="sg__swatch-meta">
                      {key}
                      <small>{(tokens.size as Record<string, string>)[key]}</small>
                    </div>
                  </div>
                ))}
              </div>
              <p className="sg__note">
                <strong>32 px</strong> (<code>--aqua-hit</code>) is the floor for a pointer target, and <strong>44 px</strong> on a coarse pointer, which is what both platform guidelines ask for. A 12 px
                rail and an 18 px row are period-correct and stay that size — they get their hit area from an invisible <code>::after</code> that expands past the visual. Never shrink a hit target to
                match a visual.
              </p>
            </Section>

            <Section id="material" title="Shape and material">
              <p>
                One light source, above and slightly forward. Raised things are light at the top and dark at the bottom; recessed things are the reverse. Every shadow follows from
                that, and a rule that contradicts it looks broken even when the colours are right.
              </p>
              <h3 className="sg__h3">Radii</h3>
              <Bed>
                <div className="sg__row">
                  {[
                    ['window', tokens.size.windowRadius],
                    ['panel', tokens.size.panelRadius],
                    ['control', tokens.size.controlRadius],
                    ['button', '4px'],
                    ['pill', tokens.size.pillRadius],
                  ].map(([name, radius]) => (
                    <div key={name} style={{ display: 'grid', gap: 6, justifyItems: 'center' }}>
                      <div style={{ width: 58, height: 42, border: '1px solid #747474', borderRadius: radius, background: 'linear-gradient(to bottom, #f6f6f6, #cfcfd1)' }} />
                      <span className="sg__px">
                        {name} · {radius}
                      </span>
                    </div>
                  ))}
                </div>
              </Bed>
              <h3 className="sg__h3">The push button</h3>
              <Bed caption="A rounded rect, one quiet vertical gradient, a hairline rim that darkens along the bottom, one pixel of white on top. The default action is the same shape with the Aqua blue on it — see the highlights above.">
                <div className="sg__row aqua-root">
                  <Button>Add a folder…</Button>
                  <Button variant="default">Create group</Button>
                  <Button variant="destructive">Remove</Button>
                  <Button disabled>Disabled</Button>
                  <Button size="small">Small</Button>
                  <Button size="mini">Mini</Button>
                </div>
              </Bed>
              <div className="sg__code">{`background: linear-gradient(to bottom, #fdfdfd 0%, #f4f4f4 47%, #e6e6e6 53%, #dcdcdc 100%);
border: 1px solid #a3a3a3;
border-bottom-color: #8d8d8d;
border-radius: 4px;
box-shadow:
  inset 0 1px 0 rgb(255 255 255 / 90%),   /* the pixel of light on the top edge */
  0 1px 0 rgb(255 255 255 / 55%);         /* the surface beneath catching it */`}</div>
              <h3 className="sg__h3">Recessed fields</h3>
              <Bed caption="Wells run the other way: shadowed at the top inside, with the lower lip catching light. Same source, opposite surface. The page skin's search pill is one, 26 px high.">
                <div className="np-app" style={{ width: 380 }}>
                  <BarSearch label="Search your music" value="" onChange={() => undefined} placeholder="Search your music" />
                </div>
              </Bed>
              <h3 className="sg__h3">Faders</h3>
              <Bed caption="The slider's knob is a small lozenge with a pointed edge, the equalizer's fader is the same control rotated; both ride a recessed groove.">
                <div className="sg__row aqua-root">
                  <Slider label="Volume" value={72} min={0} max={100} onChange={() => undefined} />
                  <Slider label="1 kHz" value={4} min={-12} max={12} step={0.5} onChange={() => undefined} editable unit=" dB" />
                </div>
              </Bed>
            </Section>

            <Section id="motion" title="Motion">
              <p>
                Confirmation, never decoration: nothing animates that a person did not just cause. Everything eases on <code>{tokens.motion.easeStandard}</code>. Bars are drawn in proportion.
              </p>
              <div className="sg__ruler">
                {motion.map(([key, value]) => (
                  <div key={key} className="sg__ruler-row">
                    <span className="sg__px">--aqua-motion-{key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}</span>
                    <span className="sg__px">{value}</span>
                    <span className="sg__bar" style={{ width: `${Math.max(1, (Number.parseInt(value, 10) / pulseMs) * 100)}%` }} />
                  </div>
                ))}
              </div>
              <p className="sg__note">
                <strong>Reduced motion is a contract, not a courtesy.</strong> Under <code>prefers-reduced-motion: reduce</code> the live dot stops pulsing, the marquee does not scroll (the cell keeps
                its ellipsis), the sheet's travel drops to zero and it fades only, the constellation opens as a table rather than an animated field, and the 3D stage stops its idle
                drift. Two variables carry most of it — <code>--aqua-anim-state: paused</code> and <code>--aqua-sheet-travel: 0</code> — so a new animation should read one of them rather
                than inventing a third.
              </p>
            </Section>

            <Section id="shell" title="The served shell — the player as it is served" chapter>
              <p>
                What a listener opens is <code>music-player/index.html</code>, the Airwave design served as the shell (DEC-019), and what Android and the local helper ship
                too. It is one document with its own stylesheet and scripts, so it cannot be put inside one of this guide's frames; it is shown here as it is, photographed
                from the production build. The page skin in the next chapter is the component library's version of the same look — the React interface kept in{' '}
                <code>music-player/src</code> — and is not what is served.
              </p>
              <ShellShots />
            </Section>

            <Section id="page" title="The page — what the player is made of" chapter>
              <p>
                The music player's skin: a sticky status bar, a section strip, the hero with the jewel case on its stage, the iPod rail and a transport of eleven keys, and the
                iTunes 10 list under it. Everything below is live — press play and the case opens; pick a row and the stage follows it.
              </p>
              <PageDemo />
              <p className="sg__note">
                <strong>The transport is centred on the rail.</strong> Play sits on the progress rail's centre line at every width, with previous and next either side of it on the
                same line, and the keys never run past the rail's ends. The volume line sits beside the keys only when it fits on both sides; otherwise it goes beneath, centred, as
                it does here. When the keys do not fit on one line, previous, play and next take the first line on their own and the other eight keys share the line below. The
                row measures itself to decide this, because the room it needs depends on how many keys a product carries (DEC-016).
              </p>
              <h3 className="sg__h3">The music list</h3>
              <Bed wide caption="The same component the player renders, with the reference's stylesheet block: nine columns, 18 px rows, the stripe, no rules, an embossed header with the sorted column tinted, monochrome source badges read from each track's locator, icon columns for offline and star, the playing row in bold with a speaker glyph and a marquee, a right-click menu, and the gel scroller that fades in while you scroll.">
                <div className="np-app" style={{ width: '100%' }}>
                  <MusicList label="Your music" tracks={makeTracks()} playingTrackId="0192a7c1-2b3d-7e4f-8a9b-000000000003" onPlay={() => undefined} onToggleStar={() => undefined} playlists={[]} playlistItems={[]} onTogglePlaylist={() => undefined} onNewPlaylist={() => undefined} onSay={() => undefined} ephemeralTrackIds={new Set(['0192a7c1-2b3d-7e4f-8a9b-000000000006'])} />
                </div>
              </Bed>
              <h3 className="sg__h3">The search popover</h3>
              <Bed caption="The iTunes 11 results popover: a gradient header with the count and Clear, 40 px rows whose artwork tile is a fifteen-second audition button with a countdown ring, a circled chevron on the hot row, and a pager. Arrow keys walk the rows and page off the end.">
                <div className="np-app sg-static" style={{ width: '100%', maxWidth: 460 }}>
                  <SearchPopoverSpecimen />
                </div>
              </Bed>
              <h3 className="sg__h3">Context menu, sheet and toast</h3>
              <Bed wide caption="The desktop context menu with its playlist submenu; the New Playlist sheet; and the toast that answers a change. All three are the reference's, classes and all.">
                <div className="np-app sg-static" style={{ display: 'grid', gap: 20, gridTemplateColumns: 'minmax(0, 240px) minmax(0, 1fr)', alignItems: 'start', width: '100%' }}>
                  <ContextMenuSpecimen />
                  <SheetSpecimen />
                </div>
                <div className="np-app sg-static">
                  <ToastSpecimen />
                </div>
              </Bed>
              <h3 className="sg__h3">The equalizer window</h3>
              <Bed caption="The iTunes equalizer: On beside the preset pop-up, then a preamp and the ten graphic centres on a ±12 dB scale with tick dashes flanking each rail. The window hugs its rails at 600 px (DEC-014) rather than stretching to the page. A one-band preset is chosen here so the greyed rail is visible — those faders name the preset that is not using them.">
                <div className="np-app" style={{ width: '100%', maxWidth: 600 }}>
                  <EqualizerSpecimen />
                </div>
              </Bed>
              <h3 className="sg__h3">Shared mode, and the page's furniture</h3>
              <Bed wide caption="The strip under the hero when you are in a group; a section's head and toolbar row; and the status line the bottom bar used to carry.">
                <div className="np-app" style={{ width: '100%' }}>
                  <ShareStripSpecimen />
                </div>
                <div className="np-app" style={{ width: '100%' }}>
                  <PageFurnitureSpecimen />
                </div>
              </Bed>
              <h3 className="sg__h3">A live broadcast</h3>
              <Bed caption="In shared mode the rail is not yours to drag: the duration stamp becomes the LIVE marker, the fill sits at the live edge, and the rail drops its slider role rather than announcing a control that refuses every change.">
                <div className="np-app" style={{ width: 420 }}>
                  <TrackScrubber positionMs={754_000} durationMs={null} onSeek={() => undefined} live disabledReason="A shared broadcast has one position." />
                </div>
              </Bed>
              <h3 className="sg__h3">The visualisers — spectrum, stage and constellation</h3>
              <p>
                The player draws three visualisers, and all three follow one rule: a visualiser must carry the data, not hide it. The two below are drawn here by the player's own
                code — <code>drawSpectrum</code> and <code>layoutStars</code> in <code>music-player/src/lib/</code>, the functions the views call — in the player's own
                <code> .player-spectrum</code> and <code>.player-constellation</code> styles. The third, the <strong>jewel case</strong>, is live on the hero at the top of this chapter.
              </p>
              <Bed caption="The spectrum, under “How this is being played” in the Now playing section. Each analyser frame is averaged into 64 bars; a bar's hue and lightness rise with its level, so a loud band reads brighter as well as taller. It draws only while a song plays — paused, the loop stops rather than repaint a still picture — and under reduced motion it redraws four times a second instead of every frame. There is no audio here, so the specimen is fed a generated frame; print shows one fixed frame.">
                <div className="np-app" style={{ width: '100%', maxWidth: 480, background: 'transparent' }}>
                  <SpectrumSpecimen />
                </div>
              </Bed>
              <Bed
                wide
                caption="The constellation: the library as a star field, one star per album. Albums by one artist share an angular sector, a star's size is the album's length, and its colour is the artist's hue, so the layout is information, never scatter. The app renders it with WebGL and a slow rotation; this is the same placement projected through the same camera (55°, z = 42), as SVG so it also prints. Hover a star for its album."
              >
                <div className="np-app" style={{ width: '100%' }}>
                  <ConstellationField />
                </div>
              </Bed>
              <p className="sg__note">
                The <strong>jewel case</strong> is <code>packages/aqua-ui/src/stage/jewel-case.ts</code>: the case and disc built from primitives, sleeve and tray-card textures generated
                from the track's real cover and running order, a drag with momentum, and a pose remembered per device. It stands in for Cover Flow (DEC-006). The stage and the
                constellation load Three.js lazily and share the chunk, so a listener who opens neither never downloads it. All three keep their meaning without motion: the spectrum
                slows to a level, the stage stops its idle drift and keeps the CSS cover, and the constellation opens as the same albums in a table, with identical selection and
                keyboard behaviour (<code>UX-MOTION-001</code>, <code>UX-STATE-001</code>). Both sections also appear whole in the mockups: <em>Now playing (audio chain)</em> and{' '}
                <em>Constellation</em>.
              </p>
            </Section>

            <Section id="window" title="The Airwave window — what the hub and the companion are made of" chapter>
              <p>
                A centred Snow Leopard window: one sheet of chrome carrying the title and a row of icon tools, a pane that scrolls beneath it, and a status strip at the foot. {BRANDING.products.hub}{' '}
                has six tools (Overview, Devices, Music, Groups, Sharing, System) and {BRANDING.products.companion} four (Library, Live TV, Remote, Settings). There is no source
                list, no traffic lights and no media toolbar: the tools are the navigation, a roving-tabindex tab strip (<code>UX-KEY-001</code>).
              </p>
              <p className="sg__note">
                The frame below is not a drawing of it. It holds exactly what the hub's page loads — <code>airwave-window.css</code>, <code>airwave-hub.css</code> and the hub's{' '}
                <code>styles.css</code>, with none of the component library's stylesheets — AquaArt is installed in it as the products' <code>main.tsx</code> installs it, and the
                controls are the hub's own kit.
              </p>
              <DeviceFrame device={KIT_FRAME} css={HUB_CSS} isolated prepare={prepareAirwaveDocument}>
                <AirwaveKitSpecimen />
              </DeviceFrame>
              <h3 className="sg__h3">Where each part comes from</h3>
              <ul className="sg__plain">
                <li>
                  <strong>The stylesheets are generated.</strong> <code>packages/aqua-ui/scripts/make-window-css.py</code> copies the <code>&lt;style&gt;</code> of{' '}
                  <code>airwave-companion.html</code> into <code>airwave-window.css</code> and every rule the hub design adds into <code>airwave-hub.css</code>. Change the design
                  file and run <code>pnpm build:window-css</code>; never edit the two by hand.
                </li>
                <li>
                  <strong>The controls are drawings.</strong> AquaArt (<code>packages/aqua-ui/src/airwave/aqua-art.ts</code>, imported as{' '}
                  <code>@now-playing/aqua-ui/airwave-art</code>) draws the Snow Leopard push button and the 10.4 pop-up and checkbox as SVG and publishes them as custom properties
                  (<code>--aq-btn-22</code>, <code>--aq-def-22</code>, <code>--aq-pop-22</code>, <code>--aq-cb-14</code> and their pressed, disabled and checked forms). One
                  implementation, shared by both products (NPD-021, DEC-026).
                </li>
                <li>
                  <strong>The kits are per product.</strong> <code>docker-container/src/web/ui.tsx</code> and <code>windows-companion/src/renderer/ui.tsx</code> write the same
                  classes — <code>.push</code>, <code>.field</code>, <code>.pop</code>, <code>.chk</code>, <code>.well</code>, <code>.rows</code>, <code>.sdot</code> — with different
                  props and, for the sheet, different markup, so they are not one component (DEC-026). By product, below, lists what each exports.
                </li>
                <li>
                  <strong>Each product's <code>styles.css</code> is the remainder.</strong> The hub's holds the layout the design wrote inline, the states it never drew (sign-in, the
                  sheet, loading and failed lists) and the contrast inks. The companion's makes the window fill its frame, makes the chrome the title bar and drag region (DEC-020),
                  and adds the song list and the sheet.
                </li>
              </ul>
              <h3 className="sg__h3">States every list and action owes</h3>
              <ul className="sg__plain">
                <li>
                  <strong>Loading, empty and failed are one quiet line inside the well</strong> — never an illustration, so nothing jumps when rows arrive (<code>UX-STATE-001</code>).
                  A failed list offers Try Again in the same row.
                </li>
                <li>
                  <strong>A failed action says what to do</strong> in a sentence under the control that failed (<code>.note--bad</code>), not in a toast.
                </li>
                <li>
                  <strong>A disabled button says why</strong> on hover and to assistive technology; a busy one keeps its width.
                </li>
                <li>
                  <strong>Anything that cannot be undone asks first, in a sheet</strong> that drops over the pane, with Cancel as the safe default (<code>UX-SAFE-001</code>, DEC-021).
                  Both sheets are in the mockups.
                </li>
                <li>
                  <strong>Colour never carries the meaning alone:</strong> every status lamp has its word beside it or in its accessible name.
                </li>
              </ul>
            </Section>

            <Section id="controls" title="Library controls">
              <p>
                The component library's controls, in both of its skins. The player's React source imports them; the hub and the companion do not — their controls are the Airwave
                window's, above.
              </p>
              <div style={{ display: 'grid', gap: 12 }}>
                <ControlsDemo />
              </div>
            </Section>

            <Section id="overlays" title="Overlays">
              <p>
                Sheets attach to their window; alerts stand alone; toasts confirm what just happened and get out of the way. Press the buttons. These are the component library's
                overlays; the Airwave windows' confirmation sheets are drawn in the mockups.
              </p>
              <OverlaysDemo />
            </Section>

            <Section id="states" title="States — the group people skip">
              <p>
                Every screen owes an answer for empty, loading, offline, partial, refused and out-of-date. The component library draws two of them as panels,{' '}
                <code>EmptyState</code> and <code>LoadingState</code>; the rest are said in the view's own words where the choice is made. In the Airwave windows the same answers
                are one quiet line inside the list's well (see The Airwave window).
              </p>
              <div style={{ display: 'grid', gap: 12 }}>
                <StatesDemo />
              </div>
              <Bed caption="Status dots carry their text; colour is never the only signal.">
                <div className="sg__row aqua-root">
                  <StatusDot kind="ok" label="Hub reachable" />
                  <StatusDot kind="warning" label="EQ unavailable" />
                  <StatusDot kind="error" label="Refused" />
                  <StatusDot kind="neutral" label="No" />
                </div>
              </Bed>
            </Section>

            <Section id="icons" title="Icons">
              <p>
                Two families in the component library: single-colour glyphs for every control, and the platform marks that say where a track comes from. The Airwave windows draw
                their own: six 26-pixel tools for the hub (<code>docker-container/src/web/icons.tsx</code>) and four tools and three row glyphs for the
                companion (<code>windows-companion/src/renderer/icons.tsx</code>), as their designs drew them; both sets are in the mockups.
              </p>
              <IconsDemo />
              <Card label="A page-skin glyph, at the transport's size">
                {/* .np-app is a flex column, so the row direction has to be said out loud here. */}
                <div className="np-app" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14, padding: '12px 14px', fontSize: 24, color: '#1b1c1f' }}>
                  <Glyph name="play" />
                  <Glyph name="pause" />
                  <Glyph name="star" />
                  <Glyph name="star-filled" />
                  <Glyph name="shuffle" />
                  <Glyph name="repeat" />
                  <Glyph name="share" />
                  <Glyph name="add" />
                  <Glyph name="download" />
                </div>
              </Card>
            </Section>

            <Section id="products" title="By product">
              <p>
                What each product is built from today, read from its source when this page was built — so a product that moves on cannot leave a tick behind.
              </p>
              <h3 className="sg__h3">The Airwave window kits</h3>
              <table className="sg__map">
                <thead>
                  <tr>
                    <th scope="col">Piece</th>
                    <th scope="col">{BRANDING.products.hub}</th>
                    <th scope="col">{BRANDING.products.companion}</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { name: 'airwave-window.css (generated)', hub: true, companion: true },
                    { name: 'airwave-hub.css (generated)', hub: true, companion: false },
                    { name: 'AquaArt — @now-playing/aqua-ui/airwave-art', hub: true, companion: true },
                    ...KIT_NAMES.map((name) => ({ name, hub: USAGE.kits.hub.includes(name), companion: USAGE.kits.companion.includes(name) })),
                  ].map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      {[row.hub, row.companion].map((used, i) => (
                        <td key={i}>{used ? <span className="sg__tick">●</span> : <span className="sg__dash">–</span>}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="sg__note">
                Rows after the first three are what each product's <code>ui.tsx</code> exports. A name in both columns is two components that write the same classes, not one
                shared component: <code>Push</code> takes <code>primary</code> in the hub and <code>isDefault</code> in the companion, <code>Check</code> reports a boolean in one
                and passes input props through in the other, and the confirmation sheet is a <code>role="alertdialog"</code> layer in the hub and a modal{' '}
                <code>&lt;dialog&gt;</code> in the companion (DEC-026).
              </p>
              <h3 className="sg__h3">The component library</h3>
              <p>
                <code>packages/aqua-ui</code> exports {USAGE.library.length} components.{' '}
                {LIBRARY_IN_WINDOWS.length ? <b>{LIBRARY_IN_WINDOWS.length} are imported by the hub or the companion. </b> : 'The hub and the companion import none of them. '}
                {LIBRARY_IN_PLAYER.length === USAGE.library.length ? `All ${USAGE.library.length}` : LIBRARY_IN_PLAYER.length} are imported by the player's React source in{' '}
                <code>music-player/src</code>, which is kept and tested but is not what the player serves (DEC-019). A component no product imports is removed from the library
                rather than kept as legacy.
              </p>
              <h4 className="sg__h4">Imported by the player's React source ({LIBRARY_IN_PLAYER.length})</h4>
              <p className="sg-paths">
                {LIBRARY_IN_PLAYER.map((item) => (
                  <code key={item.name}>{item.name}</code>
                ))}
              </p>
              {LIBRARY_UNUSED.length ? (
                <>
                  <h4 className="sg__h4">Imported by no product ({LIBRARY_UNUSED.length}) — remove these</h4>
                  <p className="sg-paths">
                    {LIBRARY_UNUSED.map((item) => (
                      <code key={item.name}>{item.name}</code>
                    ))}
                  </p>
                </>
              ) : null}
              <p className="sg__note">
                The player's shell also draws its search popover, sheets, toast and equalizer window from its own markup rather than through a component.
              </p>
            </Section>

            <Section id="interaction" title="Interaction and content rules" chapter>
              <Interaction />
            </Section>

            <Section id="access" title="Accessibility">
              <p>Not bolted on afterwards. These are parts of the design.</p>
              <ul className="sg__plain">
                <li>
                  <strong>One tab stop per group, arrows to move.</strong> The section strip, the mode switch, the music list, the context menu and the tools of an Airwave window all
                  use a roving <code>tabIndex</code>, and the focus ring travels with the selection.
                </li>
                <li>
                  <strong>Focus is always visible.</strong> An end-to-end test tabs the whole page and fails on any element that shows no indicator.
                </li>
                <li>
                  <strong>Roles must be true.</strong> A rail that cannot be dragged is <code>role="img"</code> with no value pair, not a slider that refuses every change. A button that opens a
                  section does not claim <code>aria-haspopup="menu"</code>.
                </li>
                <li>
                  <strong>Names say what will happen</strong>, including the refusal.
                </li>
                <li>
                  <strong>Colour is never the only signal.</strong> The playing row has a glyph as well as a tint; status dots carry text.
                </li>
                <li>
                  <strong>Text meets 4.5:1.</strong> Where the Airwave design's status colours fall short as text on white, the hub reads sentences in darker inks of the same hues
                  (DEC-022); an axe pass runs on every hub tab, the sign-in window and the confirmation sheet.
                </li>
              </ul>
            </Section>

            <Section id="screens" title="Every screen" chapter>
              <Screens />
            </Section>

            <Section id="journeys" title="Journeys">
              <Journeys />
            </Section>

            <Section id="discord" title="The Discord bot" chapter>
              <Discord />
            </Section>

            <Section id="platforms" title="Platforms" chapter>
              <Platforms />
            </Section>

            <Section id="mockups" title="Every product, every size — and editable" chapter>
              <p className="sg__note">
                Each frame below is an iframe with its own viewport, so a 320px column is a real 320px viewport and the media queries behave exactly as they do on a phone. The
                hub's and the companion's frames hold only what those products load — the generated Airwave stylesheets, their own <code>styles.css</code>, AquaArt and their own
                kits — and the player's hold the component library's page skin. Under each one is a measurement taken <em>inside</em> that frame: what runs off the side, the
                smallest text, the smallest thing you could tap.
              </p>
              <p className="sg__note">
                A frame marked <em>touch layer emulated</em> has its <code>(pointer: coarse)</code> rules re-applied inside it, read back out of the real stylesheets — an iframe
                inherits the desktop's pointer, so without that a phone frame would quietly show desktop sizes. The Airwave window has almost no touch layer (list rows and the
                round minus grow; buttons do not), so the hub's phone frames report their target sizes without being failed on them (DEC-027). At the bottom you can edit any
                custom property the stylesheets define and watch every frame repaint at once; what you copy out says which file each change belongs in.
              </p>
              <Mockups />
            </Section>

            <Section id="governance" title="Sources and commands" chapter>
              <Governance />
            </Section>

            <Section id="extend" title="Changing any of this">
              <ul className="sg__plain">
                <li>
                  <strong>Tokens first.</strong> In the component library a new colour or size goes in <code>tokens.json</code>, then into the stylesheet as a custom property. In the Airwave
                  window it goes in the design file's <code>:root</code>, then in the <code>airwave</code> group of <code>tokens.json</code>, which the check compares with the
                  generated stylesheet. A literal hex in a component is a bug.
                </li>
                <li>
                  <strong>Both schemes.</strong> Light on bare <code>:root</code>; redefine only what changes inside the dark guard.
                </li>
                <li>
                  <strong>The Airwave window changes in its design file.</strong> Edit <code>design/frontends/origin/airwave-companion.html</code> or <code>airwave-hub.html</code>, run{' '}
                  <code>pnpm build:window-css</code>, and carry any change to the design's <code>AquaArt</code> script into <code>src/airwave/aqua-art.ts</code>. The player's
                  shell changes in <code>airwave-now-playing.html</code> and is rebuilt by <code>make-shell.py</code>.
                </li>
                <li>
                  <strong>Both skins, if it is a library control.</strong> Button, Slider and friends are drawn in the window skin and the page skin.
                </li>
                <li>
                  <strong>Say why in the CSS.</strong> Every unobvious value carries a comment explaining what it reconstructs.
                </li>
                <li>
                  <strong>The gates.</strong> <code>AQUA_CONFORMANCE.md</code> maps every §17/§18 MUST to a test, a named reviewer check, or a recorded deviation, and <code>pnpm verify</code> runs the
                  lot. A deviation is legitimate; an undocumented one is not.
                </li>
                <li>
                  <strong>Rebuild this page.</strong> <code>pnpm styleguide:build</code> regenerates <code>docs/design/styleguide.html</code> from the same sources the products use,{' '}
                  <code>pnpm styleguide:check</code> fails if it no longer matches its sources, and <code>pnpm styleguide:pdf</code> prints it.
                </li>
              </ul>
              <p className="sg__foot">
                The correction log in <code>DEVIATIONS.md</code> is worth reading before a large change. It records the mistakes this system has already made — buttons a decade too glossy, a
                list redesigned instead of expanded, a picker that indexed music it could never play — and every one was found by building the thing and looking at it.
              </p>
            </Section>

            <Section id="coverage" title="Coverage and decisions" chapter>
              <Coverage />
            </Section>
          </main>
        </div>
      </ToastProvider>
    </>
  );
}
