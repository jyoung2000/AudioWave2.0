/**
 * Product naming is centralised here so the suite can be renamed in one place.
 * Nothing else in the repository may hard-code the product name.
 *
 * The suite is Airwave, as its three designs (design/frontends/) name it; "Now Playing" is the
 * player's front page, not the product. The machine identifiers below (slug, URL scheme, storage
 * namespace, User-Agent) keep their original spelling on purpose: they are keys to data people
 * already have — renaming them would orphan a library, a pairing and a taskbar pin.
 */
export const BRANDING = {
  /** Human-readable suite name. */
  suiteName: 'Airwave',
  /** Short machine identifier used in file names, storage keys and headers. */
  slug: 'now-playing',
  /** Product names by folder. */
  products: {
    player: 'Airwave',
    hub: 'Airwave Hub',
    companion: 'Airwave Companion',
  },
  /** Deep-link scheme used by pairing QR codes and OS-level links. */
  urlScheme: 'nowplaying',
  /** Descriptive User-Agent prefix for services that require one (MusicBrainz). */
  userAgent: (version: string, contact: string): string =>
    `NowPlaying/${version} ( ${contact} )`,
  /** Storage namespace prefix (IndexedDB database names, localStorage keys, cookie names). */
  storageNamespace: 'now-playing',
  /** Default hub port. */
  hubPort: 4546,
  /** Project homepage placeholder used in documentation links. */
  homepage: 'https://github.com/jyoung2000/AudioWave2.0',
} as const;

export type Branding = typeof BRANDING;
