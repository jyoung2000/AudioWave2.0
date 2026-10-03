/**
 * The Airwave windows: the hub's admin GUI and the Windows companion, as they are drawn today.
 *
 * Both products are the windows `design/frontends/airwave-hub.html` and `airwave-companion.html`
 * draw. Their look is three things, and all three are the real ones here:
 *
 *   - the stylesheets generated from those design files (`airwave-window.css`, `airwave-hub.css`),
 *     followed by each product's own `styles.css` — put inside the frame by `PRODUCT_CSS`, with
 *     nothing from the component library beside them;
 *   - AquaArt (`../src/airwave/aqua-art.ts`), which draws every push button, pop-up and checkbox —
 *     installed into each frame's document exactly as the products' `main.tsx` installs it;
 *   - each product's own window kit (`docker-container/src/web/ui.tsx`,
 *     `windows-companion/src/renderer/ui.tsx`) and icons, imported from the products.
 *
 * What is written here by hand is the window frame (chrome, tools, pane, status line) and the
 * arrangement of each pane: those live inside `App.tsx` and the view files, which are wired to the
 * hub's API and to Electron's bridge, so they cannot run on a page (design/decisions.md DEC-009).
 * The class names, the order and the words are the views'; the data is fixture data.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { BRANDING } from '@now-playing/contracts';
import { installAquaArt } from '../src/airwave/aqua-art.js';
import airwaveWindowCss from '../src/styles/airwave-window.css?inline';
import airwaveHubCss from '../src/styles/airwave-hub.css?inline';
import hubCss from '../../../docker-container/src/web/styles.css?inline';
import companionCss from '../../../windows-companion/src/renderer/styles.css?inline';
import { TAB_ICONS, type TabIconId } from '../../../docker-container/src/web/icons.js';
import * as Hub from '../../../docker-container/src/web/ui.js';
import * as Companion from '../../../windows-companion/src/renderer/ui.js';
import { DeviceIcon, FolderIcon, LibraryToolIcon, LinkIcon, LiveTvToolIcon, RemoteToolIcon, SettingsToolIcon } from '../../../windows-companion/src/renderer/icons.js';

/** What each product's `main.tsx` imports, in the order it imports it. */
export const HUB_CSS = `${airwaveWindowCss}\n${airwaveHubCss}\n${hubCss}`;
export const COMPANION_CSS = `${airwaveWindowCss}\n${companionCss}`;

/** The stylesheets the Airwave window's custom properties are read from, for the token editor. */
export const AIRWAVE_TOKEN_SOURCES: ReadonlyArray<{ label: string; css: string }> = [
  { label: 'Airwave window (hub, companion)', css: `${airwaveWindowCss}\n${airwaveHubCss}` },
  { label: 'Airwave Hub (contrast inks)', css: hubCss },
];

/** What both products do before their first render: publish AquaArt's drawings on the root element. */
export function prepareAirwaveDocument(doc: Document): void {
  installAquaArt(undefined, doc.documentElement);
}

const noop = (): void => undefined;

/* ====================================================================== hub */

const HUB_TABS: ReadonlyArray<{ id: TabIconId; label: string; lead?: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'devices', label: 'Devices', lead: 'Players and companion apps that may use this hub. Each gets only the permissions you tick when you pair it.' },
  { id: 'music', label: 'Music', lead: 'What the hub plays from, where it looks things up, and what it may save. Everything here is shared by every paired device.' },
  { id: 'groups', label: 'Groups' },
  { id: 'sharing', label: 'Sharing' },
  { id: 'system', label: 'System' },
];

interface HubWindowProps {
  /** The selected tab, or none while the window is signed out. */
  tab: TabIconId | null;
  /** Every tab locked (signed out), or every tab but Overview (the first-run gate). */
  locked?: 'all' | 'gated';
  dot?: 'ok' | 'warn' | 'bad' | 'off';
  status: string;
  counts?: string;
  badge?: number;
  sheet?: ReactNode;
  children: ReactNode;
}

/** The window `docker-container/src/web/App.tsx` renders: chrome, six tools, pane, status strip. */
function HubWindow({ tab, locked, dot = 'ok', status, counts, badge, sheet, children }: HubWindowProps) {
  const current = HUB_TABS.find((item) => item.id === tab);
  return (
    <div className="frame">
      <main className="win" aria-label={BRANDING.products.hub}>
        <div className="chrome">
          <h1 className="titlebar">{BRANDING.products.hub}</h1>
          <div className="toolbar" role="tablist" aria-label="Sections">
            {HUB_TABS.map((item) => {
              const isLocked = locked === 'all' || (locked === 'gated' && item.id !== 'overview');
              return (
                <button key={item.id} type="button" className={`tool${isLocked ? ' locked' : ''}`} role="tab" aria-selected={item.id === tab} aria-disabled={isLocked || undefined} tabIndex={item.id === tab ? 0 : -1}>
                  {TAB_ICONS[item.id]}
                  {item.label}
                  {badge && item.id === 'overview' ? (
                    <>
                      <span className="gear-badge" aria-hidden="true">
                        {badge}
                      </span>
                      <span className="sr">, {badge === 1 ? '1 thing needs attention' : `${badge} things need attention`}</span>
                    </>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
        <div className="pane-host">
          <div className="pane-body">
            <div className="pane" role={tab ? 'tabpanel' : undefined}>
              {current?.lead ? <p className="lead">{current.lead}</p> : null}
              {children}
            </div>
          </div>
          {sheet}
        </div>
        <div className="status">
          <span className={`dot${dot === 'ok' ? '' : ` dot--${dot}`}`} aria-hidden="true" />
          <span id="hubLine" role="status">
            {status}
          </span>
          <span className="spacer" />
          {counts ? <span id="countLine">{counts}</span> : null}
        </div>
      </main>
    </div>
  );
}

const HUB_STATUS = 'Living Room running · 0.0.0.0:4546 · reachable from your network';

function Tile({ heading, dot, big, small }: { heading: string; dot?: Hub.DotKind; big: ReactNode; small: ReactNode }) {
  return (
    <div className="tile">
      <h3>
        {dot ? <Hub.Sdot kind={dot} inline /> : null}
        {heading}
      </h3>
      <span className="big">{big}</span>
      <span className="sm">{small}</span>
    </div>
  );
}

const PROVIDER_HEALTH: ReadonlyArray<{ name: string; dot: Hub.DotKind; word: string }> = [
  { name: 'Hub library', dot: 'ok', word: 'Working' },
  { name: 'MusicBrainz', dot: 'ok', word: 'Working' },
  { name: 'SoundCloud', dot: 'warn', word: 'Limited' },
  { name: 'Spotify', dot: 'bad', word: 'Needs setting up' },
  { name: 'External tool', dot: 'ok', word: 'Working' },
];

function HubOverviewPane({ gated = false }: { gated?: boolean }) {
  return (
    <>
      <div className="tiles">
        <Tile heading="Hub" dot="ok" big="v0.1.0" small={`Up 6 days · ${gated ? 'this machine only' : 'your network'}`} />
        {gated ? <Tile heading="Devices" big="Off" small="Pairing starts once a password is set" /> : <Tile heading="Devices" dot="ok" big="3 paired" small="2 online now" />}
        {gated ? <Tile heading="Groups" big="Off" small="Starts once a password is set" /> : <Tile heading="Groups" dot="ok" big="1 playing" small="2 groups" />}
        {gated ? <Tile heading="Library" big="Off" small="Shown once a password is set" /> : <Tile heading="Library" big="1,240 tracks" small="2 folders · scanned 3 h ago" />}
        <Tile heading="Providers" dot="warn" big="3 of 5 working" small="Hub library, MusicBrainz and more" />
        <Tile heading="Storage" big="310 GB free" small={gated ? 'Never backed up' : 'Last backup 4 h ago'} />
      </div>
      <Hub.Group title="Needs attention">
        <div className="well">
          <ul className="rows" aria-label="Needs attention">
            {gated ? (
              <li>
                <Hub.Sdot kind="warn" />
                <span className="grow">The admin password is still the first-run one. Choose a real password to switch the hub on.</span>
              </li>
            ) : (
              <li>
                <Hub.Sdot kind="warn" />
                <span className="grow">Spotify has no client ID yet. Add one under Music, or switch the provider off.</span>
              </li>
            )}
          </ul>
        </div>
      </Hub.Group>
      <Hub.Group title="Provider health">
        <div className="well">
          <ul className="rows" aria-label="Provider health">
            {PROVIDER_HEALTH.map((row) => (
              <li key={row.name}>
                <Hub.Sdot kind={row.dot} />
                <span className="name">
                  <b>{row.name}</b>
                </span>
                <span className="meta">{row.word}</span>
              </li>
            ))}
          </ul>
        </div>
      </Hub.Group>
      <Hub.Group title="This hub" last>
        <dl className="kv">
          <dt>Name</dt>
          <dd>Living Room</dd>
          <dt>Fingerprint</dt>
          <dd>
            <span className="mono">7F3A-91C2-D04E</span>
            <span className="sub"> · compare it with what a device shows while pairing</span>
          </dd>
          <dt>Public address</dt>
          <dd>None, so pairing and shared links only work on your network</dd>
          <dt>Connected now</dt>
          <dd>{gated ? '0 players and 0 companions' : '2 players and 1 companion'}</dd>
          <dt>Jobs</dt>
          <dd>1 running · 1 waiting · 0 failed · 12 done</dd>
          <dt>Database</dt>
          <dd>
            42 MB in <span className="mono">/data</span>
          </dd>
          <dt>Discord bot</dt>
          <dd>No token yet</dd>
        </dl>
      </Hub.Group>
      <div className="panefoot">
        <p className="note">
          Signed in as <b>admin</b>.
        </p>
        <Hub.Push>Sign Out</Hub.Push>
      </div>
    </>
  );
}

/** The warning triangle the gate and the confirmation sheet share. */
function Caution() {
  return (
    <svg className="gate__icon" viewBox="0 0 26 26" aria-hidden="true">
      <path d="M13 2.5 24 22H2z" fill="#f2c14e" stroke="#9a6a08" strokeLinejoin="round" />
      <path d="M13 9v6.5" stroke="#3b2a05" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="13" cy="18.8" r="1.3" fill="#3b2a05" />
    </svg>
  );
}

/** First run: the design's amber gate on Overview, the other five tabs locked (DEC-017). */
export function HubFirstRunScreen() {
  return (
    <HubWindow tab="overview" locked="gated" dot="warn" status="Living Room running · 127.0.0.1:4546 · reachable from this machine only" counts="0 connected · 0 playing" badge={1}>
      <div className="gate" role="region" aria-labelledby="gateH">
        <Caution />
        <div className="gate__body">
          <h2 id="gateH">Choose a real password</h2>
          <p>
            You’re signed in as <b>admin / admin</b>. Until you change it, the hub stays on this machine: no pairing, no providers, no group listening, no Discord bot and no remote access. The server enforces this, not this
            page.
          </p>
          <form className="barrow" onSubmit={(event) => event.preventDefault()} noValidate>
            <Hub.Field type="password" placeholder="New password" aria-label="New password" autoComplete="new-password" defaultValue="" />
            <Hub.Field type="password" placeholder="Again" aria-label="New password again" autoComplete="new-password" defaultValue="" />
            <Hub.Push type="submit" primary>
              Set Password
            </Hub.Push>
          </form>
        </div>
      </div>
      <HubOverviewPane gated />
    </HubWindow>
  );
}

/** Not signed in: the same window, every tab locked, the form in the pane. */
export function HubSignInScreen() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  return (
    <HubWindow tab={null} locked="all" dot="off" status="Not signed in">
      <form className="signin" onSubmit={(event) => event.preventDefault()} noValidate>
        <fieldset className="group--last">
          <legend>
            <h2 className="legend-h">Sign in</h2>
          </legend>
          <p className="hint">
            First run: sign in with <b>admin</b> / <b>admin</b>. You’ll choose a real password before anything else is switched on.
          </p>
          <div className="pref signin__pref">
            <label className="k" htmlFor="signin-user">
              Username:
            </label>
            <div className="v">
              <Hub.Field id="signin-user" value={username} autoComplete="username" onChange={(event) => setUsername(event.currentTarget.value)} />
            </div>
            <label className="k" htmlFor="signin-pass">
              Password:
            </label>
            <div className="v">
              <Hub.Field id="signin-pass" type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.currentTarget.value)} />
            </div>
          </div>
        </fieldset>
        <Hub.Push type="submit" primary>
          Sign In
        </Hub.Push>
      </form>
    </HubWindow>
  );
}

export function HubOverviewScreen() {
  return (
    <HubWindow tab="overview" dot="warn" status={HUB_STATUS} counts="3 connected · 1 playing" badge={1}>
      <HubOverviewPane />
    </HubWindow>
  );
}

type CapLevel = 'yes' | 'part' | 'no';
const CAP_WORDS: Record<CapLevel, string> = { yes: 'yes', part: 'partly', no: 'no' };

function Cap({ label, level }: { label: string; level: CapLevel }) {
  return (
    <span className={`cap cap--${level}`} title={`${label}: ${CAP_WORDS[level]}`}>
      {label}
      <span className="sr">: {CAP_WORDS[level]}</span>
    </span>
  );
}

const PROVIDERS: ReadonlyArray<{ name: string; role: string; dot: Hub.DotKind; word: string; caps: [CapLevel, CapLevel, CapLevel, CapLevel]; setUp?: boolean }> = [
  { name: 'Hub library', role: 'Library', dot: 'ok', word: 'Working', caps: ['yes', 'yes', 'yes', 'yes'] },
  { name: 'MusicBrainz', role: 'Metadata only', dot: 'ok', word: 'Working', caps: ['yes', 'no', 'no', 'no'] },
  { name: 'SoundCloud', role: 'Audio source', dot: 'warn', word: 'Limited', caps: ['yes', 'part', 'part', 'part'], setUp: true },
  { name: 'Spotify', role: 'Metadata only', dot: 'bad', word: 'Needs setting up', caps: ['part', 'no', 'no', 'no'], setUp: true },
  { name: 'External tool', role: 'Tool', dot: 'ok', word: 'Working', caps: ['no', 'no', 'no', 'yes'] },
];

export function HubProvidersScreen() {
  return (
    <HubWindow tab="music" status={HUB_STATUS} counts="3 connected · 1 playing">
      <Hub.Group title="Providers" hint="Used through their own APIs and within their terms. What each can do is what its terms allow, not what would be convenient.">
        <div className="well">
          <table className="tbl" aria-label="Providers">
            <colgroup>
              <col style={{ width: '26%' }} />
              <col className="hide-sm" style={{ width: '18%' }} />
              <col />
              <col style={{ width: 92 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col" className="hide-sm">
                  Role
                </th>
                <th scope="col">What it can do</th>
                <th scope="col">
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.map((row) => (
                <tr key={row.name}>
                  <td title={row.word}>
                    <Hub.Sdot kind={row.dot} label={row.word} inline />
                    <b>{row.name}</b>
                  </td>
                  <td className="hide-sm">{row.role}</td>
                  <td>
                    <span className="caps">
                      {(['Search', 'Stream', 'Group sync', 'Download'] as const).map((label, i) => (
                        <Cap key={label} label={label} level={row.caps[i]!} />
                      ))}
                    </span>
                  </td>
                  <td className="acts">
                    <Hub.Push aria-label={`${row.setUp ? 'Set up' : 'Details of'} ${row.name}`}>{row.setUp ? 'Set Up' : 'Details'}</Hub.Push>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Hub.SubHead>Requests and limits</Hub.SubHead>
        <div className="well">
          <table className="tbl" aria-label="Requests and limits">
            <colgroup>
              <col />
              <col style={{ width: '20%' }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '16%' }} className="hide-sm" />
              <col style={{ width: '14%' }} className="hide-sm" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">This minute</th>
                <th scope="col">Today</th>
                <th scope="col" className="num hide-sm">
                  In progress
                </th>
                <th scope="col" className="num hide-sm">
                  Waiting
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>MusicBrainz</td>
                <td>12 of 50</td>
                <td>340, no daily limit</td>
                <td className="num hide-sm">1</td>
                <td className="num hide-sm">0</td>
              </tr>
              <tr>
                <td>SoundCloud</td>
                <td>0 of 30</td>
                <td>18 of 15000</td>
                <td className="num hide-sm">0</td>
                <td className="num hide-sm">0</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Hub.Group>
    </HubWindow>
  );
}

export function HubDownloadsScreen() {
  return (
    <HubWindow tab="music" status={HUB_STATUS} counts="3 connected · 1 playing">
      <Hub.Group title="Downloads">
        <div className="well">
          <table className="tbl" aria-label="Downloads">
            <colgroup>
              <col />
              <col className="hide-sm" style={{ width: '18%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: 132 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="hide-sm">
                  From
                </th>
                <th scope="col">Format</th>
                <th scope="col">Progress</th>
                <th scope="col">
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Long Wave Sessions, Vol. 2 — Fennel Grove</td>
                <td className="hide-sm">External tool</td>
                <td>FLAC</td>
                <td>
                  <div className="bar" role="progressbar" aria-label="Converting, 72%" aria-valuemin={0} aria-valuemax={100} aria-valuenow={72} title="Converting · 72%">
                    <i style={{ width: '72%' }} />
                  </div>
                </td>
                <td className="acts">
                  <Hub.Push aria-label="Pause Long Wave Sessions, Vol. 2">Pause</Hub.Push>
                  <Hub.Push aria-label="Cancel Long Wave Sessions, Vol. 2">Cancel</Hub.Push>
                </td>
              </tr>
              <tr>
                <td>Quiet Arithmetic — Marlow &amp; the Tidewater</td>
                <td className="hide-sm">SoundCloud</td>
                <td>Original</td>
                <td>
                  <span className="sub">Waiting</span>
                </td>
                <td className="acts">
                  <Hub.Push aria-label="Pause Quiet Arithmetic">Pause</Hub.Push>
                  <Hub.Push aria-label="Cancel Quiet Arithmetic">Cancel</Hub.Push>
                </td>
              </tr>
              <tr>
                <td>Signal Fade — Cassette Bloom</td>
                <td className="hide-sm">External tool</td>
                <td>MP3</td>
                <td>
                  <span className="bad">Failed</span>
                </td>
                <td className="acts">
                  <Hub.Push aria-label="Retry Signal Fade">Retry</Hub.Push>
                </td>
              </tr>
              <tr>
                <td>Copper Meridian — Orbital Cartographers</td>
                <td className="hide-sm">Hub library</td>
                <td>Opus</td>
                <td>
                  <span className="ok">✓ Done</span>
                </td>
                <td className="acts" />
              </tr>
            </tbody>
          </table>
        </div>
        <Hub.Note>The site refused the request. Check that the link still opens, then try again.</Hub.Note>
        <div className="pref pref--after">
          <span className="k top">Output formats:</span>
          <div className="v">
            <span className="caps">
              {['Original', 'MP3', 'AAC', 'Opus'].map((label) => (
                <span key={label} className="cap cap--yes">
                  {label}
                  <span className="sr">: available</span>
                </span>
              ))}
              <span className="cap cap--no" title="This FFmpeg build has no FLAC encoder">
                FLAC
                <span className="sr">: not available</span>
              </span>
            </span>
            <span className="sub">Converted with the FFmpeg in this container. Turning a lossy file into FLAC makes it bigger, not better.</span>
          </div>
          <span className="k top">Storage:</span>
          <div className="v">
            <span>
              <span className="path">/data</span> · 2.1 GB used by downloads · 310 GB free
            </span>
            <span className="sub">Failed downloads are cleared after 7 days, unfinished files after 24 hours.</span>
          </div>
        </div>
        <Hub.Note>A stream never implies a download. Where a provider doesn’t allow saving, there’s no button — not one that fails.</Hub.Note>
      </Hub.Group>
    </HubWindow>
  );
}

/** Asks the hub kit's real confirmation sheet as soon as the screen is drawn. */
function HubAsk({ request }: { request: Hub.ConfirmRequest }) {
  const { confirm } = Hub.useHubUi();
  useEffect(() => {
    void confirm(request);
  }, [confirm, request]);
  return null;
}

const HUB_REVOKE: Hub.ConfirmRequest = { title: 'Revoke Kitchen iPad?', text: 'It is disconnected straight away and has to pair again to come back.', verb: 'Revoke' };

const DEVICES: ReadonlyArray<{ name: string; kind: string; dot: Hub.DotKind; state: string; scopes: number; seen: string }> = [
  { name: 'Kitchen iPad', kind: 'Player', dot: 'ok', state: 'Online', scopes: 6, seen: 'now' },
  { name: 'DESKTOP-7Q companion', kind: 'Windows companion', dot: 'ok', state: 'Online', scopes: 5, seen: 'now' },
  { name: 'Old phone', kind: 'Player', dot: 'off', state: 'Offline', scopes: 4, seen: 'yesterday' },
];

/** A destructive action asks in a sheet over the pane; Cancel has the focus (UX-SAFE-001, DEC-021). */
export function HubConfirmScreen() {
  return (
    <Hub.HubUiProvider gated={false}>
      {({ message, sheet }) => (
        <HubWindow tab="devices" status={message ?? HUB_STATUS} counts="3 connected · 1 playing" sheet={sheet}>
          <HubAsk request={HUB_REVOKE} />
          <Hub.Group title="Paired devices" last>
            <div className="well">
              <table className="tbl" aria-label="Paired devices">
                <colgroup>
                  <col />
                  <col style={{ width: '22%' }} />
                  <col style={{ width: '16%' }} />
                  <col style={{ width: '18%' }} className="hide-sm" />
                  <col style={{ width: 74 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Permissions</th>
                    <th scope="col" className="hide-sm">
                      Last seen
                    </th>
                    <th scope="col">
                      <span className="sr">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {DEVICES.map((device) => (
                    <tr key={device.name}>
                      <td>
                        <Hub.Sdot kind={device.dot} label={device.state} inline />
                        {device.name}
                      </td>
                      <td>{device.kind}</td>
                      <td>{device.scopes} of 16</td>
                      <td className="hide-sm">{device.seen}</td>
                      <td className="acts">
                        <Hub.Push aria-label={`Revoke ${device.name}`}>Revoke</Hub.Push>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Hub.Group>
        </HubWindow>
      )}
    </Hub.HubUiProvider>
  );
}

/* ================================================================ companion */

type CompanionTab = 'library' | 'live-tv' | 'remote' | 'settings';

const COMPANION_TABS: ReadonlyArray<{ id: CompanionTab; label: string; icon: () => ReactNode; lead: string }> = [
  { id: 'library', label: 'Library', icon: LibraryToolIcon, lead: 'The folders on this PC that Airwave plays from. The companion watches them and, once sharing is on, passes what it finds to your Airwave Hub so every device sees the same library.' },
  { id: 'live-tv', label: 'Live TV', icon: LiveTvToolIcon, lead: 'Channel playlists and programme guides for the Live TV tab. Paste a link and it is checked, kept here, and passed to the Airwave player on this PC.' },
  { id: 'remote', label: 'Remote', icon: RemoteToolIcon, lead: 'Reach this PC from the Airwave player wherever you are. Every connection is encrypted, and only devices you pair here can connect.' },
  { id: 'settings', label: 'Settings', icon: SettingsToolIcon, lead: 'The tools this PC downloads with, and how the companion behaves on this PC. Changes take effect as you make them.' },
];

/**
 * The window `windows-companion/src/renderer/App.tsx` renders. The chrome is also the title bar: the
 * operating system's own is hidden and Windows draws minimise, maximise and close over its top-right
 * corner (DEC-020), which a frame on a page cannot show.
 */
function CompanionWindow({ tab, badge, hubLine = 'Connected to Living Room · synced 4 min ago', dot = 'ok', children }: { tab: CompanionTab; badge?: number; hubLine?: string; dot?: 'ok' | 'warn' | 'off'; children: ReactNode }) {
  const current = COMPANION_TABS.find((item) => item.id === tab)!;
  return (
    <div className="win">
      <div className="chrome">
        <div className="titlebar" role="heading" aria-level={1}>
          {BRANDING.products.companion}
        </div>
        <div className="toolbar" role="tablist" aria-label="Sections">
          {COMPANION_TABS.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" className="tool" role="tab" aria-selected={item.id === tab} tabIndex={item.id === tab ? 0 : -1}>
                <Icon />
                {item.label}
                {badge && item.id === 'settings' ? (
                  <>
                    <span className="gear-badge" aria-hidden="true">
                      {badge}
                    </span>
                    <span className="sr">, {badge === 1 ? '1 downloader needs attention' : `${badge} downloaders need attention`}</span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      <section className="pane" role="tabpanel">
        <p className="lead">{current.lead}</p>
        {children}
      </section>
      <div className="status">
        <span className={dot === 'ok' ? 'dot' : `dot dot--${dot}`} aria-hidden="true" />
        <span className="status__hub">{hubLine}</span>
        <span className="spacer" />
        <span className="status__counts">3 folders · 2 playlists · 1 guide · 1 device</span>
      </div>
    </div>
  );
}

function Sect({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="sect" aria-label={label}>
      {children}
    </section>
  );
}

function FolderRow({ path, state, bad, music }: { path: string; state: string; bad?: boolean; music?: boolean }) {
  return (
    <li>
      <FolderIcon />
      <span className="name" title={path}>
        {path}
      </span>
      <span className={bad ? 'meta bad' : 'meta'}>{state}</span>
      {music ? (
        <button type="button" className="rm rm--again" aria-label={`Scan ${path} again`} title={bad ? 'Reconnect this folder’s drive to scan it' : 'Scan Again'} disabled={bad}>
          ↻
        </button>
      ) : null}
      <Companion.Remove label={`Remove ${path}`} />
    </li>
  );
}

const SONGS: ReadonlyArray<{ title: string; artist: string; album: string; time: string; tempo: string | null; measured?: boolean }> = [
  { title: 'Midnight Set, Side B', artist: 'Fennel Grove', album: 'Long Wave Sessions, Vol. 2', time: '2:58', tempo: '118' },
  { title: 'Quiet Arithmetic', artist: 'Marlow & the Tidewater', album: 'Harbour Lights', time: '4:12', tempo: '96', measured: true },
  { title: 'Copper Meridian', artist: 'Orbital Cartographers', album: 'Copper Meridian', time: '5:40', tempo: null },
  { title: 'Signal Fade', artist: 'Cassette Bloom', album: 'Live from Pier 9', time: '3:31', tempo: null },
];

/** The Library tab: Saved Music, Saved TV, Saved Movies, then Music on This PC. */
export function CompanionLibraryScreen() {
  const [chosen, setChosen] = useState(0);
  return (
    <CompanionWindow tab="library">
      <Sect label="Folders">
        <fieldset>
          <legend>Saved Music</legend>
          <Companion.Rows label="Music folders">
            <FolderRow path="D:\Music\Albums" state="6,204 songs" music />
            <FolderRow path="E:\Archive\Vinyl rips" state="not connected" bad music />
          </Companion.Rows>
          <div className="barrow">
            <Companion.Push>Add Folder…</Companion.Push>
          </div>
          <p className="note">One folder isn’t connected right now. What was found there stays listed — reconnect the drive and it is picked up again.</p>
        </fieldset>
        <fieldset>
          <legend>Saved TV</legend>
          <Companion.Rows label="TV folders">
            <Companion.EmptyRow>No folders yet — add the one this PC keeps these in.</Companion.EmptyRow>
          </Companion.Rows>
          <div className="barrow">
            <Companion.Push>Add Folder…</Companion.Push>
          </div>
        </fieldset>
        <fieldset>
          <legend>Saved Movies</legend>
          <Companion.Rows label="Movie folders">
            <FolderRow path="D:\Video\Films" state="watched" />
          </Companion.Rows>
          <div className="barrow">
            <Companion.Push>Add Folder…</Companion.Push>
          </div>
        </fieldset>
      </Sect>
      <Sect label="Music">
        <fieldset>
          <legend>Music on This PC</legend>
          <p className="hint">What the companion found in your music folders. Choose a song and press Enter to see its file.</p>
          <div className="well tracks">
            <table className="tbl" role="grid" aria-label="Music" aria-multiselectable="true" aria-rowcount={SONGS.length}>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Artist</th>
                  <th scope="col">Album</th>
                  <th scope="col" className="num tbl__time">
                    Time
                  </th>
                  <th scope="col" className="num tbl__tempo">
                    Tempo
                  </th>
                </tr>
              </thead>
              <tbody>
                {SONGS.map((row, index) => (
                  <tr key={row.title} aria-selected={index === chosen} tabIndex={index === chosen ? 0 : -1} onClick={() => setChosen(index)}>
                    <td title={row.title}>{row.title}</td>
                    <td title={row.artist}>{row.artist}</td>
                    <td title={row.album}>{row.album}</td>
                    <td className="num">{row.time}</td>
                    <td className="num">{row.tempo ? row.measured ? <span title="Measured from the audio">≈{row.tempo}</span> : row.tempo : <span className="dim">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="barrow">
            <input className="field field--search" type="search" defaultValue="" placeholder="Search titles, artists and albums" aria-label="Search music" spellCheck={false} />
            <Companion.Push>Scan Now</Companion.Push>
            <Companion.Push>Show in Explorer</Companion.Push>
            <Companion.Push>Send to Hub</Companion.Push>
          </div>
          <p className="note" role="status">
            6,204 songs · showing the first 500 · 1 chosen
          </p>
          <p className="note">Setting up FFmpeg — tempos appear once it finishes.</p>
        </fieldset>
      </Sect>
    </CompanionWindow>
  );
}

function LinkRow({ url, state, text, again }: { url: string; state: 'ok' | 'failed' | 'checking'; text?: string; again?: boolean }) {
  return (
    <li>
      <LinkIcon />
      <span className="name" title={url}>
        {url}
      </span>
      {state === 'checking' ? <span className="meta">checking…</span> : state === 'ok' ? <span className="meta ok">✓ {text}</span> : <span className="meta bad">{text}</span>}
      {again ? <Companion.Push className="push--row">Check Again</Companion.Push> : null}
      <Companion.Remove label={`Remove ${url}`} />
    </li>
  );
}

/** Live TV: a link is kept only after the main process has read it and found channels or programmes. */
export function CompanionLiveTvScreen() {
  const [typed, setTyped] = useState('http://192.168.1.40/guide.xml');
  return (
    <CompanionWindow tab="live-tv">
      <Sect label="Live TV">
        <fieldset>
          <legend>Channel playlists (M3U)</legend>
          <p className="hint">
            One or more <code>.m3u</code> / <code>.m3u8</code> links. Every channel they list appears in the guide.
          </p>
          <Companion.Rows label="M3U links" live>
            <LinkRow url="https://iptv.example.com/basic.m3u8" state="ok" text="112 channels" />
            <LinkRow url="https://tv.example.org/regional.m3u" state="failed" text="unreachable" again />
            <LinkRow url="https://example.net/sport.m3u8" state="checking" />
          </Companion.Rows>
          <form className="barrow" noValidate onSubmit={(event) => event.preventDefault()}>
            <input className="field" type="url" inputMode="url" defaultValue="" placeholder="https://example.com/channels.m3u8" aria-label="M3U link" spellCheck={false} autoComplete="off" />
            <Companion.Push type="submit" isDefault disabled reason="Paste a link first.">
              Add
            </Companion.Push>
          </form>
          <p className="note">A link that doesn’t answer keeps what it last held, and is tried again by itself.</p>
        </fieldset>
        <fieldset>
          <legend>Programme guides (EPG)</legend>
          <p className="hint">
            XMLTV links. The guide fills the <b>Now</b>, <b>Next</b> and <b>Until</b> columns.
          </p>
          <Companion.Rows label="EPG links" live>
            <LinkRow url="https://iptv.example.com/guide.xml" state="ok" text="7-day guide" />
          </Companion.Rows>
          <form className="barrow" noValidate onSubmit={(event) => event.preventDefault()}>
            <input className="field bad-field" type="url" inputMode="url" value={typed} onChange={(event) => setTyped(event.currentTarget.value)} placeholder="https://example.com/guide.xml" aria-label="EPG link" aria-invalid aria-describedby="sg-tv-epg-error" spellCheck={false} autoComplete="off" />
            <Companion.Push type="submit" isDefault>
              Add
            </Companion.Push>
          </form>
          <p className="note note--bad" id="sg-tv-epg-error" role="alert">
            That address is on this PC or your own network. Live TV links need an address on the internet.
          </p>
        </fieldset>
      </Sect>
    </CompanionWindow>
  );
}

const TIERS = [
  { value: 'lossless', label: 'Lossless' },
  { value: 'high', label: 'High · 256 kbps' },
  { value: 'saver', label: 'Data Saver · 128 kbps' },
];

/** The Remote tab: stream to your devices, the hub connection and what is shared, transfers. */
export function CompanionRemoteScreen() {
  const [share, setShare] = useState(true);
  const [stream, setStream] = useState(true);
  return (
    <CompanionWindow tab="remote">
      <Sect label="Stream to your devices">
        <div className="remote-grid">
          <fieldset style={{ margin: 0 }}>
            <legend>Pair a device</legend>
            <div className="lcd" role="status">
              <span className="lcd__code" aria-label="Pairing code 4 8 2 9 1 6">
                482 916
              </span>
              <span className="lcd__sub">Code expires in 4:12</span>
            </div>
            <div className="barrow">
              <Companion.Push>New Code</Companion.Push>
              <Companion.Push>Copy Ticket</Companion.Push>
            </div>
            <div className="pairhow">
              <ol className="steps">
                <li>
                  Open the player and choose <b>Settings&nbsp;▸ Sources&nbsp;▸ Connections</b>.
                </li>
                <li>Scan the QR code or paste the ticket, then enter this code.</li>
                <li>The device appears below — that’s it.</li>
              </ol>
            </div>
          </fieldset>
          <fieldset style={{ margin: 0 }}>
            <legend>How devices may connect</legend>
            <div className="opts">
              <Companion.Option title="Let paired devices stream from this PC" checked={stream} onChange={(event) => setStream(event.currentTarget.checked)}>
                On your home network they connect directly. Away from home they connect directly where the network allows, or through an encrypted relay where it doesn’t.
              </Companion.Option>
            </div>
            <p className="note" role="status">
              <Companion.Status kind={stream ? 'ok' : 'off'}>{stream ? 'Streaming is on' : 'Streaming is off'}</Companion.Status>
            </p>
            <p className="note">Every connection is encrypted. A pairing code works once, and only devices paired here can connect.</p>
          </fieldset>
        </div>
        <fieldset style={{ marginTop: 16 }}>
          <legend>Paired devices</legend>
          <Companion.Rows label="Paired devices">
            <li>
              <DeviceIcon />
              <span className="name">
                <b>Pixel 9</b>
              </span>
              <span className="meta">Android · through a relay · 48 ms</span>
              <Companion.Pop className="pop--row" aria-label="Best quality Pixel 9 may ask for" defaultValue="high" options={TIERS} />
              <Companion.Remove label="Revoke Pixel 9" />
            </li>
          </Companion.Rows>
        </fieldset>
      </Sect>
      <Sect label="Hub connection">
        <fieldset>
          <legend>Hub connection</legend>
          <div className="pref">
            <span className="k">Hub:</span>
            <div className="v">
              <b>Living Room</b>
              <span className="path">http://192.168.1.20:4546</span>
            </div>
            <span className="k top">Status:</span>
            <div className="v">
              <Companion.Status kind="ok">Connected</Companion.Status>
            </div>
            <span className="k">Fingerprint:</span>
            <div className="v">
              <span className="path">7F3A-91C2-D04E</span>
            </div>
            <span className="k top">This PC may:</span>
            <div className="v">Send and receive files and serve files to your devices.</div>
            <span className="k">Last synced:</span>
            <div className="v">{share ? '4 min ago.' : 'Not yet'}</div>
            <span className="k" />
            <div className="v">
              <Companion.Push disabled={!share} reason={share ? null : 'Turn on sharing below first: until then there is nothing to sync.'}>
                Sync Now
              </Companion.Push>
              <Companion.Push>Forget This Hub…</Companion.Push>
            </div>
          </div>
        </fieldset>
        <fieldset>
          <legend>What is shared</legend>
          <Companion.Check checked={share} onChange={(event) => setShare(event.currentTarget.checked)}>
            Let the hub see what music is on this PC
          </Companion.Check>
          <ul className="plainlist">
            <li>What is sent: titles, artists, albums, durations, formats and playlist contents.</li>
            <li>What is never sent: the folders on this PC, or any path within them.</li>
            <li>Audio files stay here until you send one yourself, with Send to Hub in Library.</li>
            <li>Turning this off stops future syncs. The hub’s administrator can delete what it already has.</li>
          </ul>
        </fieldset>
      </Sect>
      <Sect label="Transfers">
        <fieldset>
          <legend>Transfers</legend>
          <p className="hint">Songs you send to the hub. Files go through the hub rather than device to device, and a transfer picks up where it stopped when either side reconnects.</p>
          <Companion.Rows label="Transfers" live>
            <li>
              <span className="name" title="Midnight Set, Side B">
                <b>Midnight Set, Side B</b>
              </span>
              <Companion.Progress label="Sending Midnight Set, Side B" value={38} />
              <span className="meta">11.4 MB of 30.1 MB</span>
              <Companion.Push className="push--row">Cancel</Companion.Push>
            </li>
            <li>
              <span className="name" title="Quiet Arithmetic">
                <b>Quiet Arithmetic</b>
              </span>
              <span className="meta ok">to hub · sent</span>
            </li>
            <li>
              <span className="name" title="Signal Fade">
                <b>Signal Fade</b>
              </span>
              <span className="meta bad">to hub · didn’t send</span>
            </li>
          </Companion.Rows>
          <p className="note note--bad">Signal Fade didn’t send: the hub stopped answering.</p>
        </fieldset>
      </Sect>
    </CompanionWindow>
  );
}

const TOOLS: ReadonlyArray<{ name: string; version?: string; kind: Companion.DotKind; label: string; role: string; progress?: number; auto?: boolean; path?: string; failed?: boolean }> = [
  { name: 'yt-dlp', version: '2026.09.14', kind: 'ok', label: 'Ready', role: 'Audio and video from the sites it supports', auto: true, path: 'C:\\Users\\You\\AppData\\Roaming\\now-playing-companion\\tools\\yt-dlp.exe' },
  { name: 'spotDL', kind: 'warn', label: 'Couldn’t set up: the download did not finish.', role: 'Finds the audio for a playlist you link. Runs on this PC only.', failed: true },
  { name: 'FFmpeg', kind: 'busy', label: 'Setting up… 42%', role: 'Converts, tags and joins what the others fetch', progress: 42 },
];

/** Settings ▸ Downloaders, General and Network, with the pane's foot (UX-SETUP-001). */
export function CompanionSettingsScreen() {
  const [prefs, setPrefs] = useState({ launch: false, tray: true, watch: true, sync: false });
  return (
    <CompanionWindow tab="settings" badge={1}>
      <Sect label="Settings">
        <fieldset>
          <legend>Downloaders</legend>
          <p className="hint">The copies on this PC, set up automatically and checked against what their projects publish. The hub keeps its own; spotDL runs only here.</p>
          <Companion.Rows label="Downloaders" live>
            {TOOLS.map((tool) => (
              <li key={tool.name} className="dl">
                <span className={`sdot sdot--${tool.kind}`} aria-hidden="true" />
                <span className="dl__main">
                  <span>
                    <b>{tool.name}</b>
                    {tool.version ? <span className="ver">{tool.version}</span> : null}
                  </span>
                  <span className="dl__state">{tool.label}</span>
                  {tool.progress !== undefined ? <Companion.Progress label={`Setting up ${tool.name}`} value={tool.progress} /> : null}
                  <span className="dl__role">{tool.role}</span>
                  {tool.auto ? <span className="dl__role">Set up automatically</span> : null}
                  {tool.path ? <span className="dl__path">{tool.path}</span> : null}
                </span>
                {tool.failed ? (
                  <span className="dl__acts">
                    <Companion.Push>Try Again</Companion.Push>
                  </span>
                ) : null}
              </li>
            ))}
          </Companion.Rows>
          <div className="barrow">
            <Companion.Push>Check All</Companion.Push>
            <span className="note" style={{ margin: 0 }}>
              Last checked 2 min ago
            </span>
          </div>
          <p className="note">Downloaders fetch only what a site offers. The companion doesn’t strip DRM, get round a provider’s terms or read browser cookies.</p>
        </fieldset>
        <fieldset>
          <legend>General</legend>
          <div className="pref">
            <span className="k top">On this PC:</span>
            <div className="v stack">
              <Companion.Check checked={prefs.launch} onChange={(event) => setPrefs({ ...prefs, launch: event.currentTarget.checked })}>
                Start when Windows starts
              </Companion.Check>
              <Companion.Check checked={prefs.tray} onChange={(event) => setPrefs({ ...prefs, tray: event.currentTarget.checked })}>
                Keep running in the notification area when the window closes
              </Companion.Check>
              <Companion.Check checked={prefs.watch} onChange={(event) => setPrefs({ ...prefs, watch: event.currentTarget.checked })}>
                Watch folders and scan them when something changes
              </Companion.Check>
              <Companion.Check checked={prefs.sync} onChange={(event) => setPrefs({ ...prefs, sync: event.currentTarget.checked })}>
                Sync with the hub when the companion starts
              </Companion.Check>
            </div>
          </div>
        </fieldset>
        <fieldset>
          <legend>Network</legend>
          <div className="pref">
            <label className="k top" htmlFor="sg-helper-port">
              Local helper port:
            </label>
            <div className="v">
              <span className="path">127.0.0.1&thinsp;:</span>
              <input className="field num" type="number" id="sg-helper-port" min={1024} max={65535} defaultValue={17342} />
              <span className="sub">The player on this PC talks to the companion here. It is running.</span>
            </div>
            <span className="k top">Helper token:</span>
            <div className="v">
              <Companion.Push>Show</Companion.Push>
              <span className="sub">For a player this PC doesn’t serve. It is shown here only, and never written to a log.</span>
            </div>
          </div>
          <p className="note">The helper listens on this PC only. Other devices reach this PC through Remote.</p>
        </fieldset>
      </Sect>
      <div className="panefoot">
        <p className="note" role="status">
          Settings are kept on this PC.
        </p>
        <Companion.Push>Restore Defaults</Companion.Push>
      </div>
    </CompanionWindow>
  );
}

/** Asks the companion kit's real confirmation sheet as soon as the screen is drawn. */
function CompanionAsk({ request }: { request: Companion.ConfirmRequest }) {
  const confirm = Companion.useConfirm();
  useEffect(() => {
    void confirm(request);
  }, [confirm, request]);
  return null;
}

const COMPANION_REMOVE: Companion.ConfirmRequest = {
  title: 'Stop using “Albums”?',
  detail: 'Your files aren’t touched. Only Airwave’s record of the folder is removed, and its songs leave the library.',
  action: 'Remove Folder',
  destructive: true,
};

/** The companion's sheet is a modal `<dialog>`; for a destructive action Cancel is the default (DEC-021). */
export function CompanionConfirmScreen() {
  return (
    <Companion.ConfirmProvider>
      <CompanionAsk request={COMPANION_REMOVE} />
      <CompanionWindow tab="library">
        <Sect label="Folders">
          <fieldset>
            <legend>Saved Music</legend>
            <Companion.Rows label="Music folders">
              <FolderRow path="D:\Music\Albums" state="6,204 songs" music />
            </Companion.Rows>
            <div className="barrow">
              <Companion.Push>Add Folder…</Companion.Push>
            </div>
          </fieldset>
        </Sect>
      </CompanionWindow>
    </Companion.ConfirmProvider>
  );
}

/* ====================================================================== kit */

/**
 * The kit, piece by piece, on the window's own body colour: what the Elements chapter shows under
 * "The Airwave window". Drawn with the hub's kit; the companion's writes the same classes.
 */
export function AirwaveKitSpecimen() {
  const [checked, setChecked] = useState(true);
  return (
    <div className="frame">
      <main className="win" aria-label="Airwave window kit">
        <div className="chrome">
          <h1 className="titlebar">The Airwave window</h1>
          <div className="toolbar" role="tablist" aria-label="Sections">
            {HUB_TABS.slice(0, 4).map((item, index) => (
              <button key={item.id} type="button" className={`tool${index === 3 ? ' locked' : ''}`} role="tab" aria-selected={index === 0} aria-disabled={index === 3 || undefined} tabIndex={index === 0 ? 0 : -1}>
                {TAB_ICONS[item.id]}
                {index === 3 ? 'Locked' : item.label}
                {index === 1 ? (
                  <span className="gear-badge" aria-hidden="true">
                    2
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
        <div className="pane-host">
          <div className="pane-body">
            <div className="pane">
              <p className="lead">The lead: one sentence about the tab, under the chrome that carries the title and the tools.</p>
              <Hub.Group title="Push buttons, fields, pop-ups and checkboxes" hint="Drawn by AquaArt and worn through border-image: an ordinary button, the default one, a disabled one; the 10.4 pop-up and checkbox.">
                <div className="barrow">
                  <Hub.Push>Push</Hub.Push>
                  <Hub.Push primary>Default</Hub.Push>
                  <Hub.Push disabled reason="Why it is disabled, said on hover.">
                    Disabled
                  </Hub.Push>
                  <Hub.Field aria-label="A field" placeholder="A field" defaultValue="" />
                  <Hub.Pop aria-label="A pop-up" defaultValue="b">
                    <option value="a">Lossless</option>
                    <option value="b">High · 256 kbps</option>
                  </Hub.Pop>
                  <button type="button" className="rm" aria-label="Remove" title="Remove">
                    –
                  </button>
                </div>
                <div className="barrow">
                  <Hub.Check checked={checked} onChange={setChecked}>
                    A checkbox, with its label
                  </Hub.Check>
                  <Hub.Check checked={false} onChange={noop} disabled>
                    Disabled
                  </Hub.Check>
                </div>
                <Hub.Note>A note: one quiet sentence under the control it is about.</Hub.Note>
                <Hub.Note bad>A failed action says what to do, in the same place.</Hub.Note>
              </Hub.Group>
              <Hub.Group title="Lists" hint="Every list is a bezelled well. Rows carry a status lamp, a name, a quiet meta line and their actions; an empty list is one sentence inside the well.">
                <div className="split">
                  <div className="well">
                    <ul className="rows" aria-label="Rows">
                      <li>
                        <Hub.Sdot kind="ok" />
                        <span className="name">
                          <b>Working</b>
                        </span>
                        <span className="meta">sdot--ok</span>
                      </li>
                      <li>
                        <Hub.Sdot kind="warn" />
                        <span className="name">
                          <b>Limited</b>
                        </span>
                        <span className="meta">sdot--warn</span>
                      </li>
                      <li>
                        <Hub.Sdot kind="bad" />
                        <span className="name">
                          <b>Needs setting up</b>
                        </span>
                        <span className="meta">sdot--bad</span>
                      </li>
                      <li>
                        <Hub.Sdot kind="busy" />
                        <span className="name">
                          <b>Setting up…</b>
                        </span>
                        <span className="meta">sdot--busy</span>
                      </li>
                      <li>
                        <Hub.Sdot kind="off" />
                        <span className="name">
                          <b>Off</b>
                        </span>
                        <span className="meta">sdot</span>
                      </li>
                    </ul>
                  </div>
                  <div>
                    <div className="well">
                      <ul className="rows" aria-label="An empty list">
                        <Hub.EmptyRow text="Nothing here yet — and what to do about it." />
                      </ul>
                    </div>
                    <div className="lcd" role="status" style={{ marginTop: 10 }}>
                      <span className="lcd__code">482 916</span>
                      <span className="lcd__sub">The LCD plate: a code, and what to do with it</span>
                    </div>
                  </div>
                </div>
              </Hub.Group>
              <Hub.Group title="Figures" last>
                <div className="tiles">
                  <Tile heading="Tile" dot="ok" big="3 paired" small="2 online now" />
                  <div className="tile">
                    <h3>Progress</h3>
                    <div className="bar" role="progressbar" aria-label="Progress, 60%" aria-valuemin={0} aria-valuemax={100} aria-valuenow={60} style={{ margin: '8px 0 6px' }}>
                      <i style={{ width: '60%' }} />
                    </div>
                    <span className="sm">A bar, with its words beside it</span>
                  </div>
                  <div className="tile">
                    <h3>Capability chips</h3>
                    <span className="caps">
                      <Cap label="Search" level="yes" />
                      <Cap label="Stream" level="part" />
                      <Cap label="Download" level="no" />
                    </span>
                  </div>
                </div>
              </Hub.Group>
            </div>
          </div>
        </div>
        <div className="status">
          <span className="dot" aria-hidden="true" />
          <span role="status">The status strip: what the window is connected to</span>
          <span className="spacer" />
          <span>and its counts</span>
        </div>
      </main>
    </div>
  );
}
