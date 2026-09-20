/**
 * Where each album's star goes in the constellation, and how big and what colour it is.
 *
 * Kept apart from the Three.js scene so the styleguide places its specimen with this exact function.
 * The layout carries information rather than scatter: albums by one artist share an angular sector,
 * a star's size is how many songs the album has, and its hue is the artist's.
 */

export interface StarInput {
  artist: string;
  trackCount: number;
}

export interface StarPlacement {
  /** Scene units; the camera sits at z = CONSTELLATION_CAMERA_Z looking down −z. */
  x: number;
  y: number;
  z: number;
  /** Radius multiplier for a unit sphere. */
  scale: number;
  /** 0–1, for HSL at saturation 0.55 and lightness 0.65. */
  hue: number;
}

export const CONSTELLATION_CAMERA_Z = 42;

/** Place albums, given in display order (sorted by artist, then album). */
export function layoutStars(albums: readonly StarInput[]): StarPlacement[] {
  const artists = [...new Set(albums.map((a) => a.artist))];
  const span = Math.max(1, artists.length);
  return albums.map((album, index) => {
    const artistIndex = artists.indexOf(album.artist);
    const sector = (artistIndex / span) * Math.PI * 2;
    const spread = ((index % 7) - 3) * 0.12;
    const radius = 12 + ((index * 7) % 18);
    return {
      x: Math.cos(sector + spread) * radius,
      y: Math.sin(sector + spread) * radius * 0.6,
      z: ((index % 11) - 5) * 1.6,
      // Size carries the album's length, so a glance says which are the substantial records.
      scale: 0.35 + Math.min(1.6, album.trackCount * 0.08),
      hue: (artistIndex / span) * 0.8,
    };
  });
}
