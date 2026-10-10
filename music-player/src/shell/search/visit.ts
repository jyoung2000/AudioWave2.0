/**
 * A visitor — a catalog song shown in the music list that is not on this device — made playable
 * (NP-FIND-011), and the player's Download… for one (NP-FIND-012). Installed by the search chunk as
 * `window.NP_VISIT`; the shell's transport and fetch sheet (make-shell.py) ask it.
 *
 * What can fetch the whole song, best first:
 *   1. the paired hub, when this device's credential may ask for downloads (`downloads:request`) and
 *      receive the file (`transfers:receive`): `POST /api/v1/catalog/download` picks the best source
 *      (YouTube Music → YouTube → SoundCloud → Bandcamp → spotDL), tags the file, and this device
 *      reads it back from `/api/v1/files/<sha256>` once the job completes — the blob is this device's,
 *      because the job was;
 *   2. the companion's helper on this PC (or the Android build's own tools), through its fetch;
 *   3. nothing — said plainly, with what would be needed.
 * Every route needs the person's statement of why they may have the file (the sheet's rights basis),
 * because both the hub and the helper refuse without one.
 *
 * Until the whole song is here, a visitor plays its 30-second preview, labelled "Preview" — never as
 * the song. This module never claims a play it has not made.
 */
import type { CatalogPlatform, CatalogTrack, DownloadAuthorizationBasis } from '@now-playing/contracts';
import { CATALOG_PLATFORM_LABELS } from '@now-playing/contracts';
import { embeddedText, pickDownloadSource } from '@now-playing/domain/catalog';
import { hubAccount, webUrl } from './client.js';

/** A visitor row, as the shell holds it. */
export interface VisitSong {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  bpm?: number | null;
  url: string | null;
  platform?: string;
  preview?: string | null;
  cat?: CatalogTrack;
}

export interface VisitRoute {
  kind: 'hub' | 'helper' | 'none';
  /** Who fetches, in words: "the hub TOWER", "the companion on this PC". */
  label: string;
  /** Why the better route was not taken, or (for `none`) what is needed. */
  why: string | null;
}

export interface FetchState {
  stage: 'asking' | 'queued' | 'fetching' | 'saving' | 'done' | 'failed';
  percent: number | null;
  /** What the row and the sheet say. */
  words: string;
  /** The hub's answer: the source it chose and what it embedded, said as the hub UI says it. */
  chosen: string | null;
  trackId: string | null;
}

export interface ShellVisit {
  route(): Promise<VisitRoute>;
  fetch(song: VisitSong, basis: DownloadAuthorizationBasis, onState: (s: FetchState) => void): Promise<FetchState>;
}

/** What the bridge's `window.NP_TOOLS` offers this module. */
export interface VisitTools {
  detect(): Promise<{ label: string } | null>;
  fetch(
    url: string,
    basis: DownloadAuthorizationBasis,
    onProgress?: (p: { percent: number | null; stage: string }) => void,
  ): Promise<{ added: number; trackId: string | null; reason: string | null }>;
  keep(file: File): Promise<{ trackId: string | null; reason: string | null }>;
}

/** How often a hub job is asked about, and for how long before the wait is given up. */
const POLL_MS = 1000;
const WAIT_MS = 15 * 60 * 1000;

const NEEDED = 'fetching it needs the hub (paired, with downloads allowed for this device) or the companion app on this PC.';

export function installVisit(tools: () => VisitTools | undefined): ShellVisit {
  async function hubRoute(): Promise<{ ok: true; acct: NonNullable<Awaited<ReturnType<typeof hubAccount>>>; label: string } | { ok: false; why: string | null }> {
    const acct = await hubAccount();
    if (!acct) return { ok: false, why: null };
    const label = `the hub ${acct.hubName ?? ''}`.trim();
    const scopes = (acct as { scopes?: unknown }).scopes;
    const has = (s: string): boolean => Array.isArray(scopes) && scopes.includes(s);
    if (!has('downloads:request'))
      return { ok: false, why: `${label} has not allowed this device to ask for downloads` };
    if (!has('transfers:receive'))
      return { ok: false, why: `${label} has not allowed this device to receive files` };
    return { ok: true, acct, label };
  }

  async function route(): Promise<VisitRoute> {
    const hub = await hubRoute();
    if (hub.ok) return { kind: 'hub', label: hub.label, why: null };
    const helper = await tools()?.detect().catch(() => null);
    if (helper) return { kind: 'helper', label: 'the companion on this PC', why: hub.why };
    return { kind: 'none', label: '', why: hub.why ? `${hub.why}, and no companion app is answering on this PC — ${NEEDED}` : NEEDED };
  }

  async function viaHub(
    acct: NonNullable<Awaited<ReturnType<typeof hubAccount>>>,
    label: string,
    song: VisitSong,
    basis: DownloadAuthorizationBasis,
    say: (s: Omit<FetchState, 'trackId'> & { trackId?: string | null }) => FetchState,
  ): Promise<FetchState> {
    const track = song.cat ?? trackOf(song);
    if (!track) return say({ stage: 'failed', percent: null, words: `${label} fetches songs from the catalog; this row’s link is not one it knows.`, chosen: null });
    const base = acct.base.replace(/\/$/, '');
    const auth = { Authorization: `Bearer ${acct.credentialId}.${acct.secret}` };
    let res: Response;
    try {
      res = await fetch(`${base}/api/v1/catalog/download`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ track, authorization: { basis, acknowledged: true }, target: { destination: 'player', format: 'original' } }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return say({ stage: 'failed', percent: null, words: `${label} did not answer. Check that it is on, and on this network.`, chosen: null });
    }
    if (!res.ok) return say({ stage: 'failed', percent: null, words: `${label} refused: ${await problem(res)}`, chosen: null });
    const answer = (await res.json()) as {
      job: { id: string; state: string; progress?: { percent?: number | null } };
      source: { platform: CatalogPlatform; matchedBy?: string };
      embedded: { isrc: boolean; genre: boolean; label: boolean; year: boolean; lyrics: boolean };
    };
    // The hub UI's own words (docker-container/src/web/views/Search.tsx): the source it chose, and the tags.
    const chosen = `Queued from ${CATALOG_PLATFORM_LABELS[answer.source.platform] ?? answer.source.platform}${answer.source.matchedBy === 'spotdl' ? ' (spotDL’s match)' : ''}. Tagged with ${embeddedText(answer.embedded)}.`;
    say({ stage: 'queued', percent: 0, words: 'Fetching… 0%', chosen });

    const until = Date.now() + WAIT_MS;
    let hash: string | null = null;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      let job: { id: string; state: string; error?: string | null; checksumSha256?: string | null; progress?: { percent?: number | null } } | undefined;
      try {
        const list = await fetch(`${base}/api/v1/downloads`, { headers: { ...auth, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
        if (!list.ok) continue;
        job = ((await list.json()) as { items?: Array<NonNullable<typeof job>> }).items?.find((j) => j.id === answer.job.id);
      } catch {
        continue;
      }
      if (!job) continue;
      if (job.state === 'failed' || job.state === 'cancelled')
        return say({ stage: 'failed', percent: null, words: `${label} could not fetch it: ${job.error ?? `the job was ${job.state}`}.`, chosen });
      const pct = typeof job.progress?.percent === 'number' ? Math.round(job.progress.percent) : null;
      if (job.state === 'completed' && job.checksumSha256) {
        hash = job.checksumSha256;
        break;
      }
      say({ stage: 'fetching', percent: pct, words: pct === null ? 'Fetching…' : `Fetching… ${pct}%`, chosen });
    }
    if (!hash) return say({ stage: 'failed', percent: null, words: `${label} is still fetching it after fifteen minutes; it will be in its downloads when it finishes.`, chosen });

    say({ stage: 'saving', percent: 100, words: 'Saving to this device…', chosen });
    let blob: Blob;
    try {
      const file = await fetch(`${base}/api/v1/files/${hash}`, { headers: auth, signal: AbortSignal.timeout(120_000) });
      if (!file.ok) return say({ stage: 'failed', percent: null, words: `${label} fetched it, but would not send it to this device: ${await problem(file)}`, chosen });
      blob = await file.blob();
    } catch {
      return say({ stage: 'failed', percent: null, words: `${label} fetched it, but the file did not reach this device.`, chosen });
    }
    const ext = sniffExtension(new Uint8Array(await blob.slice(0, 40).arrayBuffer()));
    if (!ext) return say({ stage: 'failed', percent: null, words: `${label} sent a file this player cannot read as audio.`, chosen });
    const name = `${song.artist ? `${song.artist} - ` : ''}${song.title}`.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 150) + ext;
    const kept = await tools()?.keep(new File([blob], name, { type: blob.type || 'application/octet-stream' }));
    if (!kept?.trackId) return say({ stage: 'failed', percent: null, words: kept?.reason ?? 'The file arrived, but this player could not keep it.', chosen });
    return say({ stage: 'done', percent: 100, words: 'Fetched', chosen, trackId: kept.trackId });
  }

  return {
    route,
    async fetch(song, basis, onState) {
      const say = (s: Omit<FetchState, 'trackId'> & { trackId?: string | null }): FetchState => {
        const out: FetchState = { trackId: null, ...s };
        onState(out);
        return out;
      };
      say({ stage: 'asking', percent: null, words: 'Asking…', chosen: null });
      const hub = await hubRoute();
      if (hub.ok) return viaHub(hub.acct, hub.label, song, basis, say);
      const t = tools();
      const url = webUrl(song.url);
      if (!t || !url || !(await t.detect().catch(() => null)))
        return say({ stage: 'failed', percent: null, words: `Nothing can fetch it here: ${hub.why ? `${hub.why}, and ` : ''}${NEEDED}`, chosen: null });
      // The helper fetches a page it can reach; a store-only song (Apple Music, Deezer) has none.
      const from = song.cat ? (pickDownloadSource(song.cat.sources)?.url ?? null) : url;
      if (!from) return say({ stage: 'failed', percent: null, words: 'This song is only in stores (Apple Music, Deezer): there is no copy the helper can fetch. The hub can look for one.', chosen: null });
      const chosen = `Fetching from ${hostOf(from)} with the companion on this PC.`;
      say({ stage: 'fetching', percent: null, words: 'Fetching…', chosen });
      const r = await t.fetch(from, basis, (p) => {
        if (p.percent !== null) say({ stage: 'fetching', percent: Math.round(p.percent), words: `Fetching… ${Math.round(p.percent)}%`, chosen });
      });
      if (!r.added || !r.trackId) return say({ stage: 'failed', percent: null, words: r.reason ?? 'Nothing was saved.', chosen });
      return say({ stage: 'done', percent: 100, words: 'Fetched', chosen, trackId: r.trackId });
    },
  };
}

/** The platforms a bare link can be, by host — for a row that came from a link rather than a search. */
const HOSTS: Array<[RegExp, CatalogPlatform]> = [
  [/(^|\.)music\.youtube\.com$/, 'youtube-music'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)soundcloud\.com$/, 'soundcloud'],
  [/(^|\.)bandcamp\.com$/, 'bandcamp'],
  [/(^|\.)spotify\.com$/, 'spotify'],
  [/(^|\.)deezer\.com$/, 'deezer'],
  [/(^|\.)music\.apple\.com$/, 'apple-music'],
];

/** A row that came from a link, as the catalog shape the hub's catalog/download reads. */
export function trackOf(song: VisitSong): CatalogTrack | null {
  const url = webUrl(song.url);
  if (!url) return null;
  const host = new URL(url).hostname.toLowerCase();
  const platform = HOSTS.find(([re]) => re.test(host))?.[1];
  if (!platform) return null;
  return {
    id: `${platform}:${url}`.slice(0, 260),
    title: song.title.slice(0, 300),
    artist: song.artist.slice(0, 300),
    artists: song.artist ? [song.artist.slice(0, 300)] : [],
    album: song.album ? song.album.slice(0, 300) : null,
    albumArtist: null,
    durationMs: song.duration ? Math.round(song.duration * 1000) : null,
    isrc: null,
    artworkUrl: null,
    releaseDate: null,
    year: null,
    trackNumber: null,
    discNumber: null,
    bpm: song.bpm && song.bpm > 0 ? song.bpm : null,
    explicit: null,
    genre: null,
    label: null,
    sources: [{ platform, id: null, url, previewUrl: null, matchedBy: 'link' }],
    rank: 0,
  };
}

/** What a file is from its first bytes; the hub sends it as application/octet-stream. */
export function sniffExtension(b: Uint8Array): string | null {
  const ascii = (from: number, n: number): string => String.fromCharCode(...b.slice(from, from + n));
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && b[1] !== undefined && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return '.mp3';
  if (ascii(4, 4) === 'ftyp') return '.m4a';
  if (ascii(0, 4) === 'fLaC') return '.flac';
  if (ascii(0, 4) === 'OggS') return ascii(28, 8) === 'OpusHead' ? '.opus' : '.ogg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return '.wav';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return '.webm';
  if (b[0] === 0xff && b[1] !== undefined && (b[1] & 0xf6) === 0xf0) return '.aac';
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'its page';
  }
}

async function problem(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown; message?: unknown; title?: unknown };
    const said = body.detail ?? body.message ?? body.title;
    if (typeof said === 'string' && said) return said.slice(0, 300);
  } catch {
    /* nothing readable */
  }
  return `it answered ${res.status}.`;
}
