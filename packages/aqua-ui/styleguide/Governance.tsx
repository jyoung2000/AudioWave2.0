/**
 * The half of the styleguide that is about behaviour, words, screens and upkeep.
 *
 * Nothing here is written twice. Rules come from design/ux-rules.json, screens and journeys from
 * design/coverage.json, sources and commands from design/manifest.json, decisions from
 * design/decisions.md, Discord replies from the templates the bot renders, and every count from the
 * check the build ran (see vite.config.ts). Edit those files, not this one, to change what it says.
 */
import { Fragment } from 'react';
import { BRANDING, DISCORD_TEMPLATE_KEYS, type DiscordTemplateKey } from '@now-playing/contracts';
import { DEFAULT_DISCORD_TEMPLATES, renderTemplate } from '@now-playing/domain';
import tokens from '../src/styles/tokens.json';
import { Glyph } from '../src/index.js';
import rulesFile from '../../../design/ux-rules.json';
import coverageFile from '../../../design/coverage.json';
import manifestFile from '../../../design/manifest.json';
import decisionsText from '../../../design/decisions.md?raw';
import playerIcon from '../../../music-player/public/icon.svg?raw';
import companionIcon from '../../../windows-companion/resources/icon.svg?raw';

/* -------------------------------------------------------------------- data */

interface Evidence {
  type: string;
  path?: string;
  name?: string;
  note?: string;
}
interface Rule {
  id: string;
  group: string;
  title: string;
  contract: string;
  example?: string;
  authority: string;
  owners: string[];
  evidence: Evidence[];
}
interface Surface {
  id: string;
  kind: string;
  product: string;
  platform: string;
  title: string;
  entry: string;
  sourcePaths: string[];
  states: string[];
  rules: string[];
  mockup?: string;
  authority: string;
  decision?: string;
  commands?: string[];
}
interface Flow {
  id: string;
  title: string;
  preconditions: string;
  steps: string[];
  failures: string[];
  surfaces: string[];
  rules: string[];
  evidence: string[];
}
interface RuntimeRecord {
  date: string;
  scenario: string;
  platform: string;
  viewports: string[];
  theme: string;
  method: string;
  surfaces: string[];
}

const RULES = rulesFile.rules as Rule[];
const RULE_GROUPS = rulesFile.groups;
const SURFACES = coverageFile.surfaces as Surface[];
const FLOWS = coverageFile.flows as Flow[];
const EXCLUSIONS = coverageFile.exclusions;
const RUNTIME = manifestFile.verification.runtime as RuntimeRecord[];
const BLOCKED = (manifestFile.verification as { blocked?: Record<string, string> }).blocked ?? {};
/** Records of interfaces that have since been replaced: kept as history, never counted as seen. */
const SUPERSEDED = ((manifestFile.verification as { superseded?: Array<RuntimeRecord & { why: string }> }).superseded ?? []) as Array<RuntimeRecord & { why: string }>;
const BUILD = __STYLEGUIDE_BUILD__;

const PRODUCTS: Array<{ id: string; label: string; note: string }> = [
  {
    id: 'player',
    label: `${BRANDING.products.player} — the player`,
    note: 'The shell generated from design/frontends/origin/airwave-now-playing.html: the PWA, the single-file build, the Android app and the local helper all show it. Its surfaces are the player-shell rows (adopted). The rows marked proposed are the React interface in music-player/src, which is kept and tested but no longer served (DEC-019).',
  },
  { id: 'hub', label: `${BRANDING.products.hub} — admin window and public pages`, note: 'The Airwave window of design/frontends/origin/airwave-hub.html, served by the container on port 4546. Sign-in and the first-run gate are drawn in the same window.' },
  { id: 'companion', label: `${BRANDING.products.companion} — Windows`, note: 'The Airwave window of design/frontends/origin/airwave-companion.html in an Electron window whose chrome is its title bar.' },
  { id: 'discord', label: 'Discord bot', note: 'Messages rendered from templates the operator can edit.' },
  { id: 'android', label: 'Android shell', note: 'A WebView around the player, plus system UI.' },
  { id: 'local-helper', label: 'Local helper', note: 'A console program that serves the player and runs download tools.' },
];

const runtimeSeen = new Set(RUNTIME.flatMap((record) => record.surfaces));

interface Decision {
  id: string;
  status: string;
  text: string;
}

const DECISIONS: Decision[] = [...decisionsText.matchAll(/^\|\s*(DEC-\d{3})\s*\|\s*([A-Za-z]+)\s*\|\s*(.+?)\s*\|\s*$/gm)].map((m) => ({ id: m[1]!, status: m[2]!, text: m[3]! }));

/** Backticks and bold, which is all the decisions log uses. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}

function Authority({ value }: { value: string }) {
  return <span className={`sg-auth sg-auth--${value.toLowerCase()}`}>{value}</span>;
}

function Paths({ paths }: { paths: string[] }) {
  return (
    <span className="sg-paths">
      {paths.map((path) => (
        <code key={path}>{path}</code>
      ))}
    </span>
  );
}

function svgSource(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* --------------------------------------------------------------- print */

export function PrintCover() {
  return (
    <div className="sg-print-only sg-cover">
      <img className="sg-cover__mark" src={svgSource(playerIcon)} alt="" width={96} height={96} />
      <p className="sg-cover__kicker">Design and behaviour guide</p>
      <h1 className="sg-cover__title">{BRANDING.suiteName} Style Guide</h1>
      <p className="sg-cover__lede">
        {BRANDING.products.player}, {BRANDING.products.hub} and {BRANDING.products.companion}, with the Android app and the Discord bot: one Aqua system, its rules, every screen,
        and how to keep it true.
      </p>
      <dl className="sg-cover__facts">
        <div>
          <dt>Profile</dt>
          <dd>{tokens.profile}</dd>
        </div>
        <div>
          <dt>Source fingerprint</dt>
          <dd>{BUILD.fingerprint}</dd>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd>
            {BUILD.summary.surfaces} surfaces · {BUILD.summary.flows} journeys · {BUILD.summary.rules} rules
          </dd>
        </div>
        <div>
          <dt>Interactive version</dt>
          <dd>docs/design/styleguide.html</dd>
        </div>
      </dl>
    </div>
  );
}

export interface NavGroup {
  group: string;
  items: Array<{ href: string; label: string }>;
}

export function PrintContents({ nav }: { nav: NavGroup[] }) {
  return (
    <nav className="sg-print-only sg-toc" aria-label="Contents">
      <h2 className="sg-toc__title">Contents</h2>
      {nav.map((group) => (
        <div key={group.group} className="sg-toc__group">
          <h3>{group.group}</h3>
          <ol>
            {group.items.map((item) => (
              <li key={item.href}>
                <a href={item.href}>{item.label}</a>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </nav>
  );
}

/* ---------------------------------------------------------- principles */

export function Principles() {
  return (
    <div className="sg__rules">
      {RULES.filter((rule) => rule.group === 'principles').map((rule) => (
        <div key={rule.id} className="sg__rule">
          <b>
            <span className="sg-id">{rule.id}</span> {rule.title}
          </b>
          <span>
            {rule.contract} {rule.example}
          </span>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- brand */

const TERMS: Array<{ term: string; use: string; avoid: string }> = [
  { term: BRANDING.suiteName, use: `The suite, and the player’s own name. The other two apps are ${BRANDING.products.hub} and ${BRANDING.products.companion}; in running text, “the player”, “the hub” and “the companion”.`, avoid: 'Now Playing as a product name; names invented per screen' },
  { term: 'Now Playing', use: 'The player’s home page: what is playing now. Nothing else.', avoid: 'The suite, the hub or the companion' },
  { term: 'Solo / Shared listening', use: 'The two modes on the status bar.', avoid: 'Party mode, sync mode' },
  { term: 'Group', use: 'People listening to one shared queue on a hub.', avoid: 'Room, session' },
  { term: 'Pair', use: 'Connecting a device to a hub, confirmed by a fingerprint.', avoid: 'Log in, register a device' },
  { term: 'Shared link', use: 'A public link to a track or playlist the hub serves.', avoid: 'Share URL, public page' },
  { term: 'Fetch', use: 'Running yt-dlp or spotDL on this machine.', avoid: 'Rip, grab' },
  { term: 'Hub library', use: 'Files that live on the hub’s data volume.', avoid: 'Cloud, server music' },
];

const QUOTES: Array<[string, string, string]> = [
  ['No folders yet', '— add the one this PC keeps these in.', 'Companion · Library ▸ Saved Music'],
  ['Nothing needs you.', 'The whole of an empty “Needs attention” list.', 'Hub · Overview'],
  ['A link that doesn’t answer', 'keeps what it last held, and is tried again by itself.', 'Companion · Live TV'],
  ['A stream never implies a download.', 'Where a provider doesn’t allow saving, there’s no button — not one that fails.', 'Hub · Music ▸ Downloads'],
];

export function Brand() {
  return (
    <>
      <p>
        {BRANDING.suiteName} is a self-hosted music suite: a player that works on the files you already have, a hub you run yourself, and a companion that brings a Windows library
        to it. Its look is a careful reconstruction of Apple’s 2009–2010 interface — the Snow Leopard window, the iTunes 9 list, the iPod’s Now Playing screen — chosen for its
        density and its honesty about state. The reference is <code>docs/design/APPLE_AQUA_2009_2010_UI_DESIGN_SPEC.md</code>.
      </p>
      <div className="sg-brand">
        <figure className="sg-brand__icon">
          <img src={svgSource(playerIcon)} alt={`${BRANDING.products.player} app icon`} width={112} height={112} />
          <figcaption>
            <b>{BRANDING.products.player}</b>
            <code>music-player/public/icon.svg</code>
            <span>Also the Android launcher (brand colour #3b74c8) and the maskable PWA icon.</span>
          </figcaption>
        </figure>
        <figure className="sg-brand__icon">
          <img src={svgSource(companionIcon)} alt={`${BRANDING.products.companion} app icon`} width={112} height={112} />
          <figcaption>
            <b>{BRANDING.products.companion}</b>
            <code>windows-companion/resources/icon.svg</code>
            <span>The same tile with a folder behind the note: the one app that reaches the filesystem.</span>
          </figcaption>
        </figure>
        <figure className="sg-brand__icon sg-brand__glyph">
          <span className="np-app" aria-hidden="true">
            <Glyph name="note" />
          </span>
          <figcaption>
            <b>The note</b>
            <code>packages/aqua-ui/src/icons/glyphs.tsx</code>
            <span>Both icons draw this exact path; a unit test fails if they drift apart again.</span>
          </figcaption>
        </figure>
      </div>
      <h3 className="sg__h3">Using the mark</h3>
      <ul className="sg__plain">
        <li>The tile is a rounded square (radius 112 on a 512 grid), a three-stop blue gradient and a soft gloss over the top half. Keep all three; the gloss is the period detail.</li>
        <li>Never recolour the note or redraw it by hand. Use the SVG or the <code>note</code> glyph.</li>
        <li>The blue tile is the product’s mark. Inside the interface blue is never decoration — it means selected, active or default (see Colour).</li>
        <li>
          <span className="sg-auth sg-auth--proposed">proposed</span> Clear space and minimum size have not been specified. Until they are, keep a quarter of the tile’s width clear
          around it and do not use it below 16px; the tray icon is its own simplified drawing.
        </li>
      </ul>
      <h3 className="sg__h3">Voice</h3>
      <p className="sg__note">
        Plain, specific and a little dry. The product explains what it is doing and what it cannot do, in the place you are looking. It does not apologise, cheer or use exclamation
        marks, and it never claims more than the code does (<span className="sg-id">UX-PRIN-003</span>).
      </p>
      <div className="sg__rules">
        {RULES.filter((rule) => rule.group === 'voice').map((rule) => (
          <div key={rule.id} className="sg__rule">
            <b>
              <span className="sg-id">{rule.id}</span> {rule.title} <Authority value={rule.authority} />
            </b>
            <span>
              {rule.contract} {rule.example}
            </span>
          </div>
        ))}
      </div>
      <h3 className="sg__h3">Words we use</h3>
      <table className="sg-table">
        <thead>
          <tr>
            <th scope="col">Say</th>
            <th scope="col">Meaning</th>
            <th scope="col">Not</th>
          </tr>
        </thead>
        <tbody>
          {TERMS.map((row) => (
            <tr key={row.term}>
              <td>
                <b>{row.term}</b>
              </td>
              <td>{row.use}</td>
              <td className="sg-dim">{row.avoid}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sg__note">
        <span className="sg-auth sg-auth--observed">observed</span> The vocabulary above is how the code and the docs already talk; it has not been reviewed as a glossary.
      </p>
      <h3 className="sg__h3">Real copy</h3>
      <div className="sg-quotes">
        {QUOTES.map(([title, text, where]) => (
          <figure key={where} className="sg-quote">
            <blockquote>
              <b>{title}</b> {text}
            </blockquote>
            <figcaption>{where}</figcaption>
          </figure>
        ))}
      </div>
    </>
  );
}

/* --------------------------------------------------------- interaction */

export function Interaction() {
  return (
    <>
      <p>
        Every rule has a stable ID. Cite it in a change that touches the behaviour, and change the rule, the owning code and its test together. <b>Adopted</b> rules are the
        standard; <b>observed</b> ones describe what the code does today and have not been ratified. The source is <code>design/ux-rules.json</code>.
      </p>
      {RULE_GROUPS.map((group) => (
        <div key={group.id} className="sg-rulegroup">
          <h3 className="sg__h3">{group.title}</h3>
          <div className="sg-rulelist">
            {RULES.filter((rule) => rule.group === group.id).map((rule) => (
              <article key={rule.id} id={rule.id} className="sg-ruleitem">
                <header>
                  <span className="sg-id">{rule.id}</span>
                  <h4>{rule.title}</h4>
                  <Authority value={rule.authority} />
                </header>
                <p>{rule.contract}</p>
                {rule.example ? <p className="sg-dim">{rule.example}</p> : null}
                <dl className="sg-kv">
                  <dt>Owned by</dt>
                  <dd>
                    <Paths paths={rule.owners} />
                  </dd>
                  <dt>Checked by</dt>
                  <dd>
                    <ul className="sg-evidence">
                      {rule.evidence.map((item, i) => (
                        <li key={i}>
                          {item.type === 'reviewer' ? <span className="sg-tag">reviewer</span> : null}
                          {item.path ? <code>{item.path}</code> : null}
                          {item.name ? <span> — “{item.name}”</span> : null}
                          {item.note ? <span className="sg-dim"> {item.note}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </dl>
              </article>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------- screens */

function runtimeLabel(surface: Surface): { text: string; tone: string } {
  if (runtimeSeen.has(surface.id)) return { text: 'seen running', tone: 'ok' };
  if (BLOCKED[surface.product]) return { text: 'not run here', tone: 'blocked' };
  if (surface.mockup) return { text: 'mockup only', tone: 'mock' };
  return { text: 'source only', tone: 'source' };
}

export function Screens() {
  return (
    <>
      <p>
        Every surface found in the products’ own navigation, with the states it has to answer and the rules that govern it. <code>pnpm styleguide:check</code> rebuilds this list
        from the <code>ViewId</code> declarations, the sheet files and the Discord command table, and fails when something appears that is not recorded in{' '}
        <code>design/coverage.json</code>.
      </p>
      <p className="sg__note">
        <b>Seen running</b>: opened in the running product for this revision (see Coverage). <b>Mockup only</b>: rendered at every size in the mockups with fixture data — the hub
        and the companion from their own stylesheets and kits, the player from the component library’s page skin. <b>Not run here</b>: the product could not be started where this guide was built. <b>Source only</b>: checked against the code, not looked at.
      </p>
      {PRODUCTS.map((product) => {
        const surfaces = SURFACES.filter((surface) => surface.product === product.id);
        if (!surfaces.length) return null;
        return (
          <div key={product.id} className="sg-product">
            <h3 className="sg__h3">{product.label}</h3>
            <p className="sg__note">{product.note}</p>
            <table className="sg-table sg-table--screens">
              <thead>
                <tr>
                  <th scope="col">Surface</th>
                  <th scope="col">States it must answer</th>
                  <th scope="col">Rules</th>
                  <th scope="col">Seen</th>
                </tr>
              </thead>
              <tbody>
                {surfaces.map((surface) => {
                  const seen = runtimeLabel(surface);
                  return (
                    <tr key={surface.id} id={`surface-${surface.id}`}>
                      <td>
                        <b>{surface.title}</b>
                        <span className="sg-dim sg-block">{surface.entry}</span>
                        <Paths paths={surface.sourcePaths.slice(0, 2)} />
                        {surface.decision ? <span className="sg-tag">{surface.decision}</span> : null}
                      </td>
                      <td>
                        <ul className="sg-states">
                          {surface.states.map((state) => (
                            <li key={state}>{state}</li>
                          ))}
                        </ul>
                      </td>
                      <td>
                        {surface.rules.map((rule) => (
                          <a key={rule} className="sg-id sg-block" href={`#${rule}`}>
                            {rule}
                          </a>
                        ))}
                      </td>
                      <td>
                        <span className={`sg-seen sg-seen--${seen.tone}`}>{seen.text}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

export function Journeys() {
  return (
    <>
      <p>
        The {FLOWS.length} things people come to do, from where they start to where they can fail. Each step list is what the code does today; each failure is one the product answers in
        words.
      </p>
      <div className="sg-flows">
        {FLOWS.map((flow) => (
          <article key={flow.id} className="sg-flow" id={flow.id}>
            <h4>{flow.title}</h4>
            <p className="sg-dim">{flow.preconditions}</p>
            <ol className="sg-steps">
              {flow.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="sg-flow__label">When it goes wrong</p>
            <ul className="sg-states">
              {flow.failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
            <p className="sg-flow__meta">
              {flow.rules.map((rule) => (
                <a key={rule} className="sg-id" href={`#${rule}`}>
                  {rule}
                </a>
              ))}
            </p>
            <Paths paths={flow.evidence} />
          </article>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------- discord */

const SAMPLE: Record<string, string> = {
  title: 'Signal Fade',
  artist: 'Cassette Bloom',
  album: 'Live from Pier 9',
  requester: 'alex',
  position: '3',
  group: 'Kitchen',
  duration: '0:04',
  elapsed: '0:02',
  remaining: '0:02',
  source: 'Public domain',
  url: 'https://example.invalid/track',
  count: '12',
  channel: '#music',
  reason: '',
  user: 'alex',
  page: '1',
  pages: '2',
};

const WHEN: Record<DiscordTemplateKey, string> = {
  success: 'A command with nothing more specific to say',
  queued: '/play found something playable',
  nowPlaying: '/nowplaying',
  skipped: '/skip by a DJ or the requester',
  permissionDenied: 'The caller lacks the DJ or admin role',
  noResults: '/play found nothing',
  unavailableSource: 'The match cannot stream in Discord',
  emptyQueue: '/queue or /nowplaying with nothing queued',
  joined: '/join, or /play when the bot was not in voice',
  left: '/leave, or the idle timeout',
  error: 'Anything unexpected; the reason is the error message',
  wrongChannel: 'A command outside the designated channel',
  paused: '/pause',
  resumed: '/resume',
  stopped: '/stop',
  shuffled: '/shuffle',
  cleared: '/clear',
};

/** The reason each outcome actually carries, from docker-container/src/group/command-service.ts. */
const REASONS: Partial<Record<DiscordTemplateKey, string>> = {
  skipped: 'skipped',
  permissionDenied: 'the DJ role is required',
  // What the command service passes today — which is how DEC-005 shows up.
  noResults: 'No results',
  unavailableSource: 'YouTube only plays in its own player',
  error: 'Queue is at revision 12',
};

const hex = (value: number | null): string | null => (value === null ? null : `#${value.toString(16).padStart(6, '0')}`);

/** Discord's `**bold**` and line breaks, which is all the default templates use. */
function DiscordText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, index) => (
        <Fragment key={index}>
          {index ? <br /> : null}
          {line.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>))}
        </Fragment>
      ))}
    </>
  );
}

export function Discord() {
  const commands = SURFACES.find((surface) => surface.id === 'discord-replies')?.commands ?? [];
  return (
    <>
      <p>
        The bot is the one surface Aqua does not draw: Discord does. What the suite controls is the words, the embed colour, whether a reply is private, and when the bot moves in
        and out of voice. Replies come from templates an operator can edit in the hub (Admin → Discord); these are the defaults, rendered with sample values by the same function
        the bot uses.
      </p>
      <p className="sg__note">
        Commands:{' '}
        {commands.map((command, i) => (
          <Fragment key={command}>
            {i ? ' ' : null}
            <code>/{command}</code>
          </Fragment>
        ))}
        . Every one also works as a prefix command (<code>!play</code>) once the Message Content intent is granted, and the two forms are identical by construction (
        <a className="sg-id" href="#UX-DISCORD-001">
          UX-DISCORD-001
        </a>
        ). Embed colours are the system’s own: selection blue, success, warning and danger.
      </p>
      <p className="sg-illustration">Illustration — Discord renders its own interface. This shows content and colour, not Discord’s layout.</p>
      <div className="sg-chat">
        {DISCORD_TEMPLATE_KEYS.map((key) => {
          const rendered = renderTemplate(DEFAULT_DISCORD_TEMPLATES.templates[key], { ...SAMPLE, reason: REASONS[key] ?? SAMPLE['reason'] });
          const colour = hex(rendered.color);
          return (
            <div key={key} className="sg-chat__row">
              <div className="sg-chat__meta">
                <code>{key}</code>
                <span className="sg-dim">{WHEN[key]}</span>
                {rendered.ephemeral ? <span className="sg-tag">only the caller sees this</span> : null}
              </div>
              <div className="sg-chat__msg">
                {rendered.content ? (
                  <p>
                    <DiscordText text={rendered.content} />
                  </p>
                ) : null}
                {rendered.embedTitle || rendered.embedDescription ? (
                  <div className="sg-chat__embed" style={colour ? { borderLeftColor: colour } : undefined}>
                    {rendered.embedTitle ? <b>{rendered.embedTitle}</b> : null}
                    {rendered.embedDescription ? (
                      <p>
                        <DiscordText text={rendered.embedDescription} />
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <h3 className="sg__h3">Voice-channel replies</h3>
      <p className="sg__note">Added to the reply when the bot cannot move into voice. They are sentences in the gateway, not templates.</p>
      <ul className="sg__plain">
        <li>“Join a voice channel first (or use join &lt;channel&gt;), so I know where to play.”</li>
        <li>“I need View Channel, Connect and Speak in &lt;channel&gt; to play there.”</li>
        <li>“There is no voice channel called “&lt;name&gt;” that I can see.”</li>
        <li>“Could not connect to the voice channel. Check that the bot has Connect and Speak there, and that outbound UDP is not blocked.”</li>
      </ul>
      <p className="sg-known">
        <b>Known gap (DEC-005).</b> The default <code>noResults</code> template quotes <code>{'{{reason}}'}</code>, but the command service passes the search text as{' '}
        <code>title</code>, so a failed search currently reads “No results for “No results”.”
      </p>
    </>
  );
}

/* ----------------------------------------------------------- platforms */

export function Platforms() {
  return (
    <>
      <div className="sg-platform">
        <h3 className="sg__h3">Web and PWA — player and hub admin</h3>
        <ul className="sg__plain">
          <li>
            <b>Breakpoints follow content, not a device list.</b> The Airwave window changes at 640px — the tools scroll sideways, tiles go two-up, the key–value list stacks and
            tables drop their secondary columns — and at 560px, where side-by-side groups stack. The library’s page skin changes at 480, 560, 620, 720 and 900px. Check at the
            mockup sizes: 320, 390, 768, 1280 and 1680px.
          </li>
          <li>
            <b>The pointer decides density, not the width.</b> <code>(pointer: coarse)</code> switches the touch layer on at any width; a narrow desktop window keeps desktop density
            (<a className="sg-id" href="#UX-TOUCH-001">UX-TOUCH-001</a>). The Airwave window’s touch layer is small — list rows and the round minus grow, buttons do not — which is
            an open question for the hub on a phone (DEC-027).
          </li>
          <li>
            <b>Installable and offline.</b> The player ships a manifest, icons and a service worker, opens with the network off once it has loaded online, and loads nothing from
            another origin. The single-file build, <code>now-playing.html</code>, runs straight from disk.
          </li>
          <li>
            <b>Themes.</b> The player follows the system colour scheme. The Airwave window is light only, in both OS appearances (DEC-003).
          </li>
          <li>
            <b>Keyboard.</b> In the player, Space toggles playback and Escape closes a popover without losing what was typed. In the Airwave window the tools are one tab stop:
            arrows, Home and End move the selection, and locked tools are skipped (<a className="sg-id" href="#UX-KEY-001">UX-KEY-001</a>).
          </li>
        </ul>
      </div>
      <div className="sg-platform">
        <h3 className="sg__h3">Android</h3>
        <ul className="sg__plain">
          <li>
            The app is the player inside a WebView, loaded from its own assets, so every web rule applies unchanged. The player is built with <code>NP_BASE_PATH=/assets/app/</code>.
          </li>
          <li>Back goes back in the page’s history; with nowhere to go it moves the app to the background, so music keeps playing.</li>
          <li>
            System UI carries its own copy (<code>strings.xml</code>): the “Fetching music” notification while a download runs, the document picker for file inputs, and the save
            dialog for exports (“Saved …” / “Could not save …”). Notification permission is asked for the first time a fetch starts (DEC-010).
          </li>
          <li>Hubs are reached over https only (DEC-012).</li>
        </ul>
      </div>
      <div className="sg-platform">
        <h3 className="sg__h3">Windows companion — Electron</h3>
        <ul className="sg__plain">
          <li>
            One window with four tools, 640 × 760 as it opens and never smaller than 520 × 440. Its chrome is its title bar: the operating system’s own is hidden, the page draws
            the title, Windows draws minimise, maximise and close over the top-right corner, and the chrome is the drag region while the tools stay clickable (DEC-020,{' '}
            <a className="sg-id" href="#UX-CHROME-001">UX-CHROME-001</a>).
          </li>
          <li>
            A tray icon (<code>resources/tray.svg</code>) whose menu has Open, Scan Library Now and Quit. With “Keep running in the notification area when the window closes” on,
            closing the window keeps the companion running.
          </li>
          <li>It is the only product that reads the filesystem; its copy says so and never implies files are copied or uploaded in the background.</li>
          <li>Pairing shows the hub’s fingerprint, and a notice warns when the hub address is plain http off the local network.</li>
          <li>
            Live TV links are read by the main process, never by the page: public addresses only, with a size cap and a deadline, and kept only when they hold channels or
            programmes (<a className="sg-id" href="#UX-TV-001">UX-TV-001</a>).
          </li>
        </ul>
      </div>
      <div className="sg-platform">
        <h3 className="sg__h3">Terminal — local helper</h3>
        <ul className="sg__plain">
          <li>Takes the first free port in a small range, prints the token to paste into Settings → Platforms, and names each missing tool with the command that installs it.</li>
          <li>Ctrl+C removes only the helper’s own working folder, never the folder it was pointed at.</li>
        </ul>
      </div>
      <div className="sg-platform">
        <h3 className="sg__h3">Engineering appendix — Docker delivery</h3>
        <p className="sg__note">Docker is how the hub is delivered, not a design surface. What it means for a design change:</p>
        <ul className="sg__plain">
          <li>
            The image (<code>docker-container/Dockerfile</code>) builds the admin window from <code>docker-container/src/web</code> with the generated Airwave stylesheets and
            AquaArt from <code>@now-playing/aqua-ui</code>, so a design change reaches the hub only when the image is rebuilt: <code>docker compose up -d --build</code> or{' '}
            <code>./nowplaying update</code>.
          </li>
          <li>
            The hub listens on port 4546, published to <code>127.0.0.1</code> by default, with <code>/healthz</code> for the health check. Host names other than IP addresses,
            localhost and <code>.local</code>/<code>.lan</code> names must be listed in <code>NP_ALLOWED_HOSTS</code> or set as <code>NP_PUBLIC_ENDPOINT</code>.
          </li>
          <li>
            The Discord worker is the same image under <code>--profile discord</code>. Its default replies change when <code>packages/domain/src/templates.ts</code> changes and the
            image is rebuilt, or immediately when an operator edits a template in the hub.
          </li>
          <li>The player, the Android app and the companion are built separately; each needs its own rebuild to pick up a design change.</li>
        </ul>
      </div>
    </>
  );
}

/* ----------------------------------------------------------- dark scheme */

export function DarkScheme() {
  return (
    <>
      <p className="sg__note">
        The page skin’s colours that change in the dark scheme, read from the shipped stylesheet when this page was built ({BUILD.scheme.length} properties). Light on the left,
        dark on the right.
      </p>
      <div className="sg-scheme">
        {BUILD.scheme.map((row) => (
          <div key={row.name} className="sg-scheme__row">
            <code>{row.name}</code>
            <span className="sg-scheme__chip" style={{ background: row.light }} />
            <span className="sg-scheme__chip" style={{ background: row.dark }} />
            <span className="sg-scheme__values">
              {row.light} → {row.dark}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------- coverage */

export function Coverage() {
  const byProduct = PRODUCTS.map((product) => {
    const surfaces = SURFACES.filter((surface) => surface.product === product.id);
    return {
      ...product,
      total: surfaces.length,
      seen: surfaces.filter((surface) => runtimeSeen.has(surface.id)).length,
      mockup: surfaces.filter((surface) => surface.mockup).length,
      blocked: BLOCKED[product.id] ?? null,
    };
  });
  return (
    <>
      <p>
        What this guide covers and how each part was checked, for source revision <code>{BUILD.fingerprint}</code>. The denominator is every surface in{' '}
        <code>design/coverage.json</code>, which the check keeps in step with the products’ navigation.
      </p>
      <table className="sg-table">
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col" className="sg-num">
              Surfaces
            </th>
            <th scope="col" className="sg-num">
              In mockups
            </th>
            <th scope="col" className="sg-num">
              Seen running
            </th>
            <th scope="col">Not run because</th>
          </tr>
        </thead>
        <tbody>
          {byProduct.map((row) => (
            <tr key={row.id}>
              <td>{row.label}</td>
              <td className="sg-num">{row.total}</td>
              <td className="sg-num">{row.mockup}</td>
              <td className="sg-num">{row.seen}</td>
              <td className="sg-dim">{row.blocked ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sg__note">
        Automatic checks when this page was built: {BUILD.summary.rules} rules with evidence, {BUILD.summary.discovered} surfaces discovered from navigation,{' '}
        {BUILD.summary.discordCommands} Discord commands, {BUILD.summary.tokensChecked} tokens compared with the stylesheets ({BUILD.summary.tokenExceptions} recorded exceptions).{' '}
        {BUILD.problems ? <b>{BUILD.problems} problems were open — run pnpm styleguide:check.</b> : 'No open problems.'}
      </p>
      {BUILD.notes.length ? (
        <ul className="sg-evidence">
          {BUILD.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      <h3 className="sg__h3">Seen in a running product</h3>
      {RUNTIME.length ? (
        <table className="sg-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Scenario</th>
              <th scope="col">Viewports · theme</th>
              <th scope="col" className="sg-num">
                Surfaces
              </th>
            </tr>
          </thead>
          <tbody>
            {RUNTIME.map((record) => (
              <tr key={`${record.date}-${record.scenario}`}>
                <td className="sg-nowrap">{record.date}</td>
                <td>
                  {record.scenario}
                  <span className="sg-dim sg-block">{record.method}</span>
                </td>
                <td>
                  {record.viewports.join(', ')} · {record.theme}
                </td>
                <td className="sg-num">{record.surfaces.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="sg__note">Nothing has been recorded as seen in a running product for this revision.</p>
      )}
      {SUPERSEDED.length ? (
        <>
          <h3 className="sg__h3">Earlier records, superseded</h3>
          <p className="sg__note">What was seen running before an interface was replaced. Kept as history; these surfaces are not counted as seen.</p>
          <ul className="sg__plain">
            {SUPERSEDED.map((record) => (
              <li key={`${record.date}-${record.scenario}`}>
                <b>{record.date}</b> · {record.scenario} <span className="sg-dim">{record.why}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3 className="sg__h3">Decisions and exceptions</h3>
      <table className="sg-table">
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Status</th>
            <th scope="col">Decision</th>
          </tr>
        </thead>
        <tbody>
          {DECISIONS.map((decision) => (
            <tr key={decision.id} id={decision.id}>
              <td className="sg-id sg-nowrap">{decision.id}</td>
              <td>
                <Authority value={decision.status} />
              </td>
              <td>
                <Inline text={decision.text} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="sg__h3">Not covered, on purpose</h3>
      <ul className="sg__plain">
        {EXCLUSIONS.map((item) => (
          <li key={item.id}>
            <code>{item.id}</code> — {item.reason}
          </li>
        ))}
      </ul>
    </>
  );
}

/* ----------------------------------------------------------- governance */

export function Governance() {
  const sources = manifestFile.sources as Record<string, { path?: string; paths?: string[]; owns?: string }>;
  return (
    <>
      <p>
        This page is generated. The sources below are the design authority: change them, then rebuild. The exports — this page and its PDF — are views, so an edit or annotation on
        either is a request to change a source, not a change in itself.
      </p>
      <table className="sg-table">
        <thead>
          <tr>
            <th scope="col">Concern</th>
            <th scope="col">Source</th>
            <th scope="col">Owns</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(sources)
            .filter(([, source]) => source.owns)
            .map(([key, source]) => (
              <tr key={key}>
                <td>{key}</td>
                <td>
                  <Paths paths={source.paths ?? (source.path ? [source.path] : [])} />
                </td>
                <td>{source.owns}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <h3 className="sg__h3">Changing something</h3>
      <ol className="sg-steps">
        <li>Find the owner: a token, a component, a rule by ID, or a surface in the ledger.</li>
        <li>Change it there — and, for a rule, the code that implements it and the test that proves it.</li>
        <li>
          Run <code>pnpm styleguide:check</code> and the tests the rule names; then <code>pnpm styleguide:build</code> and <code>pnpm styleguide:pdf</code>.
        </li>
        <li>Look at the result in the mockups at every size, and at every page of the PDF.</li>
        <li>
          A deliberate exception goes in <code>design/decisions.md</code> with its reason. Never widen an exception to make a check pass.
        </li>
      </ol>
      <h3 className="sg__h3">Commands</h3>
      <dl className="sg-kv">
        {Object.entries(manifestFile.commands).map(([name, text]) => (
          <Fragment key={name}>
            <dt>
              <code>{name}</code>
            </dt>
            <dd>{String(text).replace(/^pnpm [^—]+— /, '')}</dd>
          </Fragment>
        ))}
      </dl>
    </>
  );
}

