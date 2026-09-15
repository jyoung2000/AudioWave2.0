/**
 * Platform marks.
 *
 * Every row that came from somewhere shows where. The old badge was two grey letters, which is
 * honest but unreadable at a glance: in a list of two hundred rows nobody parses "SC" against "S".
 * A mark in the platform's own colour is read before it is read — that is the whole point of a
 * platform colour, and colour is not something a trademark protects.
 *
 * What a trademark *does* protect is the logo, and every one of these platforms publishes brand
 * terms that say the same two things: use our official file, and do not redraw it. So these are
 * not redrawn logos. Each mark is an Aqua tile in the platform's published colour carrying a plain
 * glyph for what the platform is to this app — a triangle for video, a cloud for SoundCloud's
 * namesake, a tag for buying from an artist. None of them imitates the mark it stands beside, and
 * the glyph rather than the colour carries the distinction, so the set still reads when the colour
 * is taken away (the itunes-10 profile greys the source list; colour-blind readers get the same
 * treatment for free).
 *
 * If you have accepted a platform's brand terms and hold their official asset, drop it in:
 * `ProviderArtworkProvider` replaces the built-in mark with your file wherever a mark is drawn,
 * unmodified and with its own clear space, which is what those terms ask for. The player exposes
 * that as Settings → Platforms → Artwork.
 *
 * Adding a platform: add a row here and a row in the player's `PLATFORMS` table. A test asserts the
 * two agree, so a platform can never show a mark without also saying what it can and cannot do.
 */
import { svgProps, type IconProps } from './Icon.js';
import { useProviderArtwork } from '../lib/provider-artwork.js';

export type ProviderGlyph = 'play' | 'cloud' | 'bars' | 'tag' | 'disc' | 'note' | 'house' | 'desktop' | 'speaker' | 'wrench';

export interface ProviderMarkSpec {
  /** Display name, spelled the way the platform spells it. */
  name: string;
  /** Shown when there is no glyph for this slug, and used anywhere a mark will not fit. */
  initials: string;
  /** The platform's published colour, top and bottom of the tile. */
  tile: readonly [string, string];
  glyph: ProviderGlyph | null;
}

/**
 * Colours are each platform's own published brand colour, darkened for the bottom of the tile so
 * the family shares one light source. Sources are in docs/PROVIDER_CAPABILITIES.md.
 */
export const PROVIDER_MARKS: Readonly<Record<string, ProviderMarkSpec>> = {
  local: { name: 'This device', initials: 'L', tile: ['#b9c4d0', '#6d7986'], glyph: 'note' },
  hub: { name: 'Your hub', initials: 'H', tile: ['#7cc4f7', '#1a5f9e'], glyph: 'house' },
  companion: { name: 'Windows companion', initials: 'PC', tile: ['#8ab0d8', '#3b5f88'], glyph: 'desktop' },
  musicbrainz: { name: 'MusicBrainz', initials: 'MB', tile: ['#d07ab4', '#8a2f68'], glyph: 'disc' },
  youtube: { name: 'YouTube', initials: 'YT', tile: ['#ff4f47', '#c00000'], glyph: 'play' },
  soundcloud: { name: 'SoundCloud', initials: 'SC', tile: ['#ff8a3d', '#e04b00'], glyph: 'cloud' },
  bandcamp: { name: 'Bandcamp', initials: 'BC', tile: ['#8dbcc8', '#41707e'], glyph: 'tag' },
  spotify: { name: 'Spotify', initials: 'SP', tile: ['#4ee089', '#12833c'], glyph: 'bars' },
  'public-domain': { name: 'Public domain', initials: 'PD', tile: ['#a6e28f', '#2f6a2b'], glyph: 'speaker' },
  'external-tool': { name: 'External tool', initials: 'X', tile: ['#cfd4da', '#6a717a'], glyph: 'wrench' },
};

/** Unknown slugs still get a mark: a neutral tile with whatever initials the slug gives up. */
export function markFor(provider: string): ProviderMarkSpec {
  return PROVIDER_MARKS[provider] ?? { name: provider, initials: initialsFrom(provider), tile: ['#cfd4da', '#6a717a'], glyph: null };
}

export function initialsFrom(provider: string): string {
  const letters = provider
    .split(/[-_ ]+/)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
    .slice(0, 2);
  return letters || 'P';
}

export interface ProviderMarkProps extends IconProps {
  provider: string;
  /**
   * An official asset to use instead of the built-in mark. Normally left unset — `ProviderMark`
   * reads it from `ProviderArtworkProvider` — but passed directly by the settings preview, which
   * has to show a file before it is saved.
   */
  artwork?: string | null;
}

export function ProviderMark({ provider, artwork, title, size, className, ...rest }: ProviderMarkProps) {
  const supplied = useProviderArtwork(provider);
  const spec = markFor(provider);
  const src = artwork === undefined ? supplied : artwork;
  if (src) {
    // An official asset goes in whole: no tile behind it, no crop, no recolour. That is what every
    // one of these platforms asks for, and it is also the only way the file still means what its
    // owner intended.
    return (
      <img
        className={['aqua-icon', 'aqua-icon--provider', className].filter(Boolean).join(' ')}
        src={src}
        alt={title ?? ''}
        {...(title ? {} : { 'aria-hidden': true })}
        width={size ?? undefined}
        height={size ?? undefined}
        draggable={false}
      />
    );
  }
  const id = `pm-${provider.replace(/[^a-z0-9-]/g, '')}`;
  return (
    <svg viewBox="0 0 16 16" {...svgProps({ ...(title === undefined ? {} : { title }), ...(size === undefined ? {} : { size }), ...(className === undefined ? {} : { className }), ...rest }, 'provider')}>
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={spec.tile[0]} />
          <stop offset="1" stopColor={spec.tile[1]} />
        </linearGradient>
      </defs>
      <rect width="16" height="16" rx="3.6" fill={`url(#${id}-tile)`} />
      <path d="M0 3.6A3.6 3.6 0 0 1 3.6 0h8.8A3.6 3.6 0 0 1 16 3.6v3.1c-2.5 1.5-5.2 2.2-8 2.2S2.5 8.2 0 6.7z" fill="#fff" opacity="0.24" />
      {spec.glyph ? <Glyph name={spec.glyph} shadow={spec.tile[1]} /> : <text x="8" y="8" textAnchor="middle" dominantBaseline="central" fontSize={spec.initials.length > 1 ? 7 : 9} fontWeight="700" fill="#fff" fontFamily="inherit">{spec.initials}</text>}
      <rect x="0.5" y="0.5" width="15" height="15" rx="3.1" fill="none" stroke="rgba(0,0,0,0.3)" />
    </svg>
  );
}

/**
 * The glyphs. Each is one silhouette in white, sized to clear the tile's rim, and chosen for what
 * the platform is rather than for what its logo looks like.
 */
function Glyph({ name, shadow }: { name: ProviderGlyph; shadow: string }) {
  switch (name) {
    case 'play':
      return <path d="M6.1 4.5 11.9 8l-5.8 3.5z" fill="#fff" />;
    case 'cloud':
      return (
        <g fill="#fff">
          <circle cx="6.1" cy="9" r="2.2" />
          <circle cx="9.4" cy="7.9" r="2.9" />
          <rect x="6.1" y="9.1" width="4.7" height="2.1" rx="1.05" />
        </g>
      );
    case 'bars':
      return (
        <g fill="#fff">
          <rect x="4.3" y="8.2" width="1.9" height="3.6" rx="0.95" />
          <rect x="7.05" y="4.4" width="1.9" height="7.4" rx="0.95" />
          <rect x="9.8" y="6.5" width="1.9" height="5.3" rx="0.95" />
        </g>
      );
    case 'tag':
      return (
        <g>
          <path d="M8.7 3.3H12a.7.7 0 0 1 .7.7v3.3a1 1 0 0 1-.3.72l-4.26 4.26a1 1 0 0 1-1.42 0L3.7 9.28a1 1 0 0 1 0-1.42L7.98 3.6a1 1 0 0 1 .72-.3z" fill="#fff" />
          <circle cx="10.5" cy="5.5" r="0.85" fill={shadow} />
        </g>
      );
    case 'disc':
      return (
        <g>
          <circle cx="8" cy="8" r="4.3" fill="#fff" />
          <circle cx="8" cy="8" r="1.25" fill={shadow} />
        </g>
      );
    case 'note':
      return (
        <g fill="#fff">
          <path d="M6.05 10.7V5.1l5.15-1.3v5.6h-1.3V5.4L7.35 6.05V10.7z" />
          <circle cx="4.85" cy="10.9" r="1.75" />
          <circle cx="10" cy="9.55" r="1.75" />
        </g>
      );
    case 'house':
      return <path d="M8 3.1 13.2 7.7v5.2H9.55V9.85h-3.1v3.05H2.8V7.7z" fill="#fff" />;
    case 'desktop':
      return (
        <g fill="#fff">
          <rect x="2.9" y="3.9" width="10.2" height="6.7" rx="1" />
          <rect x="6.3" y="10.9" width="3.4" height="1.7" rx="0.7" />
        </g>
      );
    case 'speaker':
      return (
        <g>
          <path d="M3.5 6.4h2.1L8.5 4.1v7.8L5.6 9.6H3.5z" fill="#fff" />
          <path d="M10.3 6.1a2.8 2.8 0 0 1 0 3.8M12 4.6a5 5 0 0 1 0 6.8" fill="none" stroke="#fff" strokeWidth="1.15" strokeLinecap="round" />
        </g>
      );
    case 'wrench':
      return <path d="M12.1 3.2a3.1 3.1 0 0 0-4.05 3.85l-4.2 4.2a1.25 1.25 0 1 0 1.77 1.77l4.2-4.2A3.1 3.1 0 0 0 13.67 4.77l-1.72 1.72-1.55-1.55z" fill="#fff" />;
    default:
      return null;
  }
}
