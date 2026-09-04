import { svgProps, type IconProps } from './Icon.js';

/**
 * Source-list family: 16 px, one clear silhouette, one or two identifying colours, a common top light
 * (spec §9.21). Original artwork. Under the itunes-10 profile CSS applies a grayscale filter.
 */
const G = {
  blue: ['#8fd0ff', '#2f7fd0', '#1a4f8c'],
  green: ['#a6e28f', '#4e9d47', '#2f6a2b'],
  orange: ['#ffd27a', '#e6892b', '#9c5514'],
  purple: ['#d9b8ff', '#8a5bd6', '#5a338f'],
  red: ['#ff9c93', '#d64a44', '#8f2a26'],
  teal: ['#9be6e0', '#2f9c95', '#1d6560'],
  gray: ['#e6e8ea', '#8f979e', '#5a6168'],
  yellow: ['#fff0a3', '#e0b32e', '#8c6c10'],
} as const;

type Palette = (typeof G)[keyof typeof G];

function Base({ id, palette, children, ...props }: IconProps & { id: string; palette: Palette; children: React.ReactNode }) {
  const p = svgProps(props, 'source');
  return (
    <svg viewBox="0 0 16 16" {...p}>
      {props.title ? <title>{props.title}</title> : null}
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={palette[0]} />
          <stop offset="0.55" stopColor={palette[1]} />
          <stop offset="1" stopColor={palette[2]} />
        </linearGradient>
        <linearGradient id={`${id}-gloss`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {children}
    </svg>
  );
}

const rim = { stroke: 'rgba(0,0,0,0.45)', strokeWidth: 0.6 } as const;

export function LibraryIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-library" palette={G.blue}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="url(#np-src-library-body)" {...rim} />
      <rect x="2.5" y="4" width="11" height="4" rx="1" fill="url(#np-src-library-gloss)" />
      <path d="M4 6.5h8M4 8.5h8M4 10.5h5" stroke="#fff" strokeWidth="1" strokeLinecap="round" opacity="0.9" />
    </Base>
  );
}
export function SongsIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-songs" palette={G.purple}>
      <circle cx="8" cy="8" r="6.5" fill="url(#np-src-songs-body)" {...rim} />
      <ellipse cx="8" cy="5" rx="4.5" ry="2.2" fill="url(#np-src-songs-gloss)" />
      <path d="M10.6 4.2 7 5v5a1.6 1.6 0 1 0 1 1.5V7.2l2.6-.6z" fill="#fff" />
    </Base>
  );
}
export function AlbumsIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-albums" palette={G.gray}>
      <circle cx="8" cy="8" r="6.5" fill="url(#np-src-albums-body)" {...rim} />
      <circle cx="8" cy="8" r="4" fill="none" stroke="#fff" strokeWidth="0.6" opacity="0.7" />
      <circle cx="8" cy="8" r="1.6" fill="#f7f7f7" stroke="rgba(0,0,0,0.4)" strokeWidth="0.5" />
      <ellipse cx="8" cy="4.8" rx="4.5" ry="1.9" fill="url(#np-src-albums-gloss)" />
    </Base>
  );
}
export function ArtistsIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-artists" palette={G.orange}>
      <circle cx="8" cy="5.2" r="3" fill="url(#np-src-artists-body)" {...rim} />
      <path d="M2.5 14c0-3.3 2.5-5 5.5-5s5.5 1.7 5.5 5z" fill="url(#np-src-artists-body)" {...rim} />
      <ellipse cx="8" cy="4" rx="2" ry="1" fill="url(#np-src-artists-gloss)" />
    </Base>
  );
}
export function GenresIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-genres" palette={G.teal}>
      <path d="M2 4.5h12v8.5H2z" fill="url(#np-src-genres-body)" {...rim} />
      <path d="M2 4.5 4.5 2h7L14 4.5z" fill="#c8f0ec" stroke="rgba(0,0,0,0.45)" strokeWidth="0.6" />
      <path d="M4 7h3v4H4zm5 0h3v4H9z" fill="#fff" opacity="0.9" />
    </Base>
  );
}
export function PlaylistsIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-playlists" palette={G.blue}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="url(#np-src-playlists-body)" {...rim} />
      <rect x="3" y="3.5" width="10" height="4" rx="1" fill="url(#np-src-playlists-gloss)" />
      <path d="M4.5 6h5M4.5 8.5h7M4.5 11h4" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="11.5" cy="11" r="1.1" fill="#fff" />
    </Base>
  );
}
export function QueueIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-queue" palette={G.green}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="url(#np-src-queue-body)" {...rim} />
      <rect x="3" y="3.5" width="10" height="4" rx="1" fill="url(#np-src-queue-gloss)" />
      <path d="M5 6.5 8 8 5 9.5z" fill="#fff" />
      <path d="M9 7h3.5M9 9h3.5M5 11.5h7.5" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />
    </Base>
  );
}
export function DownloadsIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-downloads" palette={G.blue}>
      <circle cx="8" cy="8" r="6.5" fill="url(#np-src-downloads-body)" {...rim} />
      <ellipse cx="8" cy="5" rx="4.5" ry="2.2" fill="url(#np-src-downloads-gloss)" />
      <path d="M7.1 4.5h1.8v4h2L8 11.5 5.1 8.5h2z" fill="#fff" />
    </Base>
  );
}
export function HistoryIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-history" palette={G.gray}>
      <circle cx="8" cy="8" r="6.5" fill="url(#np-src-history-body)" {...rim} />
      <ellipse cx="8" cy="5" rx="4.5" ry="2.2" fill="url(#np-src-history-gloss)" />
      <path d="M8 4.5v4l2.6 1.6" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </Base>
  );
}
export function DiscoverIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-discover" palette={G.orange}>
      <circle cx="8" cy="8" r="6.5" fill="url(#np-src-discover-body)" {...rim} />
      <ellipse cx="8" cy="5" rx="4.5" ry="2.2" fill="url(#np-src-discover-gloss)" />
      <path d="M10.8 5.2 9.3 9.3 5.2 10.8l1.5-4.1z" fill="#fff" />
      <circle cx="8" cy="8" r="0.9" fill="#e6892b" />
    </Base>
  );
}
export function GroupsIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-groups" palette={G.purple}>
      <circle cx="5.2" cy="5.5" r="2.1" fill="url(#np-src-groups-body)" {...rim} />
      <circle cx="10.8" cy="5.5" r="2.1" fill="url(#np-src-groups-body)" {...rim} />
      <path d="M1.5 13c0-2.5 1.7-3.8 3.7-3.8S9 10.5 9 13zM7 13c0-2.5 1.7-3.8 3.7-3.8s3.8 1.3 3.8 3.8z" fill="url(#np-src-groups-body)" {...rim} />
    </Base>
  );
}
export function ConnectedLibrariesIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-connected" palette={G.teal}>
      <rect x="1.5" y="4" width="7" height="8" rx="1.2" fill="url(#np-src-connected-body)" {...rim} />
      <rect x="8.5" y="6" width="6" height="6" rx="1" fill="url(#np-src-connected-body)" {...rim} />
      <rect x="2.5" y="5" width="5" height="2.5" rx="0.8" fill="url(#np-src-connected-gloss)" />
      <path d="M5 13.5v1M11.5 13.5v1M3 14.5h10" stroke="#5a6168" strokeWidth="0.8" strokeLinecap="round" />
    </Base>
  );
}
export function DevicesIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-devices" palette={G.gray}>
      <rect x="4.5" y="1.5" width="7" height="13" rx="1.5" fill="url(#np-src-devices-body)" {...rim} />
      <rect x="5.5" y="3" width="5" height="7.5" rx="0.5" fill="#dfeeff" stroke="rgba(0,0,0,0.3)" strokeWidth="0.4" />
      <circle cx="8" cy="12.7" r="0.8" fill="#fff" />
    </Base>
  );
}
export function SettingsIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-settings" palette={G.gray}>
      <path d="M8 1.6l1.1 1.7 2-.4.6 1.9 1.9.6-.4 2L15 8l-1.7 1.1.4 2-1.9.6-.6 1.9-2-.4L8 14.4l-1.1-1.7-2 .4-.6-1.9-1.9-.6.4-2L1 8l1.7-1.1-.4-2 1.9-.6.6-1.9 2 .4z" fill="url(#np-src-settings-body)" {...rim} />
      <circle cx="8" cy="8" r="2.4" fill="#f4f4f4" stroke="rgba(0,0,0,0.4)" strokeWidth="0.6" />
    </Base>
  );
}
export function HubIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-hub" palette={G.blue}>
      <rect x="2" y="3" width="12" height="4" rx="1" fill="url(#np-src-hub-body)" {...rim} />
      <rect x="2" y="9" width="12" height="4" rx="1" fill="url(#np-src-hub-body)" {...rim} />
      <circle cx="11.5" cy="5" r="0.9" fill="#a6e28f" />
      <circle cx="11.5" cy="11" r="0.9" fill="#a6e28f" />
    </Base>
  );
}
export function CompanionIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-companion" palette={G.blue}>
      <rect x="1.5" y="3" width="13" height="8.5" rx="1.2" fill="url(#np-src-companion-body)" {...rim} />
      <rect x="2.5" y="4" width="11" height="3" rx="0.8" fill="url(#np-src-companion-gloss)" />
      <path d="M5 13.5h6M8 11.5v2" stroke="#5a6168" strokeWidth="1" strokeLinecap="round" />
    </Base>
  );
}
export function StarredIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-starred" palette={G.yellow}>
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .8 4.3L8 11.5l-3.9 2.1.8-4.3-3.1-3 4.3-.6z" fill="url(#np-src-starred-body)" {...rim} />
      <path d="M8 3.6l1.2 2.5 2.7.4-2 1.9" fill="none" stroke="#fff" strokeWidth="0.7" opacity="0.7" />
    </Base>
  );
}
export function SharesIcon(p: IconProps) {
  return (
    <Base {...p} id="np-src-shares" palette={G.green}>
      <rect x="2" y="6" width="12" height="8" rx="1.3" fill="url(#np-src-shares-body)" {...rim} />
      <path d="M8 1.8 10.8 5H9v5H7V5H5.2z" fill="#fff" stroke="rgba(0,0,0,0.35)" strokeWidth="0.5" />
    </Base>
  );
}

export const SOURCE_ICONS = {
  library: LibraryIcon,
  songs: SongsIcon,
  albums: AlbumsIcon,
  artists: ArtistsIcon,
  genres: GenresIcon,
  playlists: PlaylistsIcon,
  queue: QueueIcon,
  downloads: DownloadsIcon,
  history: HistoryIcon,
  discover: DiscoverIcon,
  groups: GroupsIcon,
  'connected-libraries': ConnectedLibrariesIcon,
  devices: DevicesIcon,
  settings: SettingsIcon,
  hub: HubIcon,
  companion: CompanionIcon,
  starred: StarredIcon,
  shares: SharesIcon,
} as const;
export type SourceIconName = keyof typeof SOURCE_ICONS;

export function SourceIcon({ name, ...props }: IconProps & { name: SourceIconName }) {
  const C = SOURCE_ICONS[name];
  return <C {...props} />;
}
