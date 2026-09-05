/**
 * The specimens: every component, exercised with real content.
 *
 * Shared by the gallery (which exists to look at one thing at a time) and the styleguide (which
 * exists to explain the system and is built from these same specimens so it cannot describe one
 * thing and show another). Nothing here reads the URL or the document — whatever a host wants to
 * vary, it passes in.
 */
import { useRef, useState, type ReactNode } from 'react';
import {
  AquaWindow, Toolbar, TrafficLights, Transport, TransportAuxButton, LcdDisplay, Scrubber, VolumeSlider, SearchField, ResultsPopover, SourceList, WorkArea, Content, BottomBar,
  SegmentedControl, Button, ButtonLink, IconButton, Checkbox, Radio, TextField, PopUpMenu, Slider, ProgressBar, AquaTable, NowPlayingGlyph, ArtworkGrid, Tabs, Sheet, Menu, useContextMenu, useToast,
  StatePanel, UnavailableCapabilityState, Panel, PanelSection, FormRow, KeyValueList, ListView, Splitter, Marquee, Avatar, AvatarButton, SourceBadge, Glyph, SourceIcon, GLYPH_NAMES, SOURCE_ICONS, AVATAR_ICON_IDS, AvatarIcon,
  PageBar, BarSearch, BarClock, ModeSwitch, ProfileButton, SectionStrip, Hero, HeroArt, TrackScrubber, KeyTransport, KeyButton, LevelSlider,
  type MenuEntry, type ColumnDef,
} from '../src/index.js';

export const LONG = 'Ein außerordentlich langer Titel mit Umlauten und einem Untertitel — Deluxe Edition (2011 Remaster) [Live at the Harbour]';

export interface Row { id: string; n: number; title: string; artist: string; album: string; time: string; genre: string }

export function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: `r${i}`, n: i + 1, title: i === 3 ? LONG : `Track ${i + 1}`, artist: ['Fennel Grove', 'Cassette Bloom', 'Orbital Cartographers', 'Marlow & the Tidewater'][i % 4]!, album: ['Long Wave Sessions', 'Live from Pier 9', 'Copper Meridian', 'Quiet Arithmetic'][i % 4]!, time: `${3 + (i % 4)}:${String((i * 7) % 60).padStart(2, '0')}`, genre: ['Ambient', 'Indie', 'Electronic', 'Folk'][i % 4]! }));
}

export function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="aqua-root" style={{ display: 'grid', gap: 6, padding: 12, background: '#ececec', border: '1px solid #747474', borderRadius: 5 }}>
      <div className="aqua-secondary">{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>{children}</div>
    </div>
  );
}

export interface ShellDemoProps {
  rows: Row[];
  width?: number | undefined;
  inactive?: boolean;
}

/** The window the hub's admin GUI and the Windows companion are built from. */
export function ShellDemo({ rows, width, inactive = false }: ShellDemoProps) {
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
    <AquaWindow title="Now Playing" active={!inactive} style={{ width: width ?? '100%', height: 560 }}>
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

export function ControlsDemo() {
  const [checked, setChecked] = useState(true);
  const [slider, setSlider] = useState(4);
  const [seg, setSeg] = useState('list');
  const [split, setSplit] = useState(196);
  return (
    <>
      <Card label="Buttons: neutral / default / graphite / destructive / busy / disabled / small / mini / ellipsis / link">
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
        <ButtonLink size="small" icon="download" href="#download" download="NowPlaying-Setup.exe">Download · 84 MB</ButtonLink>
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
      <Card label="Sliders / progress / segmented / tabs / splitter">
        <Slider label="1 kHz" value={slider} min={-12} max={12} step={0.5} onChange={setSlider} editable unit=" dB" />
        <Slider label="Disabled" value={0} min={-12} max={12} onChange={() => undefined} disabled />
        <div style={{ width: 260 }}><ProgressBar value={42} label="Importing 18 of 94 songs…" /></div>
        <div style={{ width: 260 }}><ProgressBar label="Syncing artwork…" /></div>
        <div style={{ width: 260 }}><ProgressBar value={60} paused label="Paused" /></div>
        <SegmentedControl label="View" value={seg} onChange={setSeg} segments={[{ value: 'list', label: 'List', showLabel: true }, { value: 'grid', label: 'Grid', showLabel: true }, { value: 'artist', label: 'Artist', showLabel: true, disabled: true }]} />
        <SegmentedControl label="Mode" value={seg === 'grid' ? 'group' : 'solo'} onChange={() => undefined} tint="aqua" shape="capsule" segments={[{ value: 'solo', label: 'Solo', icon: <Glyph name="solo" /> }, { value: 'group', label: 'Group', icon: <Glyph name="group" /> }]} />
        <Tabs label="Scope" scope scopeLabel="Search:" value="all" onChange={() => undefined} tabs={[{ id: 'all', label: 'All' }, { id: 'local', label: 'Local', count: 12 }, { id: 'connected', label: 'Connected', disabled: true }]} />
        <div style={{ display: 'flex', width: 320, height: 60, border: '1px solid #747474', background: '#fff' }}>
          <div style={{ width: split, background: '#dce8f4' }} />
          <Splitter value={split} min={160} max={280} onChange={setSplit} label="Sidebar width" />
          <div style={{ flex: 1 }} />
        </div>
      </Card>
    </>
  );
}

export function OverlaysDemo({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
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

export function StatesDemo() {
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
      <Card label="Inline state + status dots + panel / form rows / list view">
        <div style={{ width: '100%', background: '#fff' }}>
          <StatePanel inline kind="warning" title="EQ unavailable for this source" text="Embedded YouTube audio is not exposed to Web Audio, so the equalizer is bypassed." />
        </div>
        <Panel title="Audio">
          <PanelSection title="Retune">
            <FormRow label="Reference tuning"><PopUpMenu label="Reference tuning" hideLabel options={[{ value: '440', label: '440 Hz (standard)' }, { value: '432', label: '432 Hz' }]} /></FormRow>
            <FormRow label="Mode"><Radio name="m" defaultChecked>Preserve tempo</Radio><Radio name="m">Linked speed</Radio></FormRow>
            <KeyValueList items={[{ key: 'Cents', value: '−31.77' }, { key: 'Ratio', value: '0.98182' }, { key: 'Latency', value: '43 ms' }]} />
          </PanelSection>
          <PanelSection title="Devices">
            <ListView rows={[{ id: 'a', primary: 'Studio PC', secondary: 'Windows companion · last seen 2 min ago', trailing: <SourceBadge provider="local" /> }, { id: 'b', primary: 'Kitchen', secondary: 'Player · online', trailing: <SourceBadge provider="hub" /> }]} />
          </PanelSection>
        </Panel>
      </Card>
    </>
  );
}

export function ResultsDemo() {
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

export function IconsDemo() {
  return (
    <Card label="Icon families: source (16px colour), glyphs (single colour), avatars, source badges">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 16 }}>{(Object.keys(SOURCE_ICONS) as Array<keyof typeof SOURCE_ICONS>).map((n) => <span key={n} title={n}><SourceIcon name={n} title={n} /></span>)}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 14, color: '#1c1c1c' }}>{GLYPH_NAMES.map((n) => <Glyph key={n} name={n} title={n} />)}</div>
      <div style={{ display: 'flex', gap: 6 }}>{AVATAR_ICON_IDS.map((id) => <Avatar key={id} source={{ kind: 'builtin', iconId: id }} size={28} alt={id} />)}<AvatarIcon id="vinyl" width={0} height={0} style={{ display: 'none' }} /></div>
      <div style={{ display: 'flex', gap: 6 }}>{['local', 'hub', 'youtube', 'soundcloud', 'bandcamp', 'spotify', 'musicbrainz', 'public-domain'].map((p) => <SourceBadge key={p} provider={p} />)}</div>
    </Card>
  );
}

/**
 * The 2010 page: the arrangement the player uses, beside the window the hub uses.
 *
 * Both live here because both ship. Keeping them on one screen is also the only way to see that
 * they are the same design system — same light source, same rims, same restraint — rather than two
 * unrelated skins that happen to be in one repository.
 */
export function PageDemo({ rows }: { rows: Row[] }) {
  const [mode, setMode] = useState('solo');
  const [section, setSection] = useState('library');
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState(23_000);
  const [volume, setVolume] = useState(0.72);
  const [playing, setPlaying] = useState(true);
  const [repeat, setRepeat] = useState(false);
  const [liked, setLiked] = useState(false);
  return (
    <div className="np-app" style={{ minHeight: 0, border: '1px solid rgba(0,0,0,.3)', borderRadius: 6, overflow: 'hidden' }}>
      <PageBar
        label="Now Playing"
        search={<BarSearch label="Search your music" value={query} onChange={setQuery} placeholder="Search your music" />}
        status={
          <>
            <ModeSwitch
              value={mode}
              onChange={setMode}
              modes={[
                { id: 'solo', label: 'Solo listening' },
                { id: 'shared', label: 'Shared listening' },
              ]}
            />
            <BarClock />
            <ProfileButton label="Settings — listening on your own" />
          </>
        }
      />
      <SectionStrip
        selectedId={section}
        onSelect={setSection}
        items={[
          { id: 'library', label: 'Music Library', icon: <Glyph name="note" />, count: 412 },
          { id: 'queue', label: 'Queue', icon: <Glyph name="sort" />, count: 6 },
          { id: 'playlists', label: 'Playlists', icon: <Glyph name="folder" /> },
          { id: 'metrics', label: 'Listening history', icon: <Glyph name="history" /> },
        ]}
      />
      <Hero mode={mode === 'shared' ? 'shared' : 'solo'}>
        <div className="np-hero__top">
          <HeroArt />
          <div className="np-hero__meta">
            <h3 className="np-hero__title">Midnight Set, Side B</h3>
            <p className="np-hero__artist">Fennel Grove</p>
            <p className="np-hero__album">Long Wave Sessions, Vol. 2</p>
          </div>
        </div>
        <TrackScrubber positionMs={position} durationMs={178_000} onSeek={setPosition} onTogglePlay={() => setPlaying((p) => !p)} live={mode === 'shared'} disabledReason={mode === 'shared' ? 'A shared broadcast has one position.' : undefined} />
        <KeyTransport volume={<LevelSlider value={volume} onChange={setVolume} onToggleMute={() => undefined} />}>
          <span className="np-keys__aux">
            <KeyButton aux label="Available offline" pressed onClick={() => undefined}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9.9 15.4 6.4 11.9l1.9-1.9 1.6 1.6 5.8-5.8 1.9 1.9z" /><path d="M4.6 19h14.8v2.1H4.6z" /></svg>
            </KeyButton>
            <KeyButton aux label={liked ? 'Remove from favourites' : 'Add to favourites'} pressed={liked} onClick={() => setLiked((l) => !l)}><Glyph name={liked ? 'star-filled' : 'star'} /></KeyButton>
            <KeyButton aux label="Shuffle" onClick={() => undefined}><Glyph name="shuffle" /></KeyButton>
          </span>
          <KeyButton glyph="previous" label="Previous track" onClick={() => undefined} />
          <KeyButton primary glyph={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Play'} pressed={playing} onClick={() => setPlaying((p) => !p)} />
          <KeyButton glyph="next" label="Next track" onClick={() => undefined} />
          <span className="np-keys__aux">
            <KeyButton aux glyph="repeat" label={repeat ? 'Repeat: all' : 'Repeat: off'} pressed={repeat} onClick={() => setRepeat((r) => !r)} />
            <KeyButton aux label="Add to a playlist" onClick={() => undefined}><Glyph name="add" /></KeyButton>
            <KeyButton aux label="Share this song" onClick={() => undefined}><Glyph name="share" /></KeyButton>
          </span>
        </KeyTransport>
      </Hero>
      <div className="np-body">
        <AquaTable
          variant="page"
          label="Your music"
          height={180}
          rows={rows.slice(0, 12)}
          rowKey={(row: Row) => row.id}
          currentKey="r2"
          sort={{ columnId: 'title', direction: 'ascending' }}
          onSortChange={() => undefined}
          columns={[
            { id: 'n', header: '#', align: 'right', width: 34, cell: (row) => row.n },
            { id: 'title', header: 'Song', primary: true, sortable: true, cell: (row) => row.title, stackText: (row) => row.artist },
            { id: 'artist', header: 'Artist', sortable: true, cell: (row) => row.artist },
            { id: 'time', header: 'Time', align: 'right', width: 54, cell: (row) => row.time },
            { id: 'album', header: 'Album', sortable: true, cell: (row) => row.album },
          ]}
        />
      </div>
    </div>
  );
}
