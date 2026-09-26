import type { ProviderCapabilities, ProviderDescriptor, SearchResult } from '@now-playing/contracts';
import { BRANDING } from '@now-playing/contracts';
import { ProviderHttpError, type SafeHttpClient } from '../http.js';
import type { ProviderSearchPage, ProviderTestResult } from '../adapter.js';
import { BaseAdapter, caps, REVIEWED_AT, result } from './base.js';

const MB = 'https://musicbrainz.org/ws/2';
const HOSTS = ['musicbrainz.org', 'coverartarchive.org'];

export interface ReleaseGroup {
  releaseGroupId: string;
  title: string;
  artistName: string;
  releaseType: string;
  date: string | null;
  isReissue: boolean;
  isDeluxe: boolean;
}

interface MbRecording {
  id: string;
  title: string;
  length?: number;
  isrcs?: string[];
  'first-release-date'?: string;
  'artist-credit'?: Array<{ name: string; artist?: { id: string; name: string } }>;
  releases?: Array<{ id: string; title: string; date?: string }>;
  tags?: Array<{ name: string; count: number }>;
}

interface MbArtist {
  id: string;
  name: string;
  'sort-name'?: string;
  type?: string;
  tags?: Array<{ name: string; count: number }>;
  relations?: Array<{ type: string; url?: { resource: string } }>;
}

interface MbReleaseGroup {
  id: string;
  title: string;
  'primary-type'?: string | null;
  'secondary-types'?: string[];
  'first-release-date'?: string;
  'artist-credit'?: Array<{ name: string }>;
}

function artistCredit(r: { 'artist-credit'?: Array<{ name: string }> }): string {
  return (r['artist-credit'] ?? []).map((c) => c.name).join(', ') || 'Unknown Artist';
}

function lucene(text: string): string {
  return text.replace(/[+\-!(){}[\]^"~*?:\\/]/g, ' ').replace(/\s+/g, ' ').trim();
}


interface MbCredit { name: string; joinphrase?: string; artist: { id: string; name: string } }
interface MbRelease { id: string; title: string; date?: string; status?: string; 'release-group'?: { id: string; title: string; 'primary-type'?: string } }
interface MbRecordingRaw { id: string; title: string; length?: number; isrcs?: string[]; 'artist-credit'?: MbCredit[]; releases?: MbRelease[]; genres?: Array<{ name: string; count: number }>; tags?: Array<{ name: string; count: number }> }

/** A recording as the enrichment matcher needs it: who made it (features apart), where it was released, what it is called. */
export interface MbRecordingDetail {
  id: string;
  title: string;
  lengthMs: number | null;
  isrcs: string[];
  artistName: string;
  featuredArtists: string[];
  releaseGroupId: string | null;
  albumName: string | null;
  releaseYear: number | null;
  genres: Array<{ name: string; count: number }>;
  tags: Array<{ name: string; count: number }>;
}

const RECORDING_INC = 'artist-credits+releases+release-groups+genres+tags+isrcs';

/** The artist credit is a list joined by phrases; once a phrase says "feat." everything after it is a feature. */
function toDetail(r: MbRecordingRaw): MbRecordingDetail {
  const credits = r['artist-credit'] ?? [];
  const featured: string[] = [];
  let main = '';
  let inFeat = false;
  for (const c of credits) {
    if (inFeat) featured.push(c.name);
    else main += c.name;
    const jp = (c.joinphrase ?? '').toLowerCase();
    if (/feat|ft\.|featuring/.test(jp)) inFeat = true;
    else if (!inFeat && jp.trim()) main += c.joinphrase;
  }
  const official = (r.releases ?? []).filter((x) => x.status === 'Official' && x['release-group']?.['primary-type'] !== 'Single');
  const rel = official[0] ?? (r.releases ?? [])[0] ?? null;
  const year = rel?.date ? Number(rel.date.slice(0, 4)) : NaN;
  return {
    id: r.id,
    title: r.title,
    lengthMs: r.length ?? null,
    isrcs: r.isrcs ?? [],
    artistName: main.trim(),
    featuredArtists: featured,
    releaseGroupId: rel?.['release-group']?.id ?? null,
    albumName: rel?.['release-group']?.title ?? rel?.title ?? null,
    releaseYear: Number.isFinite(year) ? year : null,
    genres: r.genres ?? [],
    tags: r.tags ?? [],
  };
}

/** Metadata-only provider. Never an audio source; identifies recordings, artists and release groups. */
export class MusicBrainzAdapter extends BaseAdapter {
  readonly id = 'musicbrainz';

  constructor(
    private readonly http: SafeHttpClient,
    private readonly version: string,
  ) {
    super();
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'MusicBrainz', role: 'metadata-only', docsUrl: 'https://musicbrainz.org/doc/MusicBrainz_API', authType: 'none', authScopes: [], attribution: 'Data from MusicBrainz', rateStrategy: '1 request/second, single concurrency, descriptive User-Agent', cachePolicy: '24 h', groupCompatible: false, discordCompatible: false, reviewedAt: REVIEWED_AT, limitations: ['Metadata only; never streams or downloads audio', 'Requests without a contact email in the User-Agent are throttled by MusicBrainz'] };
  }

  capabilities(): ProviderCapabilities {
    return caps({ metadata: 'available', search: 'available', groupSync: 'unsupported', reason: 'MusicBrainz catalogues music; it is not an audio source' });
  }

  override requiredConfig(): readonly string[] {
    return ['contactEmail'];
  }

  override allowedHosts(): readonly string[] {
    return HOSTS;
  }

  private headers(): Record<string, string> {
    return { 'User-Agent': BRANDING.userAgent(this.version, this.config.contactEmail ?? 'unconfigured'), Accept: 'application/json' };
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${MB}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('fmt', 'json');
    return this.http.getJson<T>(url.toString(), { allowedHosts: HOSTS, headers: this.headers(), timeoutMs: 12_000 });
  }

  override async test(): Promise<ProviderTestResult> {
    const started = Date.now();
    await this.get<{ count: number }>('recording', { query: 'recording:"test"', limit: '1' });
    return { ok: true, latencyMs: Date.now() - started, message: 'MusicBrainz reachable' };
  }

  private toResult(r: MbRecording): SearchResult {
    const release = r.releases?.[0];
    const year = r['first-release-date'] ? Number(r['first-release-date'].slice(0, 4)) : release?.date ? Number(release.date.slice(0, 4)) : null;
    return result({ provider: this.id, kind: 'track', providerId: r.id, title: r.title, artistName: artistCredit(r), albumName: release?.title ?? null, durationMs: r.length ?? null, canonicalUrl: `https://musicbrainz.org/recording/${r.id}`, year: Number.isFinite(year) ? year : null, genre: r.tags?.sort((a, b) => b.count - a.count)[0]?.name ?? null, capabilities: this.capabilities(), identity: { musicbrainzRecordingId: r.id, isrc: r.isrcs?.[0] ?? null, musicbrainzReleaseId: release?.id ?? null }, attribution: 'Data from MusicBrainz', accessState: 'unsupported' });
  }

  override async search(query: string, filters: { scope: string; limit: number }, cursor: string | null): Promise<ProviderSearchPage> {
    const offset = cursor ? Number(cursor) || 0 : 0;
    const q = lucene(query);
    if (!q) return { results: [], nextCursor: null };
    if (filters.scope === 'artists') {
      const data = await this.get<{ artists: MbArtist[]; count: number }>('artist', { query: q, limit: String(filters.limit), offset: String(offset) });
      const results = data.artists.map((a) => result({ provider: this.id, kind: 'artist', providerId: a.id, title: a.name, artistName: a.name, canonicalUrl: `https://musicbrainz.org/artist/${a.id}`, genre: a.tags?.sort((x, y) => y.count - x.count)[0]?.name ?? null, capabilities: this.capabilities(), attribution: 'Data from MusicBrainz', accessState: 'unsupported' }));
      return { results, nextCursor: offset + results.length < data.count && results.length ? String(offset + results.length) : null };
    }
    const data = await this.get<{ recordings: MbRecording[]; count: number }>('recording', { query: q, limit: String(filters.limit), offset: String(offset) });
    const results = data.recordings.map((r) => this.toResult(r));
    return { results, nextCursor: offset + results.length < data.count && results.length ? String(offset + results.length) : null };
  }

  override async getMetadata(id: string): Promise<SearchResult | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = await this.get<MbRecording>(`recording/${id}`, { inc: 'artist-credits+releases+isrcs+tags' });
    return this.toResult(r);
  }

  override async resolve(urlOrId: string): Promise<SearchResult | null> {
    const m = /musicbrainz\.org\/recording\/([0-9a-f-]{36})/i.exec(urlOrId) ?? /^([0-9a-f-]{36})$/i.exec(urlOrId.trim());
    return m ? this.getMetadata(m[1]!) : null;
  }

  async findArtist(name: string): Promise<{ id: string; name: string } | null> {
    const data = await this.get<{ artists: MbArtist[] }>('artist', { query: `artist:"${lucene(name)}"`, limit: '1' });
    const a = data.artists[0];
    return a ? { id: a.id, name: a.name } : null;
  }

  async artistName(mbid: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/i.test(mbid)) return null;
    const a = await this.get<MbArtist>(`artist/${mbid}`, {});
    return a.name ?? null;
  }

  /** Release groups (albums, EPs, singles) for an artist, newest first; reissue/deluxe flags from secondary types and titles. */
  async releaseGroups(artistMbid: string, limit = 100): Promise<ReleaseGroup[]> {
    const data = await this.get<{ 'release-groups': MbReleaseGroup[] }>('release-group', { artist: artistMbid, limit: String(limit), inc: 'artist-credits' });
    return data['release-groups']
      .map((rg) => {
        const secondary = rg['secondary-types'] ?? [];
        const title = rg.title;
        return { releaseGroupId: rg.id, title, artistName: artistCredit(rg), releaseType: (rg['primary-type'] ?? 'other').toLowerCase(), date: rg['first-release-date'] || null, isReissue: secondary.includes('Compilation') || secondary.includes('Remix') || /reissue|remaster|anniversary/i.test(title), isDeluxe: /deluxe|expanded|special edition/i.test(title) };
      })
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  }

  /** URL relationship lookup, used to enrich pasted Bandcamp links without scraping the page. */
  async recordingsByIsrc(isrc: string): Promise<MbRecordingDetail[]> {
    const d = await this.get<{ recordings?: MbRecordingRaw[] }>('recording', { query: `isrc:${isrc}`, inc: RECORDING_INC, limit: '5' });
    return (d.recordings ?? []).map(toDetail);
  }

  async searchRecordings(title: string, artist: string, limit = 5): Promise<MbRecordingDetail[]> {
    const q = `recording:"${title.replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}"`;
    const d = await this.get<{ recordings?: MbRecordingRaw[] }>('recording', { query: q, inc: RECORDING_INC, limit: String(limit) });
    return (d.recordings ?? []).map(toDetail);
  }

  async recordingDetail(mbid: string): Promise<MbRecordingDetail | null> {
    const d = await this.get<MbRecordingRaw>(`recording/${encodeURIComponent(mbid)}`, { inc: RECORDING_INC }).catch((e: unknown) => {
      if (e instanceof ProviderHttpError && e.status === 404) return null;
      throw e;
    });
    return d && d.id ? toDetail(d) : null;
  }

  /** The archive's own listing, not a redirect chase: a front image means the stable front-250 address will answer. */
  async coverArtUrl(releaseGroupMbid: string): Promise<string | null> {
    const id = encodeURIComponent(releaseGroupMbid);
    const d = await this.http.getJson<{ images?: Array<{ front?: boolean }> }>(`https://coverartarchive.org/release-group/${id}`, { allowedHosts: HOSTS, headers: this.headers(), timeoutMs: 8_000 }).catch(() => null);
    return d?.images?.some((i) => i.front) ? `https://coverartarchive.org/release-group/${id}/front-250` : null;
  }

  async lookupUrl(resource: string): Promise<SearchResult | null> {
    const data = await this.get<{ relations?: Array<{ type: string; recording?: MbRecording; release?: { id: string; title: string }; artist?: { id: string; name: string } }> }>('url', { resource, inc: 'recording-rels+release-rels+artist-rels' }).catch(() => null);
    const rel = data?.relations?.find((r) => r.recording) ?? null;
    if (rel?.recording) return this.toResult(rel.recording);
    const artist = data?.relations?.find((r) => r.artist)?.artist;
    if (artist) return result({ provider: this.id, kind: 'artist', providerId: artist.id, title: artist.name, artistName: artist.name, canonicalUrl: `https://musicbrainz.org/artist/${artist.id}`, capabilities: this.capabilities(), attribution: 'Data from MusicBrainz', accessState: 'unsupported' });
    return null;
  }

  async relatedArtistUrls(artistMbid: string): Promise<Array<{ type: string; url: string }>> {
    const a = await this.get<MbArtist>(`artist/${artistMbid}`, { inc: 'url-rels' });
    return (a.relations ?? []).filter((r) => r.url?.resource).map((r) => ({ type: r.type, url: r.url!.resource }));
  }
}
