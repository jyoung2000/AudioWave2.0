import { svgProps, type IconProps } from './Icon.js';

/** Toolbar/glyph family: single colour, straight-on, 12–16 px (spec §9.21). Original paths. */
const PATHS = {
  play: 'M6 4.2 18 12 6 19.8z',
  pause: 'M6.5 5h3.6v14H6.5zM13.9 5h3.6v14h-3.6z',
  stop: 'M6 6h12v12H6z',
  previous: 'M4 6.5h2.2v11H4zM13.5 6.5v11L6.7 12zM20.5 6.5v11L13.7 12z',
  next: 'M3.5 6.5 10.3 12l-6.8 5.5zM10.5 6.5 17.3 12l-6.8 5.5zM17.8 6.5H20v11h-2.2z',
  shuffle: 'M4 7h3.2l2.3 3.3-1.3 1.9L6.2 9H4zM4 15h2.2l8.4-12H18V1.5L22 5l-4 3.5V6h-2.3L7.2 17H4zM18 15.5V13l4 3.5-4 3.5V17h-3.4l-2.6-3.8 1.3-1.9 2.4 3.4z',
  repeat: 'M7 8.5h9.5a3.5 3.5 0 0 1 3.5 3.5v.5h-2v-.5a1.5 1.5 0 0 0-1.5-1.5H7v2.5L3 10l4-3zM17 15.5H7.5A3.5 3.5 0 0 1 4 12v-.5h2v.5a1.5 1.5 0 0 0 1.5 1.5H17V11l4 3-4 3z',
  'repeat-one': 'M7 8.5h9.5a3.5 3.5 0 0 1 3.5 3.5v.5h-2v-.5a1.5 1.5 0 0 0-1.5-1.5H7v2.5L3 10l4-3zM17 15.5H7.5A3.5 3.5 0 0 1 4 12v-.5h2v.5a1.5 1.5 0 0 0 1.5 1.5H17V11l4 3-4 3zM11.2 9.6h1.6v5h-1.4v-3.4l-1 .5V10.5z',
  'volume-low': 'M4 9h3.2L11 5.8v12.4L7.2 15H4zM13.3 9.4a3.6 3.6 0 0 1 0 5.2l-1.1-1.1a2.1 2.1 0 0 0 0-3z',
  'volume-high': 'M3 9h3.2L10 5.8v12.4L6.2 15H3zM12.3 9.4a3.6 3.6 0 0 1 0 5.2l-1.1-1.1a2.1 2.1 0 0 0 0-3zM14.8 6.9a7 7 0 0 1 0 10.2l-1.1-1.1a5.5 5.5 0 0 0 0-8z',
  mute: 'M3 9h3.2L10 5.8v12.4L6.2 15H3zM13.4 9.6l1.6 1.6 1.6-1.6 1.1 1.1-1.6 1.6 1.6 1.6-1.1 1.1-1.6-1.6-1.6 1.6-1.1-1.1 1.6-1.6-1.6-1.6z',
  search: 'M10 4a6 6 0 0 1 4.7 9.7l4.8 4.8-1.5 1.5-4.8-4.8A6 6 0 1 1 10 4zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  clear: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm3.2 4.4L12 10.6 8.8 7.4 7.4 8.8l3.2 3.2-3.2 3.2 1.4 1.4 3.2-3.2 3.2 3.2 1.4-1.4-3.2-3.2 3.2-3.2z',
  close: 'M6.2 4.8 12 10.6l5.8-5.8 1.4 1.4L13.4 12l5.8 5.8-1.4 1.4L12 13.4l-5.8 5.8-1.4-1.4L10.6 12 4.8 6.2z',
  add: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z',
  remove: 'M4 11h16v2H4z',
  gear: 'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zm-1.4-6h2.8l.5 2.6c.6.2 1.2.5 1.7.9l2.5-.9 1.4 2.4-2 1.7c.1.6.1 1.2 0 1.8l2 1.7-1.4 2.4-2.5-.9c-.5.4-1.1.7-1.7.9l-.5 2.6h-2.8l-.5-2.6c-.6-.2-1.2-.5-1.7-.9l-2.5.9-1.4-2.4 2-1.7c-.1-.6-.1-1.2 0-1.8l-2-1.7 1.4-2.4 2.5.9c.5-.4 1.1-.7 1.7-.9z',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm-1 7h2v7h-2zm0-3.5h2v2h-2z',
  warning: 'M12 3 22 20H2zm-1 6v5h2V9zm0 6.5v2h2v-2z',
  error: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm-1 4h2v7h-2zm0 8.5h2v2h-2z',
  check: 'M9.3 16.4 4.8 11.9l1.6-1.6 2.9 2.9 8.3-8.3 1.6 1.6z',
  'chevron-left': 'M14.6 4.6 16 6l-6 6 6 6-1.4 1.4L7.2 12z',
  'chevron-right': 'M9.4 4.6 8 6l6 6-6 6 1.4 1.4 7.4-7.4z',
  'chevron-up': 'M4.6 14.6 6 16l6-6 6 6 1.4-1.4L12 7.2z',
  'chevron-down': 'M4.6 9.4 6 8l6 6 6-6 1.4 1.4L12 16.8z',
  'disclosure-right': 'M8 5l8 7-8 7z',
  'disclosure-down': 'M5 8h14l-7 8z',
  speaker: 'M3 9h3.2L10 5.8v12.4L6.2 15H3zM12.3 9.4a3.6 3.6 0 0 1 0 5.2l-1.1-1.1a2.1 2.1 0 0 0 0-3zM14.8 6.9a7 7 0 0 1 0 10.2l-1.1-1.1a5.5 5.5 0 0 0 0-8z',
  eq: 'M5 4h2v6H5zm0 9h2v7H5zm6-9h2v11h-2zm0 14h2v2h-2zm6-14h2v3h-2zm0 6h2v10h-2zM3.5 10h5v2h-5zm6 5h5v2h-5zm6-8h5v2h-5z',
  lock: 'M12 2a5 5 0 0 1 5 5v3h1.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H7V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3zm0 9a1.5 1.5 0 0 0-.8 2.8V18h1.6v-2.2A1.5 1.5 0 0 0 12 13z',
  link: 'M10.6 13.4a1 1 0 0 1 0-1.4l2.8-2.8a1 1 0 0 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0zM8 16a3 3 0 0 1 0-4.2l2.1-2.1 1.4 1.4-2.1 2.1a1 1 0 0 0 1.4 1.4l2.1-2.1 1.4 1.4L12.2 16a3 3 0 0 1-4.2 0zm8-8a3 3 0 0 1 0 4.2l-2.1 2.1-1.4-1.4 2.1-2.1a1 1 0 0 0-1.4-1.4l-2.1 2.1-1.4-1.4L11.8 8a3 3 0 0 1 4.2 0z',
  download: 'M10.8 3h2.4v8.2h4.1L12 17.4l-5.3-6.2h4.1zM4.6 19h14.8v2H4.6z',
  upload: 'M12 3l5.3 6.2h-4.1V17h-2.4V9.2H6.7zM4.6 19h14.8v2H4.6z',
  refresh: 'M12 4a8 8 0 0 1 7.4 5H17l4-4 .1 6.3H14.8l2.1-2.1A6 6 0 0 0 6 12H4a8 8 0 0 1 8-8zm8 8a8 8 0 0 1-15.4 3H7l-4 4-.1-6.3H9.2l-2.1 2.1A6 6 0 0 0 18 12z',
  star: 'M12 2.8l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.7l-5.9 3.1 1.2-6.5L2.5 9.7l6.6-.9zm0 4.5-1.7 3.5-3.8.5 2.8 2.7-.7 3.8 3.4-1.8 3.4 1.8-.7-3.8 2.8-2.7-3.8-.5z',
  'star-filled': 'M12 2.8l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.7l-5.9 3.1 1.2-6.5L2.5 9.7l6.6-.9z',
  heart: 'M12 20.4 3.9 12.6a4.6 4.6 0 0 1 6.5-6.5l1.6 1.5 1.6-1.5a4.6 4.6 0 0 1 6.5 6.5zm0-2.8 6.6-6.4a2.6 2.6 0 0 0-3.7-3.7L12 10.3 9.1 7.5a2.6 2.6 0 0 0-3.7 3.7z',
  'heart-filled': 'M12 20.4 3.9 12.6a4.6 4.6 0 0 1 6.5-6.5l1.6 1.5 1.6-1.5a4.6 4.6 0 0 1 6.5 6.5z',
  more: 'M5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  folder: 'M3 5h6l2 2h10v12H3zm2 4v8h14V9z',
  reconnect: 'M7 6V3.5L3 7l4 3.5V8h7a3 3 0 0 1 3 3v1h2v-1a5 5 0 0 0-5-5zm10 12v2.5l4-3.5-4-3.5V16h-7a3 3 0 0 1-3-3v-1H5v1a5 5 0 0 0 5 5z',
  group: 'M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm8 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM2 19c0-3 2.7-5 6-5s6 2 6 5zm12 0c0-1.7-.6-3.2-1.6-4.3.9-.4 2.3-.7 3.6-.7 3.3 0 6 2 6 5z',
  solo: 'M12 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm-7 9c0-4 3.1-6.5 7-6.5s7 2.5 7 6.5z',
  'drag-handle': 'M9 5h2v2H9zm4 0h2v2h-2zM9 9h2v2H9zm4 0h2v2h-2zm-4 4h2v2H9zm4 0h2v2h-2zm-4 4h2v2H9zm4 0h2v2h-2z',
  share: 'M12 3l4.5 4.6-1.4 1.4L13 6.8V15h-2V6.8L8.9 9 7.5 7.6zM5 11h4v2H7v6h10v-6h-2v-2h4v10H5z',
  'playlist-add': 'M3 6h12v2H3zm0 4h12v2H3zm0 4h8v2H3zm14-1h2v3h3v2h-3v3h-2v-3h-3v-2h3z',
  qr: 'M3 3h8v8H3zm2 2v4h4V5zm8-2h8v8h-8zm2 2v4h4V5zM3 13h8v8H3zm2 2v4h4v-4zm8-2h3v3h-3zm5 0h3v3h-3zm-5 5h3v3h-3zm5 0h3v3h-3zm-2.5-2.5h2v2h-2z',
  car: 'M6 11l1.6-4.5A2 2 0 0 1 9.5 5h5a2 2 0 0 1 1.9 1.5L18 11h1a2 2 0 0 1 2 2v5h-2v1.5a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1V18h-7v1.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V18H3v-5a2 2 0 0 1 2-2zm2.1 0h7.8l-1.1-3.3a.5.5 0 0 0-.5-.3h-4.6a.5.5 0 0 0-.5.3zM6.5 16a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm11 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0-3z',
  copy: 'M8 3h10a2 2 0 0 1 2 2v10h-2V5H8zm-4 4h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v10h10V9z',
  note: 'M19.6 3 9.8 5.2a1 1 0 0 0-.8 1v9.7a3.1 3.1 0 1 0 1.6 2.7V9.6l7.6-1.7v5.6a3.1 3.1 0 1 0 1.6 2.7V3.8a.8.8 0 0 0-1-.8z',
  sort: 'M7 4l4 5H3zm10 16-4-5h8zM13 5h8v2h-8zm0 4h6v2h-6zM3 17h8v2H3zm0-4h6v2H3z',
  'sort-asc': 'M12 6l5 6H7z',
  'sort-desc': 'M12 18l-5-6h10z',
  cloud: 'M7 18a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.7 1.2A3.5 3.5 0 0 1 17 18z',
  offline: 'M7 18a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.7 1.2A3.5 3.5 0 0 1 17 18zm12.3 3.7L2.9 3.3l1.4-1.4 18.4 18.4z',
  history: 'M13 3a9 9 0 1 1-8.5 12h2.2A7 7 0 1 0 13 5a7 7 0 0 0-5 2.1V4H6v6h6V8H9.6A5 5 0 0 1 13 7zm-1 4h2v4.6l3 1.8-1 1.7-4-2.4z',
  device: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 2v14h12V4zm6 15a1 1 0 1 1 0 2 1 1 0 0 1 0-2z',
  minimize: 'M4 11h16v2H4z',
  zoom: 'M4 4h16v16H4zm2 2v12h12V6z',
} as const;

export type GlyphName = keyof typeof PATHS;
export const GLYPH_NAMES = Object.keys(PATHS) as GlyphName[];

/**
 * The raw path data, exported so the app icons can be checked against it.
 *
 * A PWA manifest and a Windows ICO cannot reference a React component, so those files repeat the
 * shape — and a repeated shape drifts. `packages/aqua-ui/tests/unit/icon-glyphs.test.ts` compares
 * them to this map.
 */
export const GLYPH_PATHS: Readonly<Record<GlyphName, string>> = PATHS;

export interface GlyphProps extends IconProps {
  name: GlyphName;
}

export function Glyph({ name, ...props }: GlyphProps) {
  const p = svgProps(props, 'glyph');
  return (
    <svg viewBox="0 0 24 24" {...p}>
      {props.title ? <title>{props.title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
