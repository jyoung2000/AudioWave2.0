/**
 * The page skin's own furniture, drawn with its own classes.
 *
 * The music list, the search popover, the context menu, the New Playlist sheet, the toast and the
 * equalizer window are styled by `now-playing.css` but assembled by the player, not by a component
 * in this package — so the styleguide renders their markup here, against the real stylesheet, and
 * holds them still with a few overrides in `styleguide.css` (a sheet is `position: fixed` in the
 * app; on a specimen bed it has to sit where it is put).
 */
import type { CSSProperties } from 'react';
import { Checkbox, PopUpMenu, Slider, Button } from '../src/index.js';

const NOTE = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M19.6 3 9.8 5.2a1 1 0 0 0-.8 1v9.7a3.1 3.1 0 1 0 1.6 2.7V9.6l7.6-1.7v5.6a3.1 3.1 0 1 0 1.6 2.7V3.8a.8.8 0 0 0-1-.8z" />
  </svg>
);

const STAR = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5 6.1 20.6l1.2-6.5L2.5 9.5l6.6-.9z" />
  </svg>
);

const DL = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M10.8 3h2.4v7.7h4.1L12 17.1 6.7 10.7h4.1z" />
    <path d="M4.6 19h14.8v2.1H4.6z" />
  </svg>
);

interface ListRow {
  n: number;
  title: string;
  artist: string;
  time: string;
  bpm: string;
  album: string;
  source: string;
  offline?: boolean;
  starred?: boolean;
  playing?: boolean;
  selected?: boolean;
}

const LIST_ROWS: ListRow[] = [
  { n: 1, title: 'Lantern Road', artist: 'Marlow & the Tidewater', time: '3:24', bpm: '118', album: 'Quiet Arithmetic', source: 'L', offline: true, starred: true },
  { n: 2, title: 'Copper Meridian', artist: 'Orbital Cartographers', time: '5:05', bpm: '—', album: 'Copper Meridian', source: 'H' },
  { n: 3, title: 'Quiet Arithmetic', artist: 'Marlow & the Tidewater', time: '3:51', bpm: '96', album: 'Quiet Arithmetic', source: 'L', offline: true, playing: true },
  { n: 4, title: 'Long Wave', artist: 'Fennel Grove', time: '5:16', bpm: '122', album: 'Long Wave Sessions, Vol. 2', source: 'YT', selected: true },
  { n: 5, title: 'Pier 9 (Live)', artist: 'Cassette Bloom', time: '4:11', bpm: '—', album: 'Live from Pier 9', source: 'SC' },
];

/** The iTunes 10 list: nine columns, 18 px rows, the stripe, no rules, the sorted column tinted. */
export function MusicListSpecimen() {
  return (
    <div className="library is-scrolling" style={{ width: '100%' }}>
      <div className="library__scroll" style={{ maxHeight: 'none' }}>
        <table aria-label="Library">
          <colgroup>
            <col style={{ width: 34 }} />
            <col style={{ width: 38 }} />
            <col />
            <col className="lib-col-artist" style={{ width: '22%' }} />
            <col style={{ width: 54 }} />
            <col className="lib-col-bpm" style={{ width: 48 }} />
            <col style={{ width: 40 }} />
            <col style={{ width: 40 }} />
            <col className="lib-col-album" style={{ width: '26%' }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="lib-idx" aria-label="Track number">#</th>
              <th scope="col" className="lib-icon" aria-label="Source">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 9h-3a15.5 15.5 0 0 0-1.3-5.4A8 8 0 0 1 18.9 11zM12 4.1c.9 1.1 1.7 3.4 2 6.9h-4c.3-3.5 1.1-5.8 2-6.9zM5.1 11a8 8 0 0 1 4.3-5.4A15.5 15.5 0 0 0 8.1 11h-3zm0 2h3c.2 2.1.6 3.9 1.3 5.4A8 8 0 0 1 5.1 13zM12 19.9c-.9-1.1-1.7-3.4-2-6.9h4c-.3 3.5-1.1 5.8-2 6.9zm2.6-.5c.7-1.5 1.1-3.3 1.3-5.4h3a8 8 0 0 1-4.3 5.4z" /></svg>
              </th>
              <th scope="col" data-sort="title" aria-sort="ascending" role="columnheader">Song<span className="lib-sort" aria-hidden="true">▲</span></th>
              <th scope="col" className="lib-col-artist" data-sort="artist" role="columnheader">Artist</th>
              <th scope="col" className="lib-num" data-sort="duration" role="columnheader">Time</th>
              <th scope="col" className="lib-num lib-col-bpm" data-sort="bpm" role="columnheader">BPM</th>
              <th scope="col" className="lib-icon" aria-label="Offline">{DL}</th>
              <th scope="col" className="lib-icon" aria-label="Star">{STAR}</th>
              <th scope="col" className="lib-col-album" data-sort="album" role="columnheader">Album</th>
            </tr>
          </thead>
          <tbody>
            {LIST_ROWS.map((row) => (
              <tr key={row.n} aria-selected={Boolean(row.selected)} tabIndex={-1} className={row.playing ? 'is-playing' : undefined} aria-current={row.playing ? 'true' : undefined}>
                <td className="lib-idx">
                  {row.playing ? (
                    <svg className="lib-np" viewBox="0 0 12 12" role="img" aria-label="Now playing">
                      <path d="M1 4h2.4L6 1.6v8.8L3.4 8H1z" />
                      <path d="M8 3.6a3 3 0 0 1 0 4.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  ) : (
                    row.n
                  )}
                </td>
                <td className="lib-icon"><span className="lib-pf" data-len={row.source.length} title={row.source}>{row.source}</span></td>
                <td className="lib-title">{row.title}</td>
                <td className="lib-col-artist">{row.artist}</td>
                <td className="lib-num">{row.time}</td>
                <td className="lib-num lib-col-bpm">{row.bpm}</td>
                <td className="lib-icon"><button className="lib-btn lib-dl" type="button" aria-pressed={Boolean(row.offline)} aria-label={row.offline ? 'Available offline' : 'Not available offline'}>{DL}</button></td>
                <td className="lib-icon"><button className="lib-btn lib-star" type="button" aria-pressed={Boolean(row.starred)} aria-label={`Star ${row.title}`}>{STAR}</button></td>
                <td className="lib-col-album">{row.album}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="library__bar" aria-hidden="true">
        <div className="library__thumb" style={{ top: 4, height: 46 }} />
      </div>
    </div>
  );
}

/** The iTunes 11 results popover: count and Clear, 40 px rows with an audition tile, a pager. */
export function SearchPopoverSpecimen() {
  const rows = [
    { id: 'a', title: 'Lantern Road', sub: 'Marlow & the Tidewater — Quiet Arithmetic', time: '3:24', bpm: '118 bpm', pf: 'L', hot: false, preview: true },
    { id: 'b', title: 'Long Wave', sub: 'Fennel Grove — Long Wave Sessions, Vol. 2', time: '5:16', bpm: '122 bpm', pf: 'YT', hot: true, preview: false },
    { id: 'c', title: 'Copper Meridian', sub: 'Orbital Cartographers', time: '5:05', bpm: '—', pf: 'H', hot: false, preview: false },
  ];
  return (
    <div className="srch">
      <div className="srch__head">
        <p className="srch__count">3 matches for “la”</p>
        <button className="srch__clear" type="button">Clear</button>
      </div>
      <div className="srch__body" role="listbox" aria-label="Search results">
        {rows.map((row) => (
          <div key={row.id} className={['srch__row', row.hot && 'is-hot'].filter(Boolean).join(' ')} role="option" aria-selected={row.hot} tabIndex={-1}>
            <button className={['srch__art', row.preview && 'is-preview'].filter(Boolean).join(' ')} type="button" aria-pressed={row.preview} aria-label={row.preview ? `Stop auditioning ${row.title}` : `Audition ${row.title}, 15 seconds`} style={row.preview ? ({ ['--p' as string]: '0.42' } as CSSProperties) : undefined}>
              {NOTE}
              <span className="srch__scrim">
                <svg viewBox="0 0 30 30" aria-hidden="true" focusable="false">
                  <circle className="srch__ring" cx="15" cy="15" r="13.5" />
                  <circle className="srch__ring srch__ring--on" cx="15" cy="15" r="13.5" style={{ strokeDasharray: 84.82 }} />
                  <path className="srch__glyph srch__play" d="M12 10.5 19 15l-7 4.5z" />
                  <rect className="srch__glyph srch__stop" x="11.5" y="11.5" width="7" height="7" rx="1" />
                </svg>
              </span>
            </button>
            <span className="srch__meta">
              <span className="srch__title">{row.title}</span>
              <span className="srch__sub">{row.sub}</span>
            </span>
            <span className="srch__nums">
              <span className="srch__time">{row.time}</span>
              <span className="srch__bpm">{row.bpm}</span>
            </span>
            <span className="srch__links">
              <span className="srch__pf" data-len={row.pf.length} title={row.pf}>{row.pf}</span>
            </span>
            <span className="srch__go" aria-hidden="true">›</span>
          </div>
        ))}
      </div>
      <div className="srch__foot">
        <button className="srch__page" type="button" tabIndex={-1} aria-label="Previous page" disabled>‹</button>
        <span className="srch__dots" aria-hidden="true"><i className="is-on" /><i /><i /></span>
        <button className="srch__page" type="button" tabIndex={-1} aria-label="Next page">›</button>
      </div>
      <p className="srch__live" role="status">3 results. Use the arrows to move, Return to play.</p>
    </div>
  );
}

/** The desktop context menu, open, with its playlist submenu out. */
export function ContextMenuSpecimen() {
  return (
    <div className="ctx" role="menu" aria-label="Song actions" tabIndex={-1}>
      <div className="ctx__item ctx__item--parent is-open" role="menuitem" tabIndex={0} aria-haspopup="menu" aria-expanded="true">
        Add to Playlist<span className="ctx__chev" aria-hidden="true">›</span>
        <div className="ctx__sub" role="menu" aria-label="Playlists">
          <button className="ctx__item" type="button" role="menuitemcheckbox" aria-checked="true"><span className="ctx__check" aria-hidden="true">✓</span>Road Trip</button>
          <button className="ctx__item" type="button" role="menuitemcheckbox" aria-checked="false"><span className="ctx__check" aria-hidden="true" />Late Nights</button>
          <div className="ctx__sep" role="separator" />
          <button className="ctx__item" type="button" role="menuitem">New Playlist…</button>
        </div>
      </div>
      <button className="ctx__item" type="button" role="menuitem">New Playlist…</button>
    </div>
  );
}

/** The New Playlist sheet, held open. */
export function SheetSpecimen() {
  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sg-sheet-title">
        <div className="sheet__body">
          <p className="sheet__title" id="sg-sheet-title">New Playlist</p>
          <p className="sheet__msg">Enter a name. “Lantern Road” goes in it.</p>
          <input className="sheet__input" type="text" placeholder="Playlist" maxLength={60} autoComplete="off" aria-label="Playlist name" defaultValue="Road Trip" />
        </div>
        <div className="sheet__actions">
          <button className="sheet__btn" type="button">Cancel</button>
          <button className="sheet__btn" type="button">Create</button>
        </div>
      </div>
    </div>
  );
}

export function ToastSpecimen() {
  return (
    <div className="toast is-on" role="status">
      Added to “Road Trip”
    </div>
  );
}

const BANDS: Array<{ hz: number; label: string; gain: number; used: boolean }> = [
  { hz: 32, label: '32', gain: 0, used: false },
  { hz: 64, label: '64', gain: 0, used: false },
  { hz: 125, label: '125', gain: 0, used: false },
  { hz: 250, label: '250', gain: 0, used: false },
  { hz: 500, label: '500', gain: 0, used: false },
  { hz: 741, label: '741', gain: 6, used: true },
  { hz: 1000, label: '1K', gain: 0, used: false },
  { hz: 2000, label: '2K', gain: 0, used: false },
  { hz: 4000, label: '4K', gain: 0, used: false },
  { hz: 8000, label: '8K', gain: 0, used: false },
  { hz: 16000, label: '16K', gain: 0, used: false },
];

/** The iTunes equalizer window, showing a one-band preset so the greyed rail is visible. */
export function EqualizerSpecimen() {
  return (
    <div className="eqw">
      <div className="eqw__head">
        <Checkbox checked readOnly>On</Checkbox>
        <PopUpMenu label="Preset" hideLabel value="sol" onChange={() => undefined} options={[{ value: 'flat', label: 'Flat (built in)' }, { value: 'bass', label: 'Bass Lift (built in)' }, { value: 'sol', label: '741 Hz (SOL) (built in)' }]} />
      </div>
      <div className="eqw__bank" role="group" aria-label="Equalizer bands">
        <div className="eqw__scale" aria-hidden="true">
          <span>+12 dB</span>
          <span>0 dB</span>
          <span>−12 dB</span>
        </div>
        <div className="eqw__band eqw__band--preamp">
          <Slider label="Preamp" orientation="vertical" min={-12} max={12} step={0.5} value={-3} onChange={() => undefined} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`} />
          <span className="eqw__label">Preamp</span>
        </div>
        {BANDS.map((band) => (
          <div key={band.hz} className={['eqw__band', band.used ? null : 'eqw__band--unused'].filter(Boolean).join(' ')} title={band.used ? undefined : `741 Hz (SOL) does not use the ${band.label} band.`}>
            <Slider label={band.used ? `${band.hz} Hz band` : `${band.hz} Hz band, not used by 741 Hz (SOL)`} orientation="vertical" min={-12} max={12} step={0.5} value={band.gain} disabled={!band.used} onChange={() => undefined} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`} />
            <span className="eqw__label">{band.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The strip under the hero in shared mode: who is here, and what the hub last said. */
export function ShareStripSpecimen() {
  return (
    <div className="np-share-strip">
      <div className="np-share-strip__who">
        <span className="np-share-strip__name">Friday Listening Club</span>
        {[
          { name: 'Jalon', online: true },
          { name: 'Ash', online: true },
          { name: 'Rowan', online: false },
        ].map((member) => (
          <span key={member.name} className="np-share-strip__member" data-online={member.online ? 'true' : 'false'}>
            <span className="np-share-strip__dot" aria-hidden="true" />
            {member.name}
          </span>
        ))}
      </div>
      <p className="np-share-strip__note">The hub keeps the queue; your player follows it. Proposals go to the hub and come back accepted or refused.</p>
    </div>
  );
}

/** A section's head, its toolbar row, and the page's status line. */
export function PageFurnitureSpecimen() {
  return (
    <div style={{ width: '100%' }}>
      <div className="np-section-head">
        <h2>Music</h2>
        <p>412 tracks indexed from folders on this device</p>
      </div>
      <div className="np-toolbar-row">
        <Button size="small" icon="play">Play all</Button>
        <Button size="small" icon="shuffle">Shuffle all</Button>
        <Button size="small" icon="add" ellipsis>Add a folder</Button>
        <Button size="small" ellipsis>Choose files</Button>
      </div>
      <div className="np-foot">
        <output aria-live="polite">412 tracks · 6 queued · playing from this device</output>
        <span className="np-foot__right">
          <span>Flat</span>
          <span>0:23 / 3:24</span>
        </span>
      </div>
    </div>
  );
}
