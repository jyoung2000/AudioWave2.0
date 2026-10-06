/**
 * Stock songs for the player's search, so the search list in the mockup has something to show.
 *
 * The shell searches the paired hub first, then iTunes (keyless), and asks Deezer for each row's
 * tempo. The capture answers those two from `fixtures/search-catalogue.json` in their own shapes,
 * so the captured search states are the shell's real list; the mockup's search behaviour
 * (`behaviours/player-search.js`) filters the same songs as you type.
 *
 * Artwork is a small generated SVG per album (a gradient and the album's initials), written as a
 * data: URI so the mockup needs no network. Previews are addresses that are never fetched.
 */
import catalogueFile from '../fixtures/search-catalogue.json' with { type: 'json' };

const hueOf = (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

const initials = (text) =>
  text
    .replace(/\(.*?\)/g, '')
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

/** A 200×200 cover: the album's own colours and initials. */
export function coverFor(album) {
  const h = hueOf(album);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${h},58%,64%)"/><stop offset="1" stop-color="hsl(${(h + 48) % 360},62%,30%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="200" height="200" fill="url(#g)"/>` +
    `<circle cx="146" cy="58" r="36" fill="hsl(${(h + 180) % 360},70%,88%)" fill-opacity=".35"/>` +
    `<circle cx="146" cy="58" r="9" fill="#fff" fill-opacity=".5"/>` +
    `<text x="18" y="178" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#fff" fill-opacity=".92">${initials(album)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** Every stock song with its cover and a preview address (never fetched). */
export const CATALOGUE = catalogueFile.songs.map((s, i) => ({
  ...s,
  id: 9100 + i,
  art: coverFor(s.al),
  prev: `https://audio.mockup.invalid/preview/${9100 + i}.m4a`,
}));

/** Every word of the query appears in the title, artist or album — as iTunes matches a term. */
export function matches(song, query) {
  const hay = `${song.t} ${song.a} ${song.al}`.toLowerCase();
  return String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/** The iTunes Search API's answer for `term`, in its own shape. */
export function itunesAnswer(term) {
  const results = CATALOGUE.filter((s) => matches(s, term)).map((s) => ({
    wrapperType: 'track',
    kind: 'song',
    trackId: s.id,
    trackName: s.t,
    artistName: s.a,
    collectionName: s.al,
    artworkUrl100: s.art,
    previewUrl: s.prev,
    trackTimeMillis: s.d * 1000,
    primaryGenreName: s.genre,
  }));
  return { resultCount: results.length, results };
}

/** Deezer's JSONP answers the shell reads a tempo from: a search, then that track. */
export function deezerAnswer(url) {
  const callback = url.searchParams.get('callback') || 'callback';
  let body = { data: [] };
  const track = /^\/track\/(\d+)$/.exec(url.pathname);
  if (track) {
    const song = CATALOGUE.find((s) => s.id === Number(track[1]));
    body = song ? { id: song.id, bpm: song.bpm, duration: song.d } : { error: {} };
  } else if (url.pathname === '/search') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const song = CATALOGUE.find((s) => q === `${s.a} ${s.t}`.toLowerCase() || q === s.t.toLowerCase());
    if (song) body = { data: [{ id: song.id, duration: song.d }] };
  }
  return `${callback}(${JSON.stringify(body)});`;
}
