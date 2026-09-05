/**
 * The styleguide.
 *
 * It explains the system in prose and shows it with the system's own components, so the two cannot
 * drift apart: every swatch is read from tokens.json at build time, every control on the page is the
 * real one wearing the real stylesheet, and the page's own chrome is a source list and a work area
 * because that is how this system navigates.
 */
import { useMemo, type ReactNode } from 'react';
import tokens from '../src/styles/tokens.json';
import { AquaProvider, ToastProvider, Button, Checkbox, PopUpMenu, ProgressBar, SearchField, SegmentedControl, SourceList, SourceIcon, Glyph, TrackScrubber, BarSearch, Slider, StatusDot, MusicList } from '../src/index.js';
import { Card, ControlsDemo, IconsDemo, OverlaysDemo, PageDemo, ResultsDemo, ShellDemo, StatesDemo, makeRows, makeTracks } from '../gallery/specimens.js';
import { ContextMenuSpecimen, EqualizerSpecimen, PageFurnitureSpecimen, SearchPopoverSpecimen, ShareStripSpecimen, SheetSpecimen, ToastSpecimen } from './page-specimens.js';

/* ------------------------------------------------------------------ data */

type Palette = Record<string, string>;
const colour = tokens.color as Palette;
const page = tokens.page as Palette;

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

/** Which product imports which element today, read from each product's imports. */
const PRODUCT_MAP: Array<{ name: string; player: boolean; hub: boolean; companion: boolean }> = [
  ...['PageBar', 'BarSearch', 'BarClock', 'ModeSwitch', 'ProfileButton', 'SectionStrip', 'Hero', 'HeroArt', 'JewelStage', 'TrackScrubber', 'KeyTransport', 'KeyButton', 'LevelSlider', 'MusicList', 'ButtonLink', 'IconButton', 'InlineValidation', 'SegmentedControl', 'Sheet', 'Slider'].map((name) => ({ name, player: true, hub: false, companion: false })),
  ...['AquaTable', 'Button', 'Checkbox', 'EmptyState', 'Glyph', 'KeyValueList', 'Panel', 'PanelSection', 'PopUpMenu', 'ProgressBar', 'SourceBadge', 'StatusDot', 'TextField', 'ToastProvider', 'useToast'].map((name) => ({ name, player: true, hub: true, companion: true })),
  ...['LoadingState'].map((name) => ({ name, player: true, hub: true, companion: false })),
  ...['AquaWindow', 'Toolbar', 'SourceList', 'WorkArea', 'Content', 'BottomBar', 'SearchField'].map((name) => ({ name, player: false, hub: true, companion: true })),
  ...['ErrorState'].map((name) => ({ name, player: false, hub: true, companion: false })),
];

const rows = makeRows(24);

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

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id}>
      <h2 className="sg__h2">{title}</h2>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------ the page */

export function Styleguide() {
  const spaces = useMemo(() => Object.entries(tokens.space as Record<string, string>), []);
  const motion = useMemo(() => Object.entries(tokens.motion as Record<string, string>).filter(([, v]) => v.endsWith('ms')), []);
  const fontSteps = useMemo(() => (['system', 'view', 'small', 'label', 'mini'] as const).map((k) => ({ key: k, px: tokens.font[k] })), []);
  const pulseMs = Number.parseInt((tokens.motion as Record<string, string>).defaultPulse ?? '1650', 10);

  return (
    <AquaProvider active reducedMotion={undefined}>
      <ToastProvider>
        <div className="sg">
          <nav className="sg__rail" aria-label="Sections">
            <div className="sg__brand">
              Now Playing
              <small>AQUA_PROFILE={tokens.profile}</small>
            </div>
            <div className="sg__group">Principles</div>
            <a href="#rules">The four rules</a>
            <a href="#skins">Two skins</a>
            <div className="sg__group">Foundations</div>
            <a href="#colour">Colour</a>
            <a href="#highlights">Aqua highlights</a>
            <a href="#type">Type</a>
            <a href="#space">Space</a>
            <a href="#material">Shape &amp; material</a>
            <a href="#motion">Motion</a>
            <div className="sg__group">Elements</div>
            <a href="#page">The page (player)</a>
            <a href="#window">The window (hub, companion)</a>
            <a href="#controls">Controls</a>
            <a href="#overlays">Overlays</a>
            <a href="#states">States</a>
            <a href="#results">Results &amp; grid</a>
            <a href="#icons">Icons</a>
            <a href="#products">By product</a>
            <div className="sg__group">Building</div>
            <a href="#access">Accessibility</a>
            <a href="#extend">Changing it</a>
          </nav>

          <main className="sg__work">
            <h1 className="sg__h1">Now Playing styleguide</h1>
            <div className="sg__stamp">
              {tokens.profile} · {Object.keys(colour).length + Object.keys(page).length} colours · two skins · three products
            </div>
            <p className="sg__lede">
              A reconstruction of Apple's 2009–2010 interface, built as one design system and shared by three products: the music player (a page), the hub's admin GUI and the
              Windows companion (both windows). Every value here is read from <code>tokens.json</code> as this page is built, and every control on it is the real component
              wearing the real stylesheet — so the page cannot describe one thing and show another.
            </p>

            <Section id="rules" title="The rules that outrank the visuals">
              <p className="sg__note">A styleguide that opens with colour teaches the wrong lesson. These four decide whether a control is drawn at all, and each has overruled the aesthetics here at least once.</p>
              <div className="sg__rules">
                <div className="sg__rule">
                  <b>A control that cannot act is not drawn.</b>
                  <span>No button that looks live and does nothing; no toggle whose state is decoration. The equalizer window ships without its traffic lights for exactly this reason — three circles that close nothing.</span>
                </div>
                <div className="sg__rule">
                  <b>An unavailable capability says so where the choice is made.</b>
                  <span>Not in a tooltip, not in a log, and not by disappearing. The Shared segment of the mode switch stays visible with no hub paired and reports the reason when pressed. A control that vanishes teaches nothing; one that explains itself does.</span>
                </div>
                <div className="sg__rule">
                  <b>Say what the code does, not what the feature is called.</b>
                  <span>The solfeggio presets are filters, and the panel says so and claims no physical effect. The retuning panel reports that the fallback changed the tempo rather than claiming “preserve tempo”. When a label and the DSP disagree, the label is what changes.</span>
                </div>
                <div className="sg__rule">
                  <b>A disabled control is still legible about why.</b>
                  <span>Greyed, not gone. The dimmed faders on the equalizer rail are what tell you where the current preset is silent, and each carries its reason in the accessible name — “500 Hz band, not used by 528 Hz (MI)” — not only in a tooltip.</span>
                </div>
              </div>
            </Section>

            <Section id="skins" title="Two skins, one system">
              <p>
                The same profile in two arrangements. A window frame drawn inside a browser viewport is a picture of a window rather than a window, and a 196 px source list is
                simply unavailable on a phone — so the player is a page while the desktop products stay windows. Controls are shared verbatim between them.
              </p>
              <div className="sg__groups">
                <div className="sg__grp">
                  <b>Window skin</b>
                  <p>--aqua-* · aqua.css, aqua-window.css, aqua-media.css · Lucida Grande · hub admin GUI, Windows companion</p>
                </div>
                <div className="sg__grp">
                  <b>Page skin</b>
                  <p>--np-*, --lib-* · now-playing.css · Helvetica, the iPod's face · music player PWA</p>
                </div>
              </div>
            </Section>

            <Section id="colour" title="Colour">
              <p>
                Chosen by role, never by picking a hex. Blue means <em>selected</em>, <em>active</em>, or <em>the default action</em> — it is not a brand colour and it is never
                decoration. Two palettes follow, straight from the token file: the window skin's, then the page skin's.
              </p>
              <h3 className="sg__h3" style={{ marginTop: 30 }}>Window skin — {Object.keys(colour).length} tokens</h3>
              <Swatches palette={colour} groups={WINDOW_GROUPS} />
              <h3 className="sg__h3" style={{ marginTop: 30 }}>Page skin — {Object.values(page).filter((v) => v.startsWith('#')).length} tokens</h3>
              <Swatches palette={page} groups={PAGE_GROUPS} />
              <h3 className="sg__h3">Dark</h3>
              <p className="sg__note">
                The page skin has a full dark palette and it is opt-out: every dark rule is guarded <code>@media (prefers-color-scheme: dark) {'{'} :root:not([data-np-theme='light']) {'{'} … {'}'} {'}'}</code>, so the system preference wins unless a page pins itself light. Redefine <em>only</em> tokens inside that block. The window skin has no dark palette, because Snow Leopard had none.
              </p>
            </Section>

            <Section id="highlights" title="Aqua highlights — where the blue is allowed to shine">
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
              <h3 className="sg__h3">Selection</h3>
              <Bed caption="The source list's selected row is the blue gel gradient with white text, as in every OS X sidebar; the music list's selected row is the same blue at the page skin's tint; the sorted column is the palest tint of the three.">
                <div className="sg__row aqua-root" style={{ alignItems: 'flex-start' }}>
                  <div style={{ width: 196, height: 150, border: '1px solid #747474', overflow: 'hidden' }}>
                    <SourceList
                      selectedId="work"
                      onSelect={() => undefined}
                      groups={[
                        { id: 'cal', label: 'Calendars', items: [{ id: 'home', label: 'Home', icon: <SourceIcon name="library" /> }, { id: 'work', label: 'Work', icon: <SourceIcon name="playlists" />, count: 3 }] },
                        { id: 'shared', label: 'Shared', items: [{ id: 'club', label: 'Listening Club', icon: <SourceIcon name="groups" />, status: 'no hub', disabled: true }] },
                      ]}
                    />
                  </div>
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
                Two families, one scale. The window skin sets Lucida Grande, as OS X did. The page skin sets <strong>Helvetica</strong> — the face the iPod classic drew its Now
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
                      {step.key === 'system' ? 'Now Playing' : step.key === 'view' ? 'Copper Meridian — Orbital Cartographers' : step.key === 'small' ? '1,240 songs, 2.6 hours, 245 MB' : step.key === 'label' ? 'LIBRARY · PLAYLISTS · CONNECTED' : 'Mini controls only'}
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
                <strong>32 px</strong> (<code>--aqua-hit</code>) is the floor for a pointer target. A 12 px rail and an 18 px row are period-correct and stay that size — they get their hit area from an
                invisible <code>::after</code> that expands past the visual. Never shrink a hit target to match a visual.
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
              <Bed caption="Wells run the other way: shadowed at the top inside, with the lower lip catching light. Same source, opposite surface. The window skin's search field and the page skin's search pill are the same idea at two heights (22 px and 26 px).">
                <div className="sg__row aqua-root">
                  <SearchField value="" onChange={() => undefined} shortcut />
                </div>
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

            <Section id="page" title="The page — what the player is made of">
              <p>
                The music player's skin: a sticky status bar, a section strip, the hero with the jewel case on its stage, the iPod rail and a transport of nine keys, and the
                iTunes 10 list under it. Everything below is live — press play and the case opens; pick a row and the stage follows it.
              </p>
              <PageDemo />
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
              <Bed wide caption="The iTunes equalizer: On beside the preset pop-up, then a preamp and the ten graphic centres on a ±12 dB scale with tick dashes flanking each rail. A one-band preset is chosen here so the greyed rail is visible — those faders name the preset that is not using them.">
                <div className="np-app" style={{ width: '100%' }}>
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
            </Section>

            <Section id="window" title="The window — what the hub and the companion are made of">
              <p>
                The desktop skin: a framed window with traffic lights, a unified toolbar carrying the transport and the LCD, a source list, a work area with a table, and a bottom
                bar. The hub's admin GUI and the Windows companion are both built from this.
              </p>
              <ShellDemo rows={rows} />
              <p className="sg__note">
                Every part of that window is a component: <code>AquaWindow</code>, <code>Toolbar</code>, <code>TrafficLights</code>, <code>Transport</code>, <code>LcdDisplay</code>,{' '}
                <code>Scrubber</code>, <code>VolumeSlider</code>, <code>SearchField</code>, <code>SegmentedControl</code>, <code>AvatarButton</code>, <code>SourceList</code>,{' '}
                <code>WorkArea</code>, <code>Content</code>, <code>AquaTable</code>, <code>Marquee</code>, <code>NowPlayingGlyph</code>, <code>BottomBar</code>, <code>IconButton</code>.
              </p>
            </Section>

            <Section id="controls" title="Controls">
              <p>Shared by both skins and all three products, verbatim.</p>
              <div style={{ display: 'grid', gap: 12 }}>
                <ControlsDemo />
              </div>
            </Section>

            <Section id="overlays" title="Overlays">
              <p>Sheets attach to their window; alerts stand alone; menus open where they are asked for and return focus to what asked. Press the buttons.</p>
              <OverlaysDemo />
            </Section>

            <Section id="states" title="States — the group people skip">
              <p>
                Every screen owes an answer for empty, loading, offline, partial, refused and out-of-date. <code>UnavailableCapabilityState</code> exists so that “this cannot work here” is a
                designed state carrying its reason, rather than a blank pane.
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

            <Section id="results" title="Results and grid">
              <p>The window skin's results popover — the same idea as the page's, at the toolbar's height — and the artwork grid.</p>
              <ResultsDemo />
            </Section>

            <Section id="icons" title="Icons">
              <p>Three families: sixteen-pixel colour source icons for the sidebar, single-colour glyphs for everything else, and the avatar set.</p>
              <IconsDemo />
              <Card label="A page-skin glyph, at the transport's size">
                <div className="np-app" style={{ display: 'flex', gap: 14, fontSize: 24, color: '#1b1c1f' }}>
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
                Which element each product imports today, read from its source. The player is the page skin plus the shared controls; the hub and the companion are the window skin
                plus the same controls.
              </p>
              <table className="sg__map">
                <thead>
                  <tr>
                    <th scope="col">Element</th>
                    <th scope="col">Player (PWA)</th>
                    <th scope="col">Hub admin</th>
                    <th scope="col">Companion</th>
                  </tr>
                </thead>
                <tbody>
                  {PRODUCT_MAP.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      {[row.player, row.hub, row.companion].map((used, i) => (
                        <td key={i}>{used ? <span className="sg__tick">●</span> : <span className="sg__dash">–</span>}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="sg__note">
                The player also draws the search popover, the New Playlist sheet, the toast and the equalizer window with the page skin's classes (shown above) rather than through a
                component; their stylesheet block is the reference's own.
              </p>
            </Section>

            <Section id="access" title="Accessibility">
              <p>Not bolted on afterwards. These are parts of the design.</p>
              <ul className="sg__plain">
                <li>
                  <strong>One tab stop per group, arrows to move.</strong> The section strip, the mode switch, the music list and the context menu all use a roving <code>tabIndex</code>, and the
                  focus ring travels with the selection.
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
              </ul>
            </Section>

            <Section id="extend" title="Changing any of this">
              <ul className="sg__plain">
                <li>
                  <strong>Tokens first.</strong> A new colour or size goes in <code>tokens.json</code>, then into the stylesheet as a custom property. A literal hex in a component is a bug.
                </li>
                <li>
                  <strong>Both schemes.</strong> Light on bare <code>:root</code>; redefine only what changes inside the dark guard.
                </li>
                <li>
                  <strong>Both skins, if it is a control.</strong> Button, Slider and friends are shared by three products.
                </li>
                <li>
                  <strong>Say why in the CSS.</strong> Every unobvious value carries a comment explaining what it reconstructs.
                </li>
                <li>
                  <strong>The gates.</strong> <code>AQUA_CONFORMANCE.md</code> maps every §17/§18 MUST to a test, a named reviewer check, or a recorded deviation, and <code>pnpm verify</code> runs the
                  lot. A deviation is legitimate; an undocumented one is not.
                </li>
                <li>
                  <strong>Rebuild this page.</strong> <code>pnpm build:styleguide</code> regenerates <code>docs/design/styleguide.html</code> from the same source the products use.
                </li>
              </ul>
              <p className="sg__foot">
                The correction log in <code>DEVIATIONS.md</code> is worth reading before a large change. It records the mistakes this system has already made — buttons a decade too glossy, a
                list redesigned instead of expanded, a picker that indexed music it could never play — and every one was found by building the thing and looking at it.
              </p>
            </Section>
          </main>
        </div>
      </ToastProvider>
    </AquaProvider>
  );
}
