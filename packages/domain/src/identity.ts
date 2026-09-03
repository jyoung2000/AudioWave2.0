import type { Track, TrackIdentity, TrackRef } from '@now-playing/contracts';

/** Lower-case, accent-stripped, punctuation-free text for matching. Never used for display. */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const VARIANT_RE =
  /\s*[([-]\s*(remaster(?:ed)?(?:\s*\d{4})?|deluxe(?: edition| version)?|expanded(?: edition)?|bonus track(?: version)?|radio edit|single version|album version|live(?: at [^)\]]+)?|acoustic|instrumental|demo|mono|stereo|explicit|clean|feat\.?[^)\]]*|featuring[^)\]]*|with [^)\]]*|\d{4} remaster|anniversary edition|reissue|remix|edit|extended(?: mix)?|original mix)\s*[)\]]?\s*$/i;

export interface TitleParts {
  base: string;
  variants: string[];
}

/** Split "Song (Remastered 2011)" into base "song" and variants ["remastered 2011"]. */
export function splitTitleVariants(title: string): TitleParts {
  let working = title.trim();
  const variants: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const m = VARIANT_RE.exec(working);
    if (!m || m.index === 0) break;
    variants.unshift(normalizeText(m[1]));
    working = working.slice(0, m.index).trim();
  }
  return { base: normalizeText(working) || normalizeText(title), variants };
}

export function artistSortName(name: string): string {
  const trimmed = name.trim();
  const m = /^(the|a|an)\s+(.+)$/i.exec(trimmed);
  return m ? `${m[2]}, ${m[1]}` : trimmed;
}

export function normalizeArtist(name: string | null | undefined): string {
  const n = normalizeText(name);
  return n.replace(/^the /, '').replace(/\s*(feat|featuring|ft)\b.*$/, '').trim();
}

export interface MatchResult {
  confidence: number;
  reason: 'content-hash' | 'isrc' | 'musicbrainz' | 'provider-id' | 'metadata-strong' | 'metadata-weak' | 'none';
  sameVariant: boolean;
}

interface Matchable {
  title: string;
  artistName: string;
  albumName?: string | null;
  durationMs?: number | null;
  identity?: TrackIdentity;
}

/** Does `a` describe the same recording as `b`? Deterministic and explainable. */
export function matchTracks(a: Matchable, b: Matchable): MatchResult {
  const ia = a.identity;
  const ib = b.identity;
  if (ia?.contentHash && ib?.contentHash) {
    if (ia.contentHash === ib.contentHash) return { confidence: 1, reason: 'content-hash', sameVariant: true };
  }
  if (ia?.isrc && ib?.isrc && ia.isrc === ib.isrc) return { confidence: 0.98, reason: 'isrc', sameVariant: true };
  if (ia?.musicbrainzRecordingId && ib?.musicbrainzRecordingId && ia.musicbrainzRecordingId === ib.musicbrainzRecordingId) {
    return { confidence: 0.97, reason: 'musicbrainz', sameVariant: true };
  }
  if (ia?.providerIds && ib?.providerIds) {
    for (const [provider, ids] of Object.entries(ia.providerIds)) {
      const other = ib.providerIds[provider];
      if (other && ids.some((id) => other.includes(id))) return { confidence: 0.99, reason: 'provider-id', sameVariant: true };
    }
  }
  const ta = splitTitleVariants(a.title);
  const tb = splitTitleVariants(b.title);
  const artistEqual = normalizeArtist(a.artistName) === normalizeArtist(b.artistName) && normalizeArtist(a.artistName) !== '';
  const titleEqual = ta.base === tb.base && ta.base !== '';
  if (!artistEqual || !titleEqual) return { confidence: 0, reason: 'none', sameVariant: false };
  const sameVariant = ta.variants.join('|') === tb.variants.join('|');
  const da = a.durationMs ?? null;
  const db = b.durationMs ?? null;
  const durationClose = da !== null && db !== null ? Math.abs(da - db) <= 2000 : null;
  if (durationClose === true) return { confidence: sameVariant ? 0.9 : 0.75, reason: 'metadata-strong', sameVariant };
  if (durationClose === false) return { confidence: 0.35, reason: 'metadata-weak', sameVariant: false };
  return { confidence: sameVariant ? 0.7 : 0.55, reason: 'metadata-weak', sameVariant };
}

/** Group tracks that confidently (>= threshold) describe the same recording. Order-stable. */
export function dedupeTracks<T extends Matchable>(tracks: readonly T[], threshold = 0.85): T[][] {
  const groups: T[][] = [];
  for (const track of tracks) {
    let placed = false;
    for (const group of groups) {
      const head = group[0]!;
      if (matchTracks(head, track).confidence >= threshold) {
        group.push(track);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([track]);
  }
  return groups;
}

export function trackToRef(track: Track): TrackRef {
  const firstLocator = track.locators[0];
  return {
    trackId: track.id,
    title: track.title,
    artistName: track.artistName,
    albumName: track.albumName,
    durationMs: track.durationMs,
    artworkId: track.artworkId,
    identity: track.identity,
    locators: track.locators,
    provider: firstLocator?.kind === 'provider' ? firstLocator.provider : firstLocator?.kind === 'hub-blob' ? 'hub' : firstLocator?.kind === 'windows-file' ? 'companion' : 'local',
    genre: track.genre,
    year: track.year,
  };
}

/** Stable key used for local dedupe heuristics before hashing (path is intentionally NOT part of it). */
export function metadataDedupeKey(t: Matchable): string {
  const parts = splitTitleVariants(t.title);
  const dur = t.durationMs ? Math.round(t.durationMs / 2000) : 0;
  return `${normalizeArtist(t.artistName)}|${parts.base}|${parts.variants.join(',')}|${dur}`;
}
