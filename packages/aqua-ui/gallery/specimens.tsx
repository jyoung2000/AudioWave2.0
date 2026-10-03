/**
 * The specimens: every component, exercised with real content.
 *
 * Shared by the gallery (which exists to look at one thing at a time) and the styleguide (which
 * exists to explain the system and is built from these same specimens so it cannot describe one
 * thing and show another). Nothing here reads the URL or the document — whatever a host wants to
 * vary, it passes in.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Track, type Track as TrackRow } from '@now-playing/contracts';
import {
  SegmentedControl, Button, ButtonLink, IconButton, Checkbox, TextField, PopUpMenu, Slider, ProgressBar, AquaTable, Sheet, useToast,
  EmptyState, LoadingState, StatusDot, Panel, PanelSection, KeyValueList, SourceBadge, ProviderMark, PROVIDER_MARKS, Glyph, GLYPH_NAMES,
  PageBar, BarSearch, BarClock, ModeSwitch, ProfileButton, SectionStrip, Hero, HeroArt, TrackScrubber, KeyTransport, KeyButton, LevelSlider, JewelStage, MusicList,
  type ColumnDef,
} from '../src/index.js';

export const LONG = 'Ein außerordentlich langer Titel mit Umlauten und einem Untertitel — Deluxe Edition (2011 Remaster) [Live at the Harbour]';

export interface Row { id: string; n: number; title: string; artist: string; album: string; time: string; genre: string }

export function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: `r${i}`, n: i + 1, title: i === 3 ? LONG : `Track ${i + 1}`, artist: ['Fennel Grove', 'Cassette Bloom', 'Orbital Cartographers', 'Marlow & the Tidewater'][i % 4]!, album: ['Long Wave Sessions', 'Live from Pier 9', 'Copper Meridian', 'Quiet Arithmetic'][i % 4]!, time: `${3 + (i % 4)}:${String((i * 7) % 60).padStart(2, '0')}`, genre: ['Ambient', 'Indie', 'Electronic', 'Folk'][i % 4]! }));
}

const DEVICE = '0192a7c1-2b3d-7e4f-8a9b-00000000d0d0';
const HUB = '0192a7c1-2b3d-7e4f-8a9b-00000000a0a0';
const STAMP = '2026-09-05T12:00:00.000Z';

/**
 * Tracks for the page skin's list, run through the contract's own parser.
 *
 * A hand-built object would satisfy the type and still lie — a badge that says "L" because the
 * demo typed "L", not because the locator is a file on this device. These carry real locators of
 * each kind, so the source badge, the offline column and the star are read from the same fields the
 * player reads them from.
 */
export function makeTracks(): TrackRow[] {
  const seed: Array<Partial<TrackRow> & { title: string; artistName: string; id: string }> = [
    { id: '0192a7c1-2b3d-7e4f-8a9b-000000000001', title: 'Lantern Road', artistName: 'Marlow & the Tidewater', albumName: 'Quiet Arithmetic', durationMs: 204_000, bpm: 118, liked: true, locators: [{ kind: 'browser-handle', deviceId: DEVICE, handleId: 'h1' }] },
    { id: '0192a7c1-2b3d-7e4f-8a9b-000000000002', title: 'Copper Meridian', artistName: 'Orbital Cartographers', albumName: 'Copper Meridian', durationMs: 305_000, locators: [{ kind: 'hub-blob', hubId: HUB, blobId: 'b2' }] },
    { id: '0192a7c1-2b3d-7e4f-8a9b-000000000003', title: 'Quiet Arithmetic', artistName: 'Marlow & the Tidewater', albumName: 'Quiet Arithmetic', durationMs: 231_000, bpm: 96, locators: [{ kind: 'browser-handle', deviceId: DEVICE, handleId: 'h3' }] },
    { id: '0192a7c1-2b3d-7e4f-8a9b-000000000004', title: 'Long Wave', artistName: 'Fennel Grove', albumName: 'Long Wave Sessions, Vol. 2', durationMs: 316_000, bpm: 122, locators: [{ kind: 'provider', provider: 'youtube', providerTrackId: 'yt-4', canonicalUrl: 'https://www.youtube.com/watch?v=4' }] },
    { id: '0192a7c1-2b3d-7e4f-8a9b-000000000005', title: 'Pier 9 (Live)', artistName: 'Cassette Bloom', albumName: 'Live from Pier 9', durationMs: 251_000, locators: [{ kind: 'provider', provider: 'soundcloud', providerTrackId: 'sc-5' }] },
    { id: '0192a7c1-2b3d-7e4f-8a9b-000000000006', title: LONG, artistName: 'Cassette Bloom', albumName: 'Live from Pier 9', durationMs: 381_000, bpm: 104, locators: [{ kind: 'browser-handle', deviceId: DEVICE, handleId: 'h6' }] },
    { id: '0192a7c1-2b3d-7e4f-8a9b-000000000007', title: 'Midnight Set, Side B', artistName: 'Fennel Grove', albumName: 'Long Wave Sessions, Vol. 2', durationMs: 178_000, bpm: 110, liked: true, locators: [{ kind: 'browser-handle', deviceId: DEVICE, handleId: 'h7' }] },
    { id: '0192a7c1-2b3d-7e4f-8a9b-000000000008', title: 'Harbour Lights', artistName: 'Orbital Cartographers', albumName: 'Copper Meridian', durationMs: 264_000, locators: [{ kind: 'hub-blob', hubId: HUB, blobId: 'b8' }] },
  ];
  return seed.map((row) => Track.parse({ createdAt: STAMP, updatedAt: STAMP, ...row }));
}

export function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="aqua-root" style={{ display: 'grid', gap: 6, padding: 12, background: '#ececec', border: '1px solid #747474', borderRadius: 5 }}>
      <div className="aqua-secondary">{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>{children}</div>
    </div>
  );
}

/** The library's sortable, virtualised table, as the player's Metrics view uses it. */
export function TableDemo({ rows }: { rows: Row[] }) {
  const [sort, setSort] = useState<{ columnId: string; direction: 'ascending' | 'descending' } | null>({ columnId: 'title', direction: 'ascending' });
  const columns: ColumnDef<Row>[] = [
    { id: 'n', header: '#', headerLabel: 'Number', width: 36, align: 'right', cell: (r) => r.n },
    { id: 'title', header: 'Name', sortable: true, primary: true, cell: (r) => r.title },
    { id: 'time', header: 'Time', sortable: true, width: 60, align: 'right', cell: (r) => r.time, stackText: (r) => r.time },
    { id: 'artist', header: 'Artist', sortable: true, cell: (r) => r.artist, stackText: (r) => r.artist },
    { id: 'album', header: 'Album', sortable: true, cell: (r) => r.album },
    { id: 'genre', header: 'Genre', sortable: true, width: 90, cell: (r) => r.genre },
  ];
  return (
    <Card label="Table: sortable, current row, virtualised past 200 rows">
      <div style={{ width: '100%', height: 320, background: '#fff' }}>
        <AquaTable columns={columns} rows={rows} rowKey={(r) => r.id} label="Songs" sort={sort} onSortChange={(c, d) => setSort({ columnId: c, direction: d })} currentKey="r1" height="100%" />
      </div>
    </Card>
  );
}

export function ControlsDemo() {
  const [checked, setChecked] = useState(true);
  const [slider, setSlider] = useState(4);
  const [seg, setSeg] = useState('list');
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
      <Card label="Checkbox / text field / validation / pop-up">
        <Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)}>Show explicit content</Checkbox>
        <Checkbox indeterminate readOnly>Some folders</Checkbox>
        <Checkbox disabled>Disabled</Checkbox>
        <TextField label="Display name" defaultValue="Jalon" hint="Shown to group members" />
        <TextField label="Reference tuning" defaultValue="528" validation={{ kind: 'error', message: 'Reference must be between 400 and 480 Hz' }} />
        <TextField label="Disabled" disabled defaultValue="—" />
        <PopUpMenu label="Default format" options={[{ value: 'original', label: 'Original' }, { value: 'flac', label: 'FLAC' }, { value: 'mp3', label: 'MP3 (lossy)' }]} />
      </Card>
      <Card label="Sliders / progress / segmented">
        <Slider label="1 kHz" value={slider} min={-12} max={12} step={0.5} onChange={setSlider} editable unit=" dB" />
        <Slider label="Disabled" value={0} min={-12} max={12} onChange={() => undefined} disabled />
        <div style={{ width: 260 }}><ProgressBar value={42} label="Importing 18 of 94 songs…" /></div>
        <div style={{ width: 260 }}><ProgressBar label="Syncing artwork…" /></div>
        <div style={{ width: 260 }}><ProgressBar value={60} paused label="Paused" /></div>
        <SegmentedControl label="View" value={seg} onChange={setSeg} segments={[{ value: 'list', label: 'List', showLabel: true }, { value: 'grid', label: 'Grid', showLabel: true }, { value: 'artist', label: 'Artist', showLabel: true, disabled: true }]} />
        <SegmentedControl label="Mode" value={seg === 'grid' ? 'group' : 'solo'} onChange={() => undefined} tint="aqua" shape="capsule" segments={[{ value: 'solo', label: 'Solo', icon: <Glyph name="solo" /> }, { value: 'group', label: 'Group', icon: <Glyph name="group" /> }]} />
      </Card>
    </>
  );
}

export function OverlaysDemo({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [alert, setAlert] = useState(false);
  const toast = useToast();
  return (
    <Card label="Sheet / alert / toast">
      <Button onClick={() => setOpen(true)} ellipsis>New Playlist</Button>
      <Button onClick={() => setAlert(true)} ellipsis>Show Alert</Button>
      <Button onClick={() => toast.show('Added to “Road Trip”', { kind: 'success' })}>Toast</Button>
      <Button onClick={() => toast.show('Couldn’t reach the hub', { kind: 'error', action: { label: 'Retry', onSelect: () => undefined } })}>Error toast</Button>
      <Sheet open={open} title="New Playlist" message="Enter a name for this playlist." onCancel={() => setOpen(false)} actions={[{ id: 'cancel', label: 'Cancel', onSelect: () => setOpen(false) }, { id: 'create', label: 'Create', variant: 'default', onSelect: () => setOpen(false) }]}>
        <TextField label="Name" defaultValue="Playlist" />
      </Sheet>
      <Sheet open={alert} standalone icon="warning" title="Remove “Road Trip”?" message="The playlist will be removed. Songs stay in your library." onCancel={() => setAlert(false)} leftActions={[{ id: 'rm', label: 'Remove', variant: 'destructive', onSelect: () => setAlert(false) }]} actions={[{ id: 'c', label: 'Cancel', variant: 'default', onSelect: () => setAlert(false) }]} />
    </Card>
  );
}

export function StatesDemo() {
  return (
    <>
      <Card label="States: empty / loading">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8, width: '100%', background: '#fff' }}>
          <EmptyState title="No songs yet" text="Add a music folder to start your library." actions={[{ id: 'add', label: 'Add Music Folder…', variant: 'default', onSelect: () => undefined }]} />
          <LoadingState title="Indexing" text="Reading tags in the background; playback keeps working." progress={{ value: 37, label: 'Indexing 370 of 1,000 files…' }} actions={[{ id: 'cancel', label: 'Cancel', onSelect: () => undefined }]} />
        </div>
      </Card>
      <Card label="Status dots + panel / key-value list">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <StatusDot kind="ok" label="Connected" />
          <StatusDot kind="warning" label="Hub is slow to answer" />
          <StatusDot kind="error" label="Offline" />
          <StatusDot kind="neutral" label="Not paired" />
        </div>
        <Panel title="Audio">
          <PanelSection title="Retune">
            <KeyValueList items={[{ key: 'Cents', value: '−31.77' }, { key: 'Ratio', value: '0.98182' }, { key: 'Latency', value: '43 ms' }]} />
          </PanelSection>
        </Panel>
      </Card>
    </>
  );
}

export function IconsDemo() {
  return (
    <Card label="Icon families: glyphs (single colour), platform marks">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 14, color: '#1c1c1c' }}>{GLYPH_NAMES.map((n) => <Glyph key={n} name={n} title={n} />)}</div>
      {/* every mark in the registry, plus an unknown slug to show the initials fallback */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{[...Object.keys(PROVIDER_MARKS), 'some-new-service'].map((p) => <SourceBadge key={p} provider={p} />)}</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 22 }}>{['youtube', 'soundcloud', 'spotify', 'bandcamp'].map((p) => <ProviderMark key={p} provider={p} title={p} />)}</div>
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
export function PageDemo() {
  const [mode, setMode] = useState('solo');
  const [section, setSection] = useState('library');
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState(23_000);
  const [volume, setVolume] = useState(0.72);
  const [playing, setPlaying] = useState(true);
  const [repeat, setRepeat] = useState(false);
  const [liked, setLiked] = useState(false);
  const [tracks, setTracks] = useState(makeTracks);
  const [playingId, setPlayingId] = useState<string>('0192a7c1-2b3d-7e4f-8a9b-000000000007');
  const stageRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();
  const current = tracks.find((t) => t.id === playingId) ?? tracks[0]!;
  const album = {
    title: current.title,
    artist: current.artistName,
    album: current.albumName,
    coverUrl: null,
    tracks: tracks.filter((t) => t.albumName === current.albumName).map((t) => t.title),
    mood: mode === 'shared' ? ('shared' as const) : ('solo' as const),
  };
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
          { id: 'library', label: 'Music Library', icon: <Glyph name="note" />, count: tracks.length },
          { id: 'queue', label: 'Queue', icon: <Glyph name="sort" />, count: 6 },
          { id: 'playlists', label: 'Playlists', icon: <Glyph name="folder" /> },
          { id: 'metrics', label: 'Listening history', icon: <Glyph name="history" /> },
        ]}
      />
      <Hero mode={mode === 'shared' ? 'shared' : 'solo'}>
        <div className="np-hero__top">
          <HeroArt stageRef={stageRef} />
          <div className="np-hero__meta">
            <h3 className="np-hero__title">{current.title}</h3>
            <p className="np-hero__artist">{current.artistName}</p>
            <p className="np-hero__album">{current.albumName}</p>
          </div>
        </div>
        <TrackScrubber positionMs={position} durationMs={current.durationMs} onSeek={setPosition} onTogglePlay={() => setPlaying((p) => !p)} live={mode === 'shared'} disabledReason={mode === 'shared' ? 'A shared broadcast has one position.' : undefined} />
        <KeyTransport volume={<LevelSlider value={volume} onChange={setVolume} onToggleMute={() => undefined} />}>
          <span className="np-keys__aux">
            <KeyButton aux label="Available offline" pressed onClick={() => undefined}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9.9 15.4 6.4 11.9l1.9-1.9 1.6 1.6 5.8-5.8 1.9 1.9z" /><path d="M4.6 19h14.8v2.1H4.6z" /></svg>
            </KeyButton>
            <KeyButton aux label={liked ? 'Remove from favourites' : 'Add to favourites'} pressed={liked} onClick={() => setLiked((l) => !l)}><Glyph name={liked ? 'star-filled' : 'star'} /></KeyButton>
            <KeyButton aux label="Shuffle" onClick={() => undefined}><Glyph name="shuffle" /></KeyButton>
            <KeyButton aux label="Discover: off" onClick={() => undefined}><Glyph name="discover" /></KeyButton>
          </span>
          <KeyButton glyph="previous" label="Previous track" onClick={() => undefined} />
          <KeyButton primary glyph={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Play'} pressed={playing} onClick={() => setPlaying((p) => !p)} />
          <KeyButton glyph="next" label="Next track" onClick={() => undefined} />
          <span className="np-keys__aux">
            <KeyButton aux glyph="repeat" label={repeat ? 'Repeat: all' : 'Repeat: off'} pressed={repeat} onClick={() => setRepeat((r) => !r)} />
            <KeyButton aux label="Add to a playlist" onClick={() => undefined}><Glyph name="add" /></KeyButton>
            <KeyButton aux label="Download this song" onClick={() => undefined}><Glyph name="download" /></KeyButton>
            <KeyButton aux label="Share this song" onClick={() => undefined}><Glyph name="share" /></KeyButton>
          </span>
        </KeyTransport>
        {/* The jewel case and the disc: the same module the player mounts, over the same flat cover. */}
        <JewelStage stageRef={stageRef} album={album} playing={playing} loadPose={async () => null} savePose={() => undefined} />
      </Hero>
      <div className="np-body">
        <div className="np-body__inner">
          <MusicList
            label="Your music"
            tracks={tracks}
            playingTrackId={playingId}
            onPlay={(track) => {
              setPlayingId(track.id);
              setPosition(0);
              setPlaying(true);
            }}
            onToggleStar={(track) => setTracks((all) => all.map((t) => (t.id === track.id ? { ...t, liked: !t.liked } : t)))}
            playlists={[]}
            playlistItems={[]}
            onTogglePlaylist={() => undefined}
            onNewPlaylist={() => toast.show('New Playlist… opens the sheet in the player')}
            onSay={(message) => toast.show(message)}
            ephemeralTrackIds={new Set()}
          />
        </div>
      </div>
    </div>
  );
}
