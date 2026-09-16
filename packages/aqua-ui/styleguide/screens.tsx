/**
 * Whole screens, for looking at rather than for reading about.
 *
 * Everything here is assembled from the same components and the same stylesheets the three products
 * import — `AquaWindow` here is the `AquaWindow` the hub renders, `MusicList` here is the one the
 * player renders. That is the sense in which these are 1:1, and it is the sense that survives: a
 * token change or a component fix lands in these screens the moment it lands in the products,
 * because there is nothing in between to keep in step.
 *
 * What these are *not* is each product's own view file executed verbatim. Those are wired to a
 * database, a playback engine and, in the companion's case, Electron's IPC, and dragging that into a
 * styleguide would buy a little more fidelity at the cost of a page that breaks whenever a store
 * does. The navigation, the panels and the furniture are taken from the real views; the data behind
 * them is fixture data, and the frames say so on screen so nobody mistakes one for the other.
 */
import { useState, type ReactNode } from 'react';
import {
  AquaTable,
  AquaWindow,
  BottomBar,
  Button,
  Checkbox,
  Content,
  EmptyState,
  Glyph,
  IconButton,
  KeyValueList,
  Panel,
  PanelSection,
  ProgressBar,
  SearchField,
  SourceBadge,
  SourceIcon,
  SourceList,
  StatusDot,
  TextField,
  Toolbar,
  TrafficLights,
  WorkArea,
  type ColumnDef,
} from '../src/index.js';
import { PageDemo, makeRows } from '../gallery/specimens.js';
/*
 * Each product's own stylesheet, as a string rather than as a page style.
 *
 * These carry the rules a component library cannot: what `body` looks like, how the app fills the
 * window, and the product-specific classes the real views use. Imported here so a frame can put them
 * inside itself, where they belong — loading them onto the styleguide's own page would give it the
 * player's background and, thanks to the companion, an unscrollable document.
 */
import playerCss from '../../../music-player/src/styles.css?inline';
import hubCss from '../../../docker-container/src/web/styles.css?inline';
import companionCss from '../../../windows-companion/src/renderer/styles.css?inline';

export type ProductId = 'player' | 'hub' | 'companion';

export const PRODUCT_CSS: Readonly<Record<ProductId, string>> = { player: playerCss, hub: hubCss, companion: companionCss };

export interface Screen {
  id: string;
  product: ProductId;
  label: string;
  /** What this screen is for, and what to look at when you resize it. */
  note: string;
  render: () => ReactNode;
}

export const PRODUCTS: Array<{ id: ProductId; label: string; skin: string; note: string }> = [
  { id: 'player', label: 'Music player', skin: 'Page skin', note: 'A web page, installed or not, from a 320px phone to a desktop window.' },
  { id: 'hub', label: 'Hub admin', skin: 'Window skin', note: 'Served by the container on port 4546 and opened in a browser — often, in practice, on a phone.' },
  { id: 'companion', label: 'Windows companion', skin: 'Window skin', note: 'An Electron window. It cannot be resized to a phone, but it is the same skin as the hub and shares its rules.' },
];

/* ------------------------------------------------------------------ window */

/** The shell the hub and the companion are both made of, minus the media toolbar the player uses. */
function WindowScreen({ title, groups, selected, onSelect, children, status, wide = false }: { title: string; groups: Parameters<typeof SourceList>[0]['groups']; selected: string; onSelect: (id: string) => void; children: ReactNode; status: string; wide?: boolean }) {
  const [query, setQuery] = useState('');
  const current = groups.flatMap((group) => group.items).find((item) => item.id === selected)?.label ?? title;
  return (
    // `flush` and nothing else, exactly as the hub and the companion render it: both mount into a
    // `#root` their own stylesheet gives the full height, and that stylesheet is inside the frame.
    <AquaWindow title={title} active flush>
      <Toolbar
        windowControls={<TrafficLights onClose={() => undefined} onMinimize={() => undefined} onZoom={() => undefined} />}
        secondary={wide ? <Button size="small">Check for updates</Button> : undefined}
        search={<SearchField value={query} onChange={setQuery} />}
      />
      <WorkArea sidebar={<SourceList groups={groups} selectedId={selected} onSelect={onSelect} />} currentSourceName={current}>
        <Content>{children}</Content>
        <BottomBar left={<IconButton variant="plain" icon="reconnect" label="Refresh" />} status={status} right={<IconButton variant="plain" icon="gear" label="Settings" />} />
      </WorkArea>
    </AquaWindow>
  );
}

/** The hub's own navigation, from docker-container/src/web/App.tsx. */
const HUB_GROUPS = [
  { id: 'status', label: 'Hub', items: [{ id: 'overview', label: 'Overview', icon: <Glyph name="info" /> }, { id: 'devices', label: 'Devices', icon: <Glyph name="device" />, count: 3 }, { id: 'groups', label: 'Groups', icon: <Glyph name="group" /> }] },
  {
    id: 'music',
    label: 'Music',
    items: [
      { id: 'library', label: 'Library', icon: <Glyph name="note" />, count: 1240 },
      { id: 'providers', label: 'Providers', icon: <Glyph name="cloud" /> },
      { id: 'downloads', label: 'Downloads', icon: <Glyph name="download" /> },
      { id: 'shares', label: 'Shared links', icon: <Glyph name="link" /> },
      { id: 'recommendations', label: 'Recommendations', icon: <Glyph name="star" /> },
    ],
  },
  { id: 'integrations', label: 'Integrations', items: [{ id: 'discord', label: 'Discord', icon: <Glyph name="share" />, status: 'not configured', disabled: true }] },
  { id: 'system', label: 'System', items: [{ id: 'network', label: 'Network', icon: <Glyph name="reconnect" /> }, { id: 'backup', label: 'Backup', icon: <Glyph name="folder" /> }, { id: 'diagnostics', label: 'Diagnostics', icon: <Glyph name="gear" /> }] },
];

/** The companion's own navigation, from windows-companion/src/renderer/App.tsx. */
const COMPANION_GROUPS = [
  { id: 'library', label: 'Library', items: [{ id: 'folders', label: 'Folders', icon: <Glyph name="folder" />, count: 4 }, { id: 'library', label: 'Music', icon: <Glyph name="note" />, count: 8412 }] },
  { id: 'hub', label: 'Hub', items: [{ id: 'hub', label: 'Connection', icon: <Glyph name="link" />, status: 'Living room' }, { id: 'transfers', label: 'Transfers', icon: <Glyph name="upload" /> }] },
  { id: 'system', label: 'This computer', items: [{ id: 'backup', label: 'Backup', icon: <Glyph name="download" /> }, { id: 'about', label: 'About', icon: <Glyph name="info" /> }] },
];

/* ------------------------------------------------------------------- hub */

function HubOverview() {
  return (
    <>
      <Panel title="This hub">
        <PanelSection>
          <KeyValueList
            items={[
              { key: 'Name', value: 'Living room' },
              { key: 'Address', value: 'https://living-room.local:4546' },
              { key: 'Version', value: '1.0.0' },
              { key: 'Library', value: '1,240 tracks · 96 albums · 42.1 GB' },
              { key: 'Uptime', value: '6 days, 4 hours' },
            ]}
          />
        </PanelSection>
      </Panel>
      <Panel title="Health">
        <PanelSection>
          <ul className="sg-stack">
            <li>
              <StatusDot kind="ok" label="Database" /> 42 MB, last backup 4 hours ago
            </li>
            <li>
              <StatusDot kind="ok" label="Storage" /> 310 GB free of 931 GB
            </li>
            <li>
              <StatusDot kind="warning" label="FFmpeg" /> present, but without the FLAC encoder
            </li>
            <li>
              <StatusDot kind="neutral" label="Discord" /> not configured
            </li>
          </ul>
        </PanelSection>
      </Panel>
    </>
  );
}

function HubProviders() {
  interface ProviderRow {
    id: string;
    name: string;
    state: string;
    tone: 'ok' | 'warning' | 'neutral';
    detail: string;
  }
  const rows: ProviderRow[] = [
    { id: 'local', name: 'Local library', state: 'Available', tone: 'ok', detail: 'Serving 1,240 tracks by byte range' },
    { id: 'musicbrainz', name: 'MusicBrainz', state: 'Available', tone: 'ok', detail: '1 request/second, 24 h cache' },
    { id: 'soundcloud', name: 'SoundCloud', state: 'Sign in', tone: 'warning', detail: 'App registered; no user has authorised yet' },
    { id: 'youtube', name: 'YouTube', state: 'Not configured', tone: 'neutral', detail: 'Needs an API key restricted to this hub' },
    { id: 'spotify', name: 'Spotify', state: 'Not configured', tone: 'neutral', detail: 'Development mode allows a fixed list of users' },
    { id: 'external-tool', name: 'External tool', state: 'Off', tone: 'neutral', detail: 'yt-dlp 2026.08.19 present — enable to use it' },
  ];
  return (
    <Panel title="Providers">
      <PanelSection>
        <p className="sg-note">Every action a result offers is rendered from the capability state below, never assumed. A stream URL never implies a download.</p>
        <AquaTable
          label="Providers"
          rows={rows}
          rowKey={(row) => row.id}
          columns={
            [
              { id: 'name', header: 'Provider', primary: true, cell: (row) => <span className="sg-inline"><SourceBadge provider={row.id} /> {row.name}</span>, stackText: (row) => row.detail },
              { id: 'state', header: 'State', width: 132, cell: (row) => <StatusDot kind={row.tone} label={row.state} /> },
              { id: 'detail', header: 'Detail', cell: (row) => row.detail },
            ] as ColumnDef<ProviderRow>[]
          }
        />
      </PanelSection>
    </Panel>
  );
}

function HubDownloads() {
  return (
    <>
      <Panel title="In progress">
        <PanelSection>
          <div className="sg-stack">
            <div>
              <strong>Long Wave Sessions, Vol. 2</strong> — converting to FLAC
              <ProgressBar value={72} label="Converting" />
            </div>
            <div>
              <strong>Quiet Arithmetic</strong> — waiting for the tool
              <ProgressBar label="Queued" />
            </div>
          </div>
        </PanelSection>
      </Panel>
      <Panel title="Rights">
        <PanelSection>
          <p className="sg-note">Each job records why the person who asked for it is entitled to the file. A job without one is refused before a process starts.</p>
          <KeyValueList
            items={[
              { key: 'Basis', value: 'Content I own' },
              { key: 'Requested by', value: 'Kitchen (device)' },
              { key: 'Host', value: 'archive.org' },
            ]}
          />
        </PanelSection>
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------- companion */

function CompanionFolders() {
  interface FolderRow {
    id: string;
    path: string;
    tracks: string;
    state: string;
    tone: 'ok' | 'warning';
  }
  const rows: FolderRow[] = [
    { id: 'a', path: 'D:\\Music\\Albums', tracks: '6,204', state: 'Watching', tone: 'ok' },
    { id: 'b', path: 'D:\\Music\\Live sets', tracks: '1,880', state: 'Watching', tone: 'ok' },
    { id: 'c', path: 'E:\\Archive\\Vinyl rips', tracks: '328', state: 'Drive not connected', tone: 'warning' },
    { id: 'd', path: 'C:\\Users\\You\\Music', tracks: '0', state: 'Empty', tone: 'ok' },
  ];
  return (
    <Panel title="Folders">
      <PanelSection>
        <p className="sg-note">The companion indexes where files already are. Nothing is copied or moved, and a folder that goes away is reported rather than quietly dropped.</p>
        <AquaTable
          label="Folders"
          rows={rows}
          rowKey={(row) => row.id}
          columns={
            [
              { id: 'path', header: 'Folder', primary: true, cell: (row) => row.path, stackText: (row) => `${row.tracks} tracks` },
              { id: 'tracks', header: 'Tracks', width: 90, align: 'right', cell: (row) => row.tracks },
              { id: 'state', header: 'State', width: 190, cell: (row) => <StatusDot kind={row.tone} label={row.state} /> },
            ] as ColumnDef<FolderRow>[]
          }
        />
        <div className="sg-row">
          <Button variant="default">Add a folder…</Button>
          <Button>Rescan</Button>
        </div>
      </PanelSection>
    </Panel>
  );
}

function CompanionTransfers() {
  return (
    <>
      <Panel title="To the hub">
        <PanelSection>
          <div className="sg-stack">
            <div>
              <strong>Midnight Set, Side B</strong> — sending to Living room
              <ProgressBar value={38} label="Sending" />
            </div>
          </div>
          <p className="sg-note">The hub verifies a SHA-256 before it accepts anything, so a transfer that arrives damaged is refused rather than filed.</p>
        </PanelSection>
      </Panel>
      <Panel title="Waiting for you">
        <PanelSection>
          <EmptyState title="Nothing to authorise" text="A hub can ask this computer for a file it holds. Requests appear here, and nothing leaves until you say so." inline />
        </PanelSection>
      </Panel>
    </>
  );
}

/* ---------------------------------------------------------------- player */

function PlayerSettings() {
  const [crossfade, setCrossfade] = useState(true);
  const [gapless, setGapless] = useState(true);
  return (
    <div className="np-app sg-screen-page">
      <div className="np-body">
        <div className="np-body__inner">
          <div className="np-section-head">
            <h2>Settings</h2>
            <p>What this app can do here, and what it cannot — with the reason in each case.</p>
          </div>
          <Panel title="Playback">
            <PanelSection>
              <Checkbox checked={crossfade} onChange={(event) => setCrossfade(event.currentTarget.checked)}>
                Crossfade songs
              </Checkbox>
              <Checkbox checked={gapless} onChange={(event) => setGapless(event.currentTarget.checked)}>
                Keep songs from the same album gapless
              </Checkbox>
            </PanelSection>
          </Panel>
          <Panel title="Platforms">
            <PanelSection>
              <p className="sg-note">Three questions, because the platforms answer them differently. Every “no” says whose rule it is.</p>
              <ul className="sg-platforms">
                {[
                  { id: 'local', name: 'This device', play: 'Yes', keep: 'Yes', save: 'Yes', tone: 'ok' as const },
                  { id: 'bandcamp', name: 'Bandcamp', play: 'No', keep: 'Sometimes', save: 'Sometimes', tone: 'warning' as const },
                  { id: 'youtube', name: 'YouTube', play: 'Sometimes', keep: 'No', save: 'No', tone: 'neutral' as const },
                  { id: 'spotify', name: 'Spotify', play: 'Sometimes', keep: 'No', save: 'No', tone: 'neutral' as const },
                ].map((row) => (
                  <li key={row.id}>
                    <span className="sg-platforms__head">
                      <SourceBadge provider={row.id} />
                      <strong>{row.name}</strong>
                    </span>
                    <span className="sg-platforms__routes">
                      <StatusDot kind={row.tone} label={`Play here: ${row.play}`} />
                      <StatusDot kind={row.tone} label={`Keep offline: ${row.keep}`} />
                      <StatusDot kind={row.tone} label={`Save a file: ${row.save}`} />
                    </span>
                  </li>
                ))}
              </ul>
            </PanelSection>
          </Panel>
          <Panel title="Hub">
            <PanelSection>
              <TextField label="Hub address" value="https://living-room.local:4546" onChange={() => undefined} />
              <div className="sg-row">
                <Button variant="default">Pair</Button>
                <Button>Forget</Button>
              </div>
            </PanelSection>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- screens */

const rows = makeRows(18);

export const SCREENS: readonly Screen[] = [
  {
    id: 'player-now-playing',
    product: 'player',
    label: 'Now playing and library',
    note: 'The whole page skin at once. Narrow it and watch the list drop its number and artist columns and put the artist under the title instead.',
    render: () => <PageDemo />,
  },
  {
    id: 'player-settings',
    product: 'player',
    label: 'Settings',
    note: 'Where most of the app’s explaining happens, so it is the screen where text size and wrapping matter most.',
    render: () => <PlayerSettings />,
  },
  {
    id: 'hub-overview',
    product: 'hub',
    label: 'Overview',
    note: 'The window skin with a source list. Below about 700px the sidebar gives way and the current source is named in the toolbar instead.',
    render: () => <HubScreen initial="overview" />,
  },
  {
    id: 'hub-providers',
    product: 'hub',
    label: 'Providers',
    note: 'A table inside a window. On a phone the table stacks rather than scrolling sideways.',
    render: () => <HubScreen initial="providers" />,
  },
  {
    id: 'hub-downloads',
    product: 'hub',
    label: 'Downloads',
    note: 'Progress and a rights basis. Both are text that has to stay readable when the window is half its width.',
    render: () => <HubScreen initial="downloads" />,
  },
  {
    id: 'companion-folders',
    product: 'companion',
    label: 'Folders',
    note: 'The same window skin the hub uses, on a desktop where it is never narrow — which is exactly why it is worth checking that it still holds up when it is.',
    render: () => <CompanionScreen initial="folders" />,
  },
  {
    id: 'companion-transfers',
    product: 'companion',
    label: 'Transfers',
    note: 'Progress, and an empty state that has to say something useful rather than apologise.',
    render: () => <CompanionScreen initial="transfers" />,
  },
];

function HubScreen({ initial }: { initial: string }) {
  const [selected, setSelected] = useState(initial);
  const content = selected === 'providers' ? <HubProviders /> : selected === 'downloads' ? <HubDownloads /> : <HubOverview />;
  return (
    <WindowScreen title="Now Playing Hub" groups={HUB_GROUPS} selected={selected} onSelect={setSelected} status="1,240 tracks · 3 devices paired" wide>
      {content}
    </WindowScreen>
  );
}

function CompanionScreen({ initial }: { initial: string }) {
  const [selected, setSelected] = useState(initial);
  const content =
    selected === 'transfers' ? (
      <CompanionTransfers />
    ) : selected === 'library' ? (
      <AquaTable label="Music" rows={rows} rowKey={(row) => row.id} columns={[{ id: 'title', header: 'Name', primary: true, cell: (row) => row.title, stackText: (row) => row.artist }, { id: 'artist', header: 'Artist', cell: (row) => row.artist }, { id: 'album', header: 'Album', cell: (row) => row.album }] as ColumnDef<(typeof rows)[number]>[]} />
    ) : (
      <CompanionFolders />
    );
  return (
    <WindowScreen title="Now Playing Companion" groups={COMPANION_GROUPS} selected={selected} onSelect={setSelected} status="8,412 tracks · paired with Living room">
      {content}
    </WindowScreen>
  );
}

export { SourceIcon };
