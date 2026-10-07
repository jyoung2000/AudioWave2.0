/**
 * The search popover's markup (NP-FIND-001/003..008): rows, platform badges, the per-service status
 * line, detail headers and the 2×2 mosaic. Strings, built from untrusted answers: every value is
 * escaped, and only http(s) addresses reach an `src`.
 */
import {
  CATALOG_PLATFORM_LABELS,
  type CatalogAlbum,
  type CatalogArtist,
  type CatalogCollection,
  type CatalogPlatform,
  type CatalogProviderId,
  type CatalogSection,
  type CatalogSource,
  type CatalogSourceStatus,
  type CatalogTrack,
} from '@now-playing/contracts';
import { webUrl } from './client.js';

export function esc(t: unknown): string {
  return String(t ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export function fmtTime(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const NOTE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.6 3 9.8 5.2a1 1 0 0 0-.8 1v9.7a3.1 3.1 0 1 0 1.6 2.7V9.6l7.6-1.7v5.6a3.1 3.1 0 1 0 1.6 2.7V3.8a.8.8 0 0 0-1-.8z"/></svg>';
const PERSON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.2" r="4.2"/><path d="M3.8 21c.6-4.6 4-7.2 8.2-7.2s7.6 2.6 8.2 7.2z"/></svg>';

export const SECTION_LABEL: Record<CatalogSection, string> = {
  tracks: 'Songs',
  artists: 'Artists',
  albums: 'Albums',
};
export const SECTION_NOUN: Record<CatalogSection, [string, string]> = {
  tracks: ['song', 'songs'],
  artists: ['artist', 'artists'],
  albums: ['album', 'albums'],
};
export const PROVIDER_LABEL: Record<CatalogProviderId, string> = {
  itunes: 'Apple Music',
  deezer: 'Deezer',
  musicbrainz: 'MusicBrainz',
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
};

export const count = (n: number, s: CatalogSection): string =>
  `${n} ${SECTION_NOUN[s][n === 1 ? 0 : 1]}`;

/** The clip a row can play: Apple's, then Deezer's, then any other; http(s) only. */
export function previewOf(t: CatalogTrack): string | null {
  const order: CatalogPlatform[] = ['apple-music', 'deezer'];
  const sorted = [...t.sources].sort(
    (a, b) => (order.indexOf(a.platform) + 1 || 9) - (order.indexOf(b.platform) + 1 || 9),
  );
  for (const s of sorted) {
    const u = webUrl(s.previewUrl);
    if (u) return u;
  }
  return null;
}

/** Spotify plays from YouTube Music, through spotDL: spotDL's own match, or the one it finds at download. */
export function spotifyVia(sources: readonly CatalogSource[]): boolean {
  return (
    sources.some((s) => s.platform === 'spotify') &&
    !sources.some(
      (s) =>
        s.platform !== 'spotify' &&
        s.platform !== 'youtube-music' &&
        s.matchedBy !== 'musicbrainz' &&
        s.matchedBy !== 'odesli',
    )
  );
}

/** Every platform the item is on, once each, in the order the sources name them (UX-CAT-003). */
export function platformsOf(sources: readonly CatalogSource[]): CatalogPlatform[] {
  const out: CatalogPlatform[] = [];
  const via = spotifyVia(sources);
  for (const s of sources) {
    // spotDL's YouTube Music match is said with the Spotify badge, not as a second badge.
    if (via && s.platform === 'youtube-music' && s.matchedBy === 'spotdl') continue;
    if (!out.includes(s.platform)) out.push(s.platform);
  }
  return out;
}

const BADGES_ON_ROW = 3;

export function badgesHTML(sources: readonly CatalogSource[]): string {
  const list = platformsOf(sources);
  if (!list.length) return '';
  const via = spotifyVia(sources);
  const words = list.map((p) => CATALOG_PLATFORM_LABELS[p]);
  const said = `On ${words.join(', ')}${via ? '; Spotify plays from YouTube Music through spotDL' : ''}`;
  return (
    `<span class="srch__pfs" title="${esc(said)}">` +
    // Three at most on the row, so the title keeps its room; the rest are counted, and every one is
    // named in the tooltip and on the song's page.
    list
      .slice(0, BADGES_ON_ROW)
      .map(
        (p) => `<span class="srch__badge" data-pf="${p}">${esc(CATALOG_PLATFORM_LABELS[p])}</span>`,
      )
      .join('') +
    (list.length > BADGES_ON_ROW
      ? `<span class="srch__badge srch__badge--more">+${list.length - BADGES_ON_ROW}</span>`
      : '') +
    (via ? '<span class="srch__via">plays from YouTube Music</span>' : '') +
    '</span>'
  );
}

/** The words for the second line of a song: who, then the album, then the year. */
export function songSub(t: CatalogTrack): string {
  // With an album, its year; without one (an upload, a pasted link), the whole date it was released.
  const tail = t.album
    ? [t.album, t.year ?? (t.releaseDate ? t.releaseDate.slice(0, 4) : null)]
        .filter(Boolean)
        .join(' · ')
    : (t.releaseDate ?? '');
  return t.artist ? (tail ? `${t.artist} — ${tail}` : t.artist) : tail;
}

/** An image address: http(s), or an inline picture (`data:image/…`), which an <img> cannot run. */
export function imgUrl(u: unknown): string | null {
  if (
    typeof u === 'string' &&
    /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(u) &&
    u.length <= 200_000
  )
    return u;
  return webUrl(u);
}

function img(url: string | null, alt = ''): string {
  const u = imgUrl(url);
  return u ? `<img src="${esc(u)}" alt="${esc(alt)}" loading="lazy" onerror="this.remove()">` : '';
}

export const CLIP_SECONDS = 30;

export function artHTML(t: CatalogTrack, i: number): string {
  const inner = img(t.artworkUrl) + NOTE;
  if (!previewOf(t)) {
    // Unavailable is shown and explained (NP-PRIN-002): the tile stays, and says why.
    const whyNot = `No preview — ${platformsOf(t.sources).length ? 'none of its platforms offers a clip' : 'nothing to play here'}`;
    return `<span class="srch__art" title="${esc(whyNot)}" aria-label="${esc(whyNot)}">${inner}</span>`;
  }
  return (
    `<button class="srch__art" type="button" data-preview="${i}" aria-pressed="false" tabindex="-1" aria-label="Preview ${esc(t.title)}, ${CLIP_SECONDS} seconds">${inner}` +
    '<span class="srch__scrim"><svg viewBox="0 0 30 30" aria-hidden="true">' +
    '<circle class="srch__ring" cx="15" cy="15" r="13.5"/><circle class="srch__ring srch__ring--on" cx="15" cy="15" r="13.5"/>' +
    '<path class="srch__glyph srch__play" d="M12 10.5 19 15l-7 4.5z"/>' +
    '<rect class="srch__glyph srch__stop" x="11.5" y="11.5" width="7" height="7" rx="1"/>' +
    '</svg></span></button>'
  );
}

const opt = (i: number, cls: string, inner: string, label?: string): string =>
  `<div class="srch__row${cls}" role="option" id="srchOpt${i}" data-i="${i}" aria-selected="false"${label ? ` aria-label="${esc(label)}"` : ''}>${inner}</div>`;

export function trackRowHTML(t: CatalogTrack, i: number, added: boolean): string {
  const sec = t.durationMs ? t.durationMs / 1000 : 0;
  const add = added
    ? `<button class="srch__add" type="button" aria-disabled="true" tabindex="-1" aria-label="${esc(t.title)} is already in your library">✓</button>`
    : `<button class="srch__add" type="button" data-add="${i}" tabindex="-1" aria-label="Add ${esc(t.title)} to your library">+</button>`;
  return opt(
    i,
    '',
    artHTML(t, i) +
      '<span class="srch__meta">' +
      `<span class="srch__line"><span class="srch__title">${esc(t.title)}</span>${badgesHTML(t.sources)}</span>` +
      `<span class="srch__sub">${esc(songSub(t))}</span>` +
      '</span>' +
      (t.genre ? `<span class="srch__genre">${esc(t.genre)}</span>` : '') +
      '<span class="srch__nums">' +
      `<span class="srch__time">${sec ? fmtTime(sec) : ''}</span>` +
      `<span class="srch__bpm">${t.bpm ? `${Math.round(t.bpm)} bpm` : ''}</span>` +
      '</span>' +
      `<span class="srch__links">${add}</span>`,
  );
}

export function artistRowHTML(a: CatalogArtist, i: number): string {
  const facts = [
    a.genre,
    a.albumCount ? `${a.albumCount} ${a.albumCount === 1 ? 'album' : 'albums'}` : null,
    a.fans ? `${a.fans.toLocaleString('en-US')} fans` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return opt(
    i,
    ' srch__row--artist',
    `<span class="srch__art srch__art--round" aria-hidden="true">${img(a.pictureUrl)}${PERSON}</span>` +
      '<span class="srch__meta">' +
      `<span class="srch__line"><span class="srch__title">${esc(a.name)}</span>${badgesHTML(a.sources)}</span>` +
      `<span class="srch__sub">${esc(facts || 'Artist')}</span>` +
      '</span><span class="srch__go" aria-hidden="true">›</span>',
  );
}

export function albumRowHTML(al: CatalogAlbum, i: number): string {
  const facts = [
    al.artist,
    al.year ?? (al.releaseDate ? al.releaseDate.slice(0, 4) : null),
    al.trackCount ? `${al.trackCount} songs` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return opt(
    i,
    ' srch__row--album',
    `<span class="srch__art" aria-hidden="true">${img(al.artworkUrl)}${NOTE}</span>` +
      '<span class="srch__meta">' +
      `<span class="srch__line"><span class="srch__title">${esc(al.title)}</span>${badgesHTML(al.sources)}</span>` +
      `<span class="srch__sub">${esc(facts || 'Album')}</span>` +
      '</span><span class="srch__go" aria-hidden="true">›</span>',
  );
}

export function moreRowHTML(
  section: CatalogSection,
  shown: number,
  known: number,
  more: boolean,
  i: number,
): string {
  const label = `See all ${SECTION_LABEL[section].toLowerCase()}${known > shown ? ` (${known}${more ? '+' : ''})` : ''}`;
  return opt(
    i,
    ' srch__more',
    `<span class="srch__morelabel">${esc(label)}</span><span class="srch__go" aria-hidden="true">›</span>`,
  );
}

/** A 2×2 mosaic of the first four songs' covers; the list's own cover when fewer than four have one. */
export function mosaicHTML(
  c: Pick<CatalogCollection, 'artworkUrl' | 'covers'>,
  cls = 'srch__art',
): string {
  const covers = c.covers.map(imgUrl).filter((u): u is string => Boolean(u));
  if (covers.length >= 4) {
    return `<span class="${cls} srch__mosaic" aria-hidden="true">${covers
      .slice(0, 4)
      .map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`)
      .join('')}</span>`;
  }
  const own = imgUrl(c.artworkUrl) ?? covers[0] ?? null;
  return `<span class="${cls}" aria-hidden="true">${img(own)}${NOTE}</span>`;
}

export function collectionWords(c: CatalogCollection): string {
  const kind = c.ref.kind === 'album' ? 'Album' : 'Playlist';
  const n = c.page.total ?? c.page.tracks.length;
  return [
    `${kind} on ${CATALOG_PLATFORM_LABELS[c.ref.platform]}`,
    c.ref.owner,
    n ? `${n.toLocaleString('en-US')} ${n === 1 ? 'song' : 'songs'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function collectionRowHTML(c: CatalogCollection, i: number): string {
  return opt(
    i,
    ' srch__row--coll',
    mosaicHTML(c) +
      '<span class="srch__meta">' +
      `<span class="srch__line"><span class="srch__title">${esc(c.ref.title)}</span><span class="srch__pfs"><span class="srch__badge" data-pf="${c.ref.platform}">${esc(CATALOG_PLATFORM_LABELS[c.ref.platform])}</span></span></span>` +
      `<span class="srch__sub">${esc(collectionWords(c))}</span>` +
      '</span><span class="srch__open">Open in Music</span><span class="srch__go" aria-hidden="true">›</span>',
    `${c.ref.title}, ${collectionWords(c)}. Opens in the music list`,
  );
}

/* ------------------------------------------------------------ status line */

const STATE_WORDS: Record<CatalogSourceStatus['state'], string> = {
  pending: 'searching…',
  ok: '',
  empty: 'nothing',
  failed: 'failed',
  timeout: 'timed out',
  'cooling-down': 'resting',
  skipped: 'not asked',
};

function clock(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One quiet line: each service and how it did, in the engine's own states (UX-CAT-001). */
export function statusHTML(
  list: readonly CatalogSourceStatus[],
  via: string,
  linked: readonly string[] = [],
): string {
  const parts = list.map((s) => {
    const word =
      s.state === 'ok'
        ? String(s.count)
        : s.state === 'cooling-down'
          ? `cooling down${s.retryAt ? ` until ${clock(s.retryAt)}` : ''}`
          : s.state === 'skipped' && /yt-dlp/.test(s.error ?? '')
            ? 'needs yt-dlp'
            : STATE_WORDS[s.state];
    const why = s.error ? ` title="${esc(s.error)}"` : '';
    return `<span class="srch__st" data-state="${s.state}"${why}>${esc(PROVIDER_LABEL[s.provider])} ${esc(word)}</span>`;
  });
  // With no hub and no companion, this browser asks what answers a page; yt-dlp is the servers'.
  const browserOnly =
    via === 'this browser'
      ? '<span class="srch__note"> YouTube and SoundCloud results need the hub or the companion.</span>'
      : '';
  // Platforms the search found only as other homes of its songs (MusicBrainz's links), not by searching them.
  const links = linked.length
    ? `<span class="srch__dot" aria-hidden="true"> · </span><span class="srch__st" data-state="linked">${esc(linked.join(', '))}: links only</span>`
    : '';
  return (
    parts.join('<span class="srch__dot" aria-hidden="true"> · </span>') +
    links +
    (via ? `<span class="srch__via2"> — through ${esc(via)}.</span>` : '') +
    browserOnly
  );
}

/** The same, said plainly for a screen reader and for the failure message. */
export function statusWords(list: readonly CatalogSourceStatus[]): string {
  return list
    .filter((s) => s.state !== 'ok' && s.state !== 'pending')
    .map((s) => `${PROVIDER_LABEL[s.provider]}: ${s.error ?? STATE_WORDS[s.state]}`)
    .join('. ');
}

export function spinner(): string {
  let s = '<span class="srch__spin" aria-hidden="true">';
  for (let i = 0; i < 12; i++)
    s += `<i style="transform:rotate(${i * 30}deg);animation-delay:${(i / 12 - 1).toFixed(3)}s"></i>`;
  return `${s}</span>`;
}

/* ---------------------------------------------------------- detail heads */

export function detailHead(o: {
  cover: string;
  title: string;
  sub: string;
  facts: string;
  badges: string;
  actions: string;
}): string {
  return (
    `<div class="srch__detail">${o.cover}` +
    '<div class="srch__dmeta">' +
    `<p class="srch__dtitle">${esc(o.title)}</p>` +
    (o.sub ? `<p class="srch__dsub">${esc(o.sub)}</p>` : '') +
    (o.facts ? `<p class="srch__dfacts">${o.facts}</p>` : '') +
    (o.badges ? `<p class="srch__dpfs">${o.badges}</p>` : '') +
    (o.actions ? `<p class="srch__dacts">${o.actions}</p>` : '') +
    '</div></div>'
  );
}

export function coverHTML(url: string | null, round = false): string {
  return `<span class="srch__cover${round ? ' srch__cover--round' : ''}" aria-hidden="true">${img(url)}${round ? PERSON : NOTE}</span>`;
}

/** LRC (`[mm:ss.xx] line`) as lines with their times; plain lyrics as they are. */
export function lyricsHTML(synced: string | null, plain: string | null): string {
  if (synced) {
    const lines = synced
      .split(/\r?\n/)
      .map((l) => /^\[(\d+):(\d+)(?:\.\d+)?\]\s?(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map(
        (m) => `<p class="srch__lyr"><time>${Number(m[1])}:${m[2]}</time> ${esc(m[3] || '♪')}</p>`,
      );
    if (lines.length) return `<div class="srch__lyrics" data-kind="synced">${lines.join('')}</div>`;
  }
  if (plain) {
    return `<div class="srch__lyrics" data-kind="plain">${plain
      .split(/\r?\n/)
      .map((l) => `<p class="srch__lyr">${esc(l) || '&nbsp;'}</p>`)
      .join('')}</div>`;
  }
  return '';
}
