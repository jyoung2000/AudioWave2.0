import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AquaProvider, AquaWindow, Toolbar, TrafficLights, Transport, TransportAuxButton, LcdDisplay, Scrubber, VolumeSlider, SearchField, ResultsPopover, SourceList, WorkArea, Content, BottomBar,
  SegmentedControl, Button, IconButton, Checkbox, Radio, TextField, PopUpMenu, Slider, ProgressBar, AquaTable, NowPlayingGlyph, ArtworkGrid, Tabs, Sheet, Menu, useContextMenu, ToastProvider, useToast,
  StatePanel, UnavailableCapabilityState, Panel, PanelSection, FormRow, KeyValueList, Marquee, Avatar, AvatarButton, SourceBadge, Glyph, SourceIcon, GLYPH_NAMES, SOURCE_ICONS, AVATAR_ICON_IDS, AvatarIcon,
  type AquaProfile, type MenuEntry, type ColumnDef,
} from '../src/index.js';

const params = new URLSearchParams(location.search);
const only = params.get('component');
const widthParam = params.get('width');
const reduced = params.get('reduced') === '1';
const inactive = params.get('inactive') === '1';
const profile = (params.get('profile') as AquaProfile | null) ?? 'snow-leopard-itunes-9';
const LONG = 'Ein außerordentlich langer Titel mit Umlauten und einem Untertitel — Deluxe Edition (2011 Remaster) [Live at the Harbour]';

interface Row { id: string; n: number; title: string; artist: string; album: string; time: string; genre: string }
const rows: Row[] = Array.from({ length: Number(params.get('rows') ?? 40) }, (_, i) => ({ id: `r${i}`, n: i + 1, title: i === 3 ? LONG : `Track ${i + 1}`, artist: ['Fennel Grove', 'Cassette Bloom', 'Orbital Cartographers', 'Marlow & the Tidewater'][i % 4]!, album: ['Long Wave Sessions', 'Live from Pier 9', 'Copper Meridian', 'Quiet Arithmetic'][i % 4]!, time: `${3 + (i % 4)}:${String((i * 7) % 60).padStart(2, '0')}`, genre: ['Ambient', 'Indie', 'Electronic', 'Folk'][i % 4]! }));

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  if (only && only !== id && only !== 'all') return null;
  return (
    <section data-gallery={id} style={{ marginBottom: 24 }}>
      <h2 style={{ color: '#fff', font: '700 13px/1.2 "Lucida Grande", sans-serif', margin: '0 0 8px', textShadow: '0 1px 0 rgba(0,0,0,.5)' }}>{title}</h2>
      <div style={{ display: 'grid', gap: 12 }}>{children}</div>
    </section>
  );
}

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="aqua-root" style={{ display: 'grid', gap: 6, padding: 12, background: '#ececec', border: '1px solid #747474', borderRadius: 5 }}>
      <div className="aqua-secondary">{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>{children}</div>
    </div>
  );
}

function ShellDemo() {
  const [selected, setSelected] = useState('songs');
  const [playing, setPlaying] = useState(true);
  const [position, setPosition] = useState(23_000);
  const [mode, setMode] = useState<'solo' | 'group'>('solo');
  const [query, setQuery] = useState('');
  const [starred, setStarred] = useState(false);
  const [sort, setSort] = useState<{ columnId: string; direction: 'ascending' | 'descending' } | null>({ columnId: 'title', direction: 'ascending' });
  const [volume, setVolume] = useState(0.72);
  const columns: ColumnDef<Row>[] = [
    { id: 'status', header: '', headerLabel: 'Status', width: 24, align: 'center', cell: (r) => (r.id === 'r1' ? <NowPlayingGlyph /> : null) },
    { id: 'n', header: '#', headerLabel: 'Number', width: 36, align: 'right', cell: (r) => r.n },
    { id: 'title', header: 'Name', sortable: true, primary: true, cell: (r) => <Marquee active={r.id === 'r1'} title={r.title}><span className="aqua-table__primary">{r.title}</span></Marquee> },
    { id: 'time', header: 'Time', sortable: true, width: 60, align: 'right', cell: (r) => r.time, stackText: (r) => r.time },
    { id: 'artist', header: 'Artist', sortable: true, cell: (r) => r.artist, stackText: (r) => r.artist },
    { id: 'album', header: 'Album', sortable: true, cell: (r) => r.album },
    { id: 'genre', header: 'Genre', sortable: true, width: 90, cell: (r) => r.genre },
  ];
  const groups = [
    { id: 'library', label: 'Library', items: [{ id: 'library', label: 'Library', icon: <SourceIcon name="library" />, count: 1240 }, { id: 'songs', label: 'Songs', icon: <SourceIcon name="songs" /> }, { id: 'albums', label: 'Albums', icon: <SourceIcon name="albums" /> }, { id: 'artists', label: 'Artists', icon: <SourceIcon name="artists" /> }, { id: 'genres', label: 'Genres', icon: <SourceIcon name="genres" /> }] },
    { id: 'playlists', label: 'Playlists', items: [{ id: 'queue', label: 'Solo Queue', icon: <SourceIcon name="queue" />, count: 12 }, { id: 'starred', label: 'Starred Songs', icon: <SourceIcon name="starred" /> }, { id: 'roadtrip', label: 'Road Trip', icon: <SourceIcon name="playlists" /> }] },
    { id: 'connected', label: 'Connected', items: [{ id: 'groups', label: 'Groups', icon: <SourceIcon name="groups" />, status: 'no hub connected', disabled: true }, { id: 'devices', label: 'Devices', icon: <SourceIcon name="devices" /> }, { id: 'settings', label: 'Settings', icon: <SourceIcon name="settings" /> }] },
  ];
  return (
    <AquaWindow title="Now Playing" active={!inactive} style={{ width: widthParam ? Number(widthParam) : '100%', height: 560 }}>
      <Toolbar
        windowControls={<TrafficLights onClose={() => undefined} onMinimize={() => undefined} onZoom={() => undefined} />}
        transport={
          <Transport
            playing={playing}
            onPlayPause={() => setPlaying((p) => !p)}
            onPrevious={() => setPosition(0)}
            onNext={() => setPosition(0)}
            shuffle={false}
            onShuffle={() => undefined}
            repeat="off"
            onRepeat={() => undefined}
            leading={<TransportAuxButton label={starred ? 'Remove from Starred Songs' : 'Star: add to Starred Songs'} pressed={starred} onClick={() => setStarred((s) => !s)}><Glyph name={starred ? 'star-filled' : 'star'} /></TransportAuxButton>}
            trailing={<><TransportAuxButton label="Add to Playlist" menu><Glyph name="playlist-add" /></TransportAuxButton><TransportAuxButton label="Share"><Glyph name="share" /></TransportAuxButton></>}
          />
        }
        display={<LcdDisplay title="Midnight Set, Side B" detail="Fennel Grove — Long Wave Sessions, Vol. 2" channel={<Scrubber compact positionMs={position} durationMs={178_000} onSeek={setPosition} />} />}
        secondary={<><SegmentedControl label="Listening mode" value={mode} onChange={setMode} segments={[{ value: 'solo', label: 'Solo listening', icon: <Glyph name="solo" /> }, { value: 'group', label: 'Group listening', icon: <Glyph name="group" /> }]} /><VolumeSlider value={volume} onChange={setVolume} onToggleMute={() => setVolume(0)} /><AvatarButton source={{ kind: 'builtin', iconId: 'headphones' }} label="Your profile" /></>}
        search={<SearchField value={query} onChange={setQuery} shortcut />}
      />
      <WorkArea sidebar={<SourceList groups={groups} selectedId={selected} onSelect={setSelected} />} currentSourceName={groups.flatMap((g) => g.items).find((i) => i.id === selected)?.label ?? 'Songs'}>
        <Content>
          <AquaTable columns={columns} rows={rows} rowKey={(r) => r.id} label="Songs" sort={sort} onSortChange={(c, d) => setSort({ columnId: c, direction: d })} currentKey="r1" height="100%" />
        </Content>
        <BottomBar left={<><IconButton variant="plain" icon="add" label="New playlist" /><IconButton variant="plain" icon="shuffle" label="Shuffle" pressed={false} /></>} status={`${rows.length} songs, 2.6 hours, 245 MB`} right={<IconButton variant="plain" icon="eq" label="Equalizer" />} />
      </WorkArea>
    </AquaWindow>
  );
}

function ControlsDemo() {
  const [checked, setChecked] = useState(true);
  const [slider, setSlider] = useState(4);
  const [seg, setSeg] = useState('list');
  return (
    <>
      <Card label="Buttons: neutral / default / graphite / destructive / busy / disabled / small / mini / ellipsis">
        <Button>Cancel</Button>
        <Button variant="default">Save</Button>
        <Button variant="graphite">Graphite</Button>
        <Button variant="destructive" icon="warning">Delete Playlist</Button>
        <Button busy>Importing</Button>
        <Button disabled>Disabled</Button>
        <Button size="small">Small</Button>
        <Button size="mini">Mini</Button>
        <Button ellipsis>Export</Button>
        <Button pressed>Pressed</Button>
      </Card>
      <Card label="Icon buttons: framed / plain / capsule / pressed / menu / disabled / large">
        <IconButton icon="gear" label="Settings" />
        <IconButton icon="star" label="Star" variant="plain" />
        <IconButton icon="share" label="Share" variant="capsule" />
        <IconButton icon="repeat" label="Repeat" pressed />
        <IconButton icon="playlist-add" label="Add to Playlist" menu expanded={false} />
        <IconButton icon="download" label="Download" disabled />
        <IconButton icon="car" label="Car mode" size="large" />
      </Card>
      <Card label="Checkbox / radio / text field / validation / pop-up">
        <Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)}>Show explicit content</Checkbox>
        <Checkbox indeterminate readOnly>Some folders</Checkbox>
        <Checkbox disabled>Disabled</Checkbox>
        <Radio name="r" defaultChecked>Ask each time</Radio>
        <Radio name="r">Windows only</Radio>
        <TextField label="Display name" defaultValue="Jalon" hint="Shown to group members" />
        <TextField label="Reference tuning" defaultValue="528" validation={{ kind: 'error', message: 'Reference must be between 400 and 480 Hz' }} />
        <TextField label="Disabled" disabled defaultValue="—" />
        <PopUpMenu label="Default format" options={[{ value: 'original', label: 'Original' }, { value: 'flac', label: 'FLAC' }, { value: 'mp3', label: 'MP3 (lossy)' }]} />
      </Card>
      <Card label="Sliders / progress / segmented / tabs">
        <Slider label="1 kHz" value={slider} min={-12} max={12} step={0.5} onChange={setSlider} editable unit=" dB" />
        <Slider label="Disabled" value={0} min={-12} max={12} onChange={() => undefined} disabled />
        <div style={{ width: 260 }}><ProgressBar value={42} label="Importing 18 of 94 songs…" /></div>
        <div style={{ width: 260 }}><ProgressBar label="Syncing artwork…" /></div>
        <div style={{ width: 260 }}><ProgressBar value={60} paused label="Paused" /></div>
        <SegmentedControl label="View" value={seg} onChange={setSeg} segments={[{ value: 'list', label: 'List', showLabel: true }, { value: 'grid', label: 'Grid', showLabel: true }, { value: 'artist', label: 'Artist', showLabel: true, disabled: true }]} />
        <SegmentedControl label="Mode" value={seg === 'grid' ? 'group' : 'solo'} onChange={() => undefined} tint="aqua" shape="capsule" segments={[{ value: 'solo', label: 'Solo', icon: <Glyph name="solo" /> }, { value: 'group', label: 'Group', icon: <Glyph name="group" /> }]} />
        <Tabs label="Scope" scope scopeLabel="Search:" value="all" onChange={() => undefined} tabs={[{ id: 'all', label: 'All' }, { id: 'local', label: 'Local', count: 12 }, { id: 'connected', label: 'Connected', disabled: true }]} />
      </Card>
    </>
  );
}

function OverlaysDemo() {
  const [open, setOpen] = useState(params.get('state') === 'open');
  const [alert, setAlert] = useState(false);
  const menu = useContextMenu();
  const toast = useToast();
  const btn = useRef<HTMLButtonElement | null>(null);
  const entries: MenuEntry[] = [
    { kind: 'heading', id: 'h', label: 'Song' },
    { kind: 'item', id: 'play', label: 'Play', shortcut: '↩', onSelect: () => toast.show('Playing') },
    { kind: 'item', id: 'next', label: 'Play Next', onSelect: () => undefined },
    { kind: 'submenu', id: 'pl', label: 'Add to Playlist', items: [{ kind: 'checkbox', id: 'rt', label: 'Road Trip', checked: true, onToggle: () => undefined }, { kind: 'item', id: 'new', label: 'New Playlist…', onSelect: () => setOpen(true) }] },
    { kind: 'separator', id: 's1' },
    { kind: 'item', id: 'share', label: 'Share…', onSelect: () => undefined },
    { kind: 'item', id: 'rm', label: 'Remove from Library', destructive: true, onSelect: () => undefined },
    { kind: 'item', id: 'dl', label: 'Download', disabled: true, onSelect: () => undefined },
  ];
  return (
    <Card label="Sheet / dialog / menu / toast">
      <Button onClick={() => setOpen(true)} ellipsis>New Playlist</Button>
      <Button onClick={() => setAlert(true)} ellipsis>Show Alert</Button>
      <Button ref={btn} onClick={() => menu.openAt(btn.current!)} aria-haspopup="menu" aria-expanded={menu.open}>Open Menu</Button>
      <Button onClick={() => toast.show('Added to “Road Trip”', { kind: 'success' })}>Toast</Button>
      <Button onClick={() => toast.show('Couldn’t reach the hub', { kind: 'error', action: { label: 'Retry', onSelect: () => undefined } })}>Error toast</Button>
      <Sheet open={open} title="New Playlist" message="Enter a name for this playlist." onCancel={() => setOpen(false)} actions={[{ id: 'cancel', label: 'Cancel', onSelect: () => setOpen(false) }, { id: 'create', label: 'Create', variant: 'default', onSelect: () => setOpen(false) }]}>
        <TextField label="Name" defaultValue="Playlist" />
      </Sheet>
      <Sheet open={alert} standalone icon="warning" title="Remove “Road Trip”?" message="The playlist will be removed. Songs stay in your library." onCancel={() => setAlert(false)} leftActions={[{ id: 'rm', label: 'Remove', variant: 'destructive', onSelect: () => setAlert(false) }]} actions={[{ id: 'c', label: 'Cancel', variant: 'default', onSelect: () => setAlert(false) }]} />
      <Menu open={menu.open} anchor={menu.anchor} onClose={menu.close} entries={entries} label="Song actions" returnFocusTo={menu.returnFocusTo} />
    </Card>
  );
}

function StatesDemo() {
  return (
    <>
      <Card label="States">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8, width: '100%', background: '#fff' }}>
          <StatePanel kind="empty" title="No songs yet" text="Add a music folder to start your library." actions={[{ id: 'add', label: 'Add Music Folder…', variant: 'default', onSelect: () => undefined }]} />
          <StatePanel kind="loading" title="Indexing" text="Reading tags in the background; playback keeps working." progress={{ value: 37, label: 'Indexing 370 of 1,000 files…' }} actions={[{ id: 'cancel', label: 'Cancel', onSelect: () => undefined }]} />
          <StatePanel kind="partial" title="Some sources did not respond" text="SoundCloud timed out. Showing results from the local library and YouTube." />
          <StatePanel kind="offline" title="You’re offline" text="Local music keeps playing. Connected features resume when the hub is reachable." />
          <StatePanel kind="error" title="Couldn’t play this song" text="The file could not be decoded." details={{ summary: 'Details', text: 'MEDIA_ERR_SRC_NOT_SUPPORTED — audio/x-ape is not decodable in this browser.' }} actions={[{ id: 'skip', label: 'Skip', onSelect: () => undefined }]} />
          <StatePanel kind="permission" title="Reconnect Folder" text="This browser needs permission again to read “Music”." actions={[{ id: 'rc', label: 'Reconnect Folder', variant: 'default', onSelect: () => undefined }, { id: 'rm', label: 'Remove', onSelect: () => undefined }]} />
          <StatePanel kind="incompatible" title="Upgrade required" text="This hub speaks protocol 3; this player supports up to 1. Nothing was changed." />
          <UnavailableCapabilityState title="Download unavailable" text="YouTube does not permit audio downloads." reason="The provider does not permit this — YouTube API Services Terms prohibit downloading audio." />
        </div>
      </Card>
      <Card label="Inline state + status dots + panel/form rows">
        <div style={{ width: '100%', background: '#fff' }}>
          <StatePanel inline kind="warning" title="EQ unavailable for this source" text="Embedded YouTube audio is not exposed to Web Audio, so the equalizer is bypassed." />
        </div>
        <Panel title="Audio">
          <PanelSection title="Retune">
            <FormRow label="Reference tuning"><PopUpMenu label="Reference tuning" hideLabel options={[{ value: '440', label: '440 Hz (standard)' }, { value: '432', label: '432 Hz' }]} /></FormRow>
            <FormRow label="Mode"><Radio name="m" defaultChecked>Preserve tempo</Radio><Radio name="m">Linked speed</Radio></FormRow>
            <KeyValueList items={[{ key: 'Cents', value: '−31.77' }, { key: 'Ratio', value: '0.98182' }, { key: 'Latency', value: '43 ms' }]} />
          </PanelSection>
        </Panel>
      </Card>
    </>
  );
}

function ResultsDemo() {
  const [active, setActive] = useState(0);
  return (
    <Card label="Search results popover (static) and artwork grid">
      <div style={{ position: 'relative', width: 380 }}>
        <ResultsPopover static id="gallery-results" state="partial" total={3} activeIndex={active} onActivate={setActive} onHoverIndex={setActive} onClear={() => undefined} partialNotes={['SoundCloud did not respond']}
          rows={[
            { id: 'a', title: 'Copper Meridian', subtitle: 'Orbital Cartographers — Copper Meridian', duration: '5:05', provider: 'local', onPreview: () => undefined, actions: [{ id: 'play', label: 'Play', icon: 'play', enabled: true, onSelect: () => undefined }, { id: 'dl', label: 'Download', icon: 'download', enabled: true, onSelect: () => undefined }] },
            { id: 'b', title: 'Copper Meridian (Radio Edit)', subtitle: 'Orbital Cartographers · YouTube', duration: '3:00', provider: 'youtube', providerUrl: 'https://www.youtube.com/', actions: [{ id: 'play', label: 'Play', icon: 'play', enabled: true, onSelect: () => undefined }, { id: 'dl', label: 'Download', icon: 'download', enabled: false, why: 'YouTube does not permit audio downloads', onSelect: () => undefined }] },
            { id: 'c', title: LONG, subtitle: 'Cassette Bloom · SoundCloud', duration: '4:11', provider: 'soundcloud', note: 'sign in required', actions: [{ id: 'play', label: 'Play', icon: 'play', enabled: false, why: 'Sign in to SoundCloud on the hub', onSelect: () => undefined }] },
          ]}
          page={{ index: 0, count: 3, onPrev: () => undefined, onNext: () => undefined }}
        />
      </div>
      <div style={{ width: 420, background: '#fff' }}>
        <ArtworkGrid label="Albums" tiles={[{ id: '1', title: 'Long Wave Sessions', subtitle: 'Fennel Grove' }, { id: '2', title: LONG, subtitle: 'Cassette Bloom' }, { id: '3', title: 'Copper Meridian', subtitle: 'Orbital Cartographers' }]} selectedId="1" onPlay={() => undefined} tileSize={110} />
      </div>
    </Card>
  );
}

function IconsDemo() {
  return (
    <Card label="Icon families: source (16px colour), glyphs (single colour), avatars">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 16 }}>{(Object.keys(SOURCE_ICONS) as Array<keyof typeof SOURCE_ICONS>).map((n) => <span key={n} title={n}><SourceIcon name={n} title={n} /></span>)}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 14, color: '#1c1c1c' }}>{GLYPH_NAMES.map((n) => <Glyph key={n} name={n} title={n} />)}</div>
      <div style={{ display: 'flex', gap: 6 }}>{AVATAR_ICON_IDS.map((id) => <Avatar key={id} source={{ kind: 'builtin', iconId: id }} size={28} alt={id} />)}<AvatarIcon id="vinyl" width={0} height={0} style={{ display: 'none' }} /></div>
      <div style={{ display: 'flex', gap: 6 }}>{['local', 'hub', 'youtube', 'soundcloud', 'bandcamp', 'spotify', 'musicbrainz', 'public-domain'].map((p) => <SourceBadge key={p} provider={p} />)}</div>
    </Card>
  );
}

export function Gallery() {
  const width = useMemo(() => (widthParam ? Number(widthParam) : undefined), []);
  return (
    <AquaProvider profile={profile} active={!inactive} reducedMotion={reduced || undefined}>
      <ToastProvider>
        <div style={{ maxWidth: width ?? 1180, margin: '0 auto' }}>
          <Section id="shell" title="Application shell (window, toolbar, source list, table, bottom bar)"><ShellDemo /></Section>
          <Section id="controls" title="Controls"><ControlsDemo /></Section>
          <Section id="overlays" title="Overlays"><OverlaysDemo /></Section>
          <Section id="states" title="States"><StatesDemo /></Section>
          <Section id="results" title="Results & grid"><ResultsDemo /></Section>
          <Section id="icons" title="Icons"><IconsDemo /></Section>
        </div>
      </ToastProvider>
    </AquaProvider>
  );
}
