# Hub Enrichment (album, genre, BPM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every track the hub sees — from a pasted YouTube/SoundCloud/Spotify link, a search result or a companion sync — gets its real album, featured artists, cover, a weighted genre profile and a BPM, filled from open sources and stored once in `canonical_tracks`, and the recommender learns from genre profile and tempo.

**Architecture:** A new `docker-container/src/enrichment/` module with a matcher (MusicBrainz by ISRC → by id → by cleaned title+artist gated on duration), a filler (Cover Art Archive, genre profile, BPM chain: Deezer → AcousticBrainz → tag → preview-clip analysis) and a job handler that rides the existing `discovery_jobs` queue and `JobScheduler`. `search-service` and `library/service` call it; nothing else does. Three new metadata-only adapters (`deezer`, `acousticbrainz`, `lastfm`) follow the `BaseAdapter` pattern. Tempo estimation is plain TypeScript in `packages/audio-core` so the browser and the companion reuse it later.

**Tech Stack:** TypeScript 6, Node 22, Fastify, better-sqlite3, Zod (contracts), Vitest, the hub's `SafeHttpClient` + `RateLimitManager`, ffmpeg (already in the image) for clip decoding.

**Spec:** `docs/superpowers/specs/2026-09-26-metadata-enrichment-and-preview-design.md` (sub-project 1; the `tempo.ts` estimator from sub-project 3 is built here because sub-project 1 needs it).

## Global Constraints

- No audio is ever fetched from YouTube or Spotify streams; only preview clips from these hosts: `audio-ssl.itunes.apple.com`, `p.scdn.co`, `cf-media.sndcdn.com`, `cf-hls-media.sndcdn.com`.
- Every outbound call goes through `SafeHttpClient` with an explicit `allowedHosts` list and through `RateLimitManager.run(provider, priority, fn)`.
- MusicBrainz: ≤ 1 request/s, descriptive User-Agent with contact (already in `MusicBrainzAdapter.headers()`); a 429 pauses the whole queue for `Retry-After`.
- Nothing is guessed: a match below confidence 0.5 fills nothing and leaves `matchConfidence` as measured.
- `/search` and `/providers/resolve` responses must not wait on enrichment beyond 200 ms; slow work is queued.
- Fix-forward only; never push; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `pnpm verify` green before the sub-project's final commit; `docs/PROVIDER_CAPABILITIES.md` gains a row per new provider.

## Review Focus

1. A YouTube title like `Artist - Song (feat. X) [Official Video]` from a channel that is *not* `- Topic` must yield artist `Artist`, title `Song`, features `[X]` — never the channel name as artist. Pinned in Task 4.
2. A SoundCloud result with an ISRC that MusicBrainz does not know must fall through to the title path, not stop. Pinned in Task 7.
3. Two different recordings with the same title and artist (a live version 40 s longer) must not be merged: the duration gate rejects it. Pinned in Task 7.
4. Deezer answering `bpm: 0` means unknown; it must not be stored as 0 and must not block AcousticBrainz. Pinned in Task 5.
5. A preview clip larger than 4 MB, a non-audio body, or ffmpeg absent must leave `bpm` null with `bpmSource` null and the job finished, not failed forever. Pinned in Task 10.

---

### Task 1: Contract fields and provider ids

**Files:**
- Modify: `packages/contracts/src/entities/canonical.ts`
- Modify: `packages/contracts/src/entities/library.ts` (the `Track` object, near line 86 `bpm`)
- Modify: `packages/contracts/src/api/routes.ts:131-152` (`SearchResultBase`)
- Modify: `packages/contracts/src/entities/jobs.ts:94` (`DiscoveryJob.kind`)
- Modify: `packages/contracts/src/common.ts:49` (`KNOWN_PROVIDERS`)
- Test: `packages/contracts/tests/enrichment-fields.test.ts`

**Interfaces:**
- Produces: `BpmSource = 'tag' | 'deezer' | 'acousticbrainz' | 'preview-analysis' | 'analysis'`; `GenreProfile = Record<string, number>`; `CanonicalTrack` += `featuredArtists: string[]`, `genreProfile: GenreProfile`, `bpm: number | null`, `bpmSource: BpmSource | null`, `artworkUrl: string | null`, `matchConfidence: number | null`, `enrichedAt: IsoDateTime | null`; `Track` += `featuredArtists`, `genreProfile`, `bpmSource`; `SearchResultBase` += `featuredArtists`, `genres`, `genreProfile`, `bpm`, `bpmSource`; `TrackIdentity` += `matchConfidence: number | null`; `DiscoveryJob.kind` += `'enrich-track'`; `KNOWN_PROVIDERS` += `'deezer' | 'acousticbrainz' | 'lastfm'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/tests/enrichment-fields.test.ts
import { describe, expect, it } from 'vitest';
import { CanonicalTrack, DiscoveryJob, KNOWN_PROVIDERS, SearchResultBase, Track } from '../src/index.js';

describe('enrichment fields', () => {
  it('canonical tracks default the new fields honestly', () => {
    const t = CanonicalTrack.parse({ id: '0190f9a0-0000-7000-8000-000000000001', title: 'A', normalizedTitle: 'a', artistName: 'B', normalizedArtist: 'b', createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z' });
    expect(t.featuredArtists).toEqual([]);
    expect(t.genreProfile).toEqual({});
    expect(t.bpm).toBeNull();
    expect(t.bpmSource).toBeNull();
    expect(t.artworkUrl).toBeNull();
    expect(t.matchConfidence).toBeNull();
    expect(t.enrichedAt).toBeNull();
  });
  it('rejects a bpm source outside the known set', () => {
    expect(() => Track.parse({ ...minimalTrack(), bpmSource: 'guess' })).toThrow();
  });
  it('search results carry bpm and profile, defaulting to unknown', () => {
    const r = SearchResultBase.parse(minimalResult());
    expect(r.bpm).toBeNull(); expect(r.genreProfile).toEqual({}); expect(r.featuredArtists).toEqual([]); expect(r.identity.matchConfidence).toBeNull();
  });
  it('knows the three new metadata providers and the enrich-track job', () => {
    expect(KNOWN_PROVIDERS).toEqual(expect.arrayContaining(['deezer', 'acousticbrainz', 'lastfm']));
    expect(DiscoveryJob.shape.kind.options).toContain('enrich-track');
  });
});
```
`minimalTrack()` / `minimalResult()` return the smallest objects the existing schemas accept — copy the shapes used in `packages/contracts/tests/*.test.ts` today (look for an existing `Track.parse({...})` fixture and reuse it).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @now-playing/contracts test -- enrichment-fields`
Expected: FAIL — `featuredArtists` undefined, `KNOWN_PROVIDERS` missing `deezer`.

- [ ] **Step 3: Add the fields**

```ts
// packages/contracts/src/entities/canonical.ts — add above CanonicalTrack
export const BpmSource = z.enum(['tag', 'deezer', 'acousticbrainz', 'preview-analysis', 'analysis']);
export type BpmSource = z.infer<typeof BpmSource>;
export const GenreProfile = z.record(z.string().max(60), z.number().min(0).max(1));
export type GenreProfile = z.infer<typeof GenreProfile>;
// inside CanonicalTrack, after tags:
  featuredArtists: z.array(z.string().max(300)).default([]),
  genreProfile: GenreProfile.default({}),
  bpm: z.number().positive().max(400).nullable().default(null),
  bpmSource: BpmSource.nullable().default(null),
  artworkUrl: z.string().url().nullable().default(null),
  matchConfidence: z.number().min(0).max(1).nullable().default(null),
  enrichedAt: IsoDateTime.nullable().default(null),
```
```ts
// packages/contracts/src/entities/library.ts — in TrackIdentity add
  matchConfidence: z.number().min(0).max(1).nullable().default(null),
// in Track, after bpm:
  bpmSource: BpmSource.nullable().default(null),
  featuredArtists: z.array(z.string().max(300)).default([]),
  genreProfile: GenreProfile.default({}),
```
(import `BpmSource`, `GenreProfile` from `./canonical.js`; if that creates an import cycle, move the two schemas to `packages/contracts/src/common.ts` and import from there in both files.)
```ts
// packages/contracts/src/api/routes.ts — in SearchResultBase after genre:
  genres: z.array(z.string().max(60)).default([]),
  genreProfile: GenreProfile.default({}),
  featuredArtists: z.array(z.string().max(300)).default([]),
  bpm: z.number().positive().max(400).nullable().default(null),
  bpmSource: BpmSource.nullable().default(null),
```
```ts
// packages/contracts/src/entities/jobs.ts:94
  kind: z.enum(['profile-refresh', 'discover-seeds', 'sync-library', 'token-refresh', 'new-releases', 'enrich-track']),
```
```ts
// packages/contracts/src/common.ts KNOWN_PROVIDERS — append before `] as const;`
  'deezer',
  'acousticbrainz',
  'lastfm',
```
Also update the `ProviderId` describe string to list them, and export the new schemas from `packages/contracts/src/index.ts` if entities are re-exported explicitly there.

- [ ] **Step 4: Run the contracts tests and the whole typecheck**

Run: `pnpm --filter @now-playing/contracts test && pnpm typecheck`
Expected: PASS. If `typecheck` fails in `music-player/src/lib/platforms.ts` ("a platform appears in one and not the others" — its unit test), add rows for the three providers in `PLATFORMS` there with `play/keep/save: NO('Metadata only: no audio')`, `bringIn: null`, `needsHub: true`, and matching entries in `PROVIDER_MARKS` and `docs/PROVIDER_CAPABILITIES.md` (Task 12 writes the doc rows; add the code rows now).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/domain music-player/src/lib/platforms.ts packages/aqua-ui
git commit -m "contracts: album, featured artists, genre profile and bpm fields; deezer, acousticbrainz and lastfm as metadata providers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration and canonical repository columns

**Files:**
- Create: `docker-container/migrations/0007_enrichment.sql`
- Modify: `docker-container/src/db/repositories/canonical.ts:189-215` (`upsertTrack`, row mapping)
- Test: `docker-container/tests/integration/enrichment-storage.test.ts`

**Interfaces:**
- Consumes: `CanonicalTrack` from Task 1.
- Produces: `CanonicalRepository.upsertTrack(track)` persists the new fields; `findTrackById/ByMbid/ByIsrc/ByNormalized` return them; new `CanonicalRepository.tracksNeedingEnrichment(limit: number): CanonicalTrack[]` (rows with `enriched_at IS NULL`).

- [ ] **Step 1: Write the failing test**

```ts
// docker-container/tests/integration/enrichment-storage.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';

describe('canonical tracks keep enrichment', () => {
  let hub: TestHub;
  beforeEach(async () => { hub = await createTestHub(); });
  afterEach(async () => { await hub.close(); });

  it('round-trips album, features, profile, bpm, artwork and confidence', () => {
    const now = '2026-09-26T00:00:00.000Z';
    hub.ctx.repos.canonical.upsertTrack({
      id: '0190f9a0-0000-7000-8000-00000000aa01', musicbrainzRecordingId: null, isrc: 'USUM71703861', title: 'Song', normalizedTitle: 'song',
      artistId: null, artistName: 'Artist', normalizedArtist: 'artist', albumId: null, albumName: 'Album', releaseYear: 2017, durationMs: 200_000,
      genres: ['hip hop'], tags: ['summer'], popularity: null, createdAt: now, updatedAt: now,
      featuredArtists: ['Guest'], genreProfile: { 'hip hop': 0.7, trap: 0.3 }, bpm: 98, bpmSource: 'deezer', artworkUrl: 'https://coverartarchive.org/release-group/x/front-250', matchConfidence: 0.92, enrichedAt: now,
    });
    const back = hub.ctx.repos.canonical.findTrackByIsrc('USUM71703861');
    expect(back?.featuredArtists).toEqual(['Guest']);
    expect(back?.genreProfile).toEqual({ 'hip hop': 0.7, trap: 0.3 });
    expect(back?.bpm).toBe(98); expect(back?.bpmSource).toBe('deezer');
    expect(back?.artworkUrl).toContain('coverartarchive'); expect(back?.matchConfidence).toBe(0.92); expect(back?.enrichedAt).toBe(now);
  });
  it('lists tracks that were never enriched, oldest first', () => {
    // two rows, one enriched; expect only the other back
    // (build both with upsertTrack as above, enrichedAt null on one)
    expect(hub.ctx.repos.canonical.tracksNeedingEnrichment(10).map((t) => t.id)).toEqual(['<the un-enriched id>']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @now-playing/hub test:integration -- enrichment-storage`
Expected: FAIL — `no such column: featured_artists`.

- [ ] **Step 3: Write the migration and the mapping**

```sql
-- docker-container/migrations/0007_enrichment.sql
ALTER TABLE canonical_tracks ADD COLUMN featured_artists TEXT NOT NULL DEFAULT '[]';
ALTER TABLE canonical_tracks ADD COLUMN genre_profile TEXT NOT NULL DEFAULT '{}';
ALTER TABLE canonical_tracks ADD COLUMN bpm REAL;
ALTER TABLE canonical_tracks ADD COLUMN bpm_source TEXT;
ALTER TABLE canonical_tracks ADD COLUMN artwork_url TEXT;
ALTER TABLE canonical_tracks ADD COLUMN match_confidence REAL;
ALTER TABLE canonical_tracks ADD COLUMN enriched_at TEXT;
CREATE INDEX IF NOT EXISTS idx_canonical_tracks_enriched ON canonical_tracks(enriched_at);
```
In `canonical.ts`: extend the `INSERT INTO canonical_tracks (...)` statement in `upsertTrack` with the seven columns (JSON-stringify `featuredArtists` and `genreProfile`), extend its `ON CONFLICT ... DO UPDATE SET` list the same way, and extend the row→track mapping function used by `findTrackById` etc. (search for where `genres: JSON.parse(row.genres)` happens and add the seven fields beside it, parsing the two JSON columns and passing `bpm`, `bpm_source`, `artwork_url`, `match_confidence`, `enriched_at` through with `?? null`). Add:
```ts
  tracksNeedingEnrichment(limit: number): CanonicalTrack[] {
    return this.db.prepare('SELECT * FROM canonical_tracks WHERE enriched_at IS NULL ORDER BY created_at ASC LIMIT ?').all(limit).map((r) => this.rowToTrack(r as CanonicalRow));
  }
```
(use whatever the existing row-mapping function is called; keep its name).

- [ ] **Step 4: Run the test and the existing canonical tests**

Run: `pnpm --filter @now-playing/hub test:integration -- enrichment-storage canonical`
Expected: PASS, and no existing test changes.

- [ ] **Step 5: Commit**

```bash
git add docker-container/migrations/0007_enrichment.sql docker-container/src/db/repositories/canonical.ts docker-container/tests/integration/enrichment-storage.test.ts
git commit -m "hub: canonical tracks store featured artists, genre profile, bpm, artwork and match confidence (migration 0007)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Genre vocabulary and profile merge (`packages/domain`)

**Files:**
- Create: `packages/domain/src/genres.ts`
- Modify: `packages/domain/src/index.ts` (export)
- Test: `packages/domain/tests/genres.test.ts`

**Interfaces:**
- Produces: `GENRE_PARENTS: Record<string, string | null>` (≈120 MusicBrainz genres → parent or null); `mapGenreLabel(label: string): { genre: string; parent: string | null } | null`; `mergeGenreProfile(votes: Array<{ label: string; weight: number }>): GenreProfile` (normalised to sum 1, parent gets +0.5·child, unknown labels dropped, top 6 kept); `topGenre(profile: GenreProfile): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/tests/genres.test.ts
import { describe, expect, it } from 'vitest';
import { mapGenreLabel, mergeGenreProfile, topGenre } from '../src/genres.js';

describe('genre vocabulary', () => {
  it.each([
    ['Hip-Hop', 'hip hop'], ['hiphop', 'hip hop'], ['Rap/Hip-Hop', 'hip hop'], ['R&B', 'r&b'], ['RnB', 'r&b'],
    ['Drum & Bass', 'drum and bass'], ['DnB', 'drum and bass'], ['Alt Rock', 'alternative rock'], ['EDM', 'electronic'],
  ])('maps %s to %s', (label, genre) => {
    expect(mapGenreLabel(label)?.genre).toBe(genre);
  });
  it('knows parents', () => {
    expect(mapGenreLabel('trap')).toEqual({ genre: 'trap', parent: 'hip hop' });
    expect(mapGenreLabel('rock')).toEqual({ genre: 'rock', parent: null });
  });
  it('drops labels it does not know', () => {
    expect(mapGenreLabel('summer vibes 2019')).toBeNull();
  });
  it('merges votes into a profile that sums to one, rolling half of a child into its parent', () => {
    const p = mergeGenreProfile([{ label: 'trap', weight: 1 }, { label: 'Hip-Hop', weight: 1 }, { label: 'summer', weight: 1 }]);
    expect(Object.values(p).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(p['hip hop']).toBeGreaterThan(p['trap']!);
    expect(p['summer']).toBeUndefined();
  });
  it('keeps at most six genres and names the top one', () => {
    const votes = ['rock', 'pop', 'jazz', 'blues', 'soul', 'funk', 'disco', 'house'].map((label, i) => ({ label, weight: 8 - i }));
    const p = mergeGenreProfile(votes);
    expect(Object.keys(p)).toHaveLength(6);
    expect(topGenre(p)).toBe('rock');
    expect(topGenre({})).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @now-playing/domain test -- genres`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/domain/src/genres.ts
/**
 * One fixed genre vocabulary — MusicBrainz's genre list, parents first — so that every source's
 * free text ("Hip-Hop", "hiphop", "rap/hip-hop") lands on one key the recommender can compare.
 * Unknown labels are not genres; they belong in tags.
 */
export type GenreProfile = Record<string, number>;

/** genre → parent (null for a top-level genre). Keys are the canonical lower-case names. */
export const GENRE_PARENTS: Record<string, string | null> = {
  // top level
  'hip hop': null, 'r&b': null, rock: null, pop: null, electronic: null, jazz: null, blues: null, soul: null, funk: null, disco: null,
  country: null, folk: null, classical: null, metal: null, punk: null, reggae: null, latin: null, world: null, 'spoken word': null, ambient: null,
  // children (a representative set; extend from https://musicbrainz.org/genres)
  trap: 'hip hop', drill: 'hip hop', 'boom bap': 'hip hop', grime: 'hip hop', 'conscious hip hop': 'hip hop',
  'neo soul': 'soul', 'contemporary r&b': 'r&b', 'alternative r&b': 'r&b',
  'alternative rock': 'rock', 'indie rock': 'rock', 'classic rock': 'rock', 'hard rock': 'rock', 'progressive rock': 'rock', 'psychedelic rock': 'rock', shoegaze: 'rock', grunge: 'rock',
  'indie pop': 'pop', 'synth-pop': 'pop', 'dance-pop': 'pop', 'k-pop': 'pop', 'dream pop': 'pop',
  house: 'electronic', techno: 'electronic', trance: 'electronic', 'drum and bass': 'electronic', dubstep: 'electronic', 'uk garage': 'electronic', idm: 'electronic', 'downtempo': 'electronic', 'lo-fi': 'electronic', 'deep house': 'house', 'tech house': 'house',
  'smooth jazz': 'jazz', bebop: 'jazz', 'jazz fusion': 'jazz',
  'heavy metal': 'metal', 'death metal': 'metal', 'black metal': 'metal', metalcore: 'metal',
  'pop punk': 'punk', 'post-punk': 'punk', hardcore: 'punk',
  dancehall: 'reggae', dub: 'reggae', reggaeton: 'latin', salsa: 'latin', bachata: 'latin', afrobeats: 'world', 'bossa nova': 'latin',
  'singer-songwriter': 'folk', americana: 'country', bluegrass: 'country',
  gospel: 'soul', 'new age': 'ambient',
};

/** Spellings and abbreviations that mean a vocabulary entry. Keys are lower-case, punctuation collapsed. */
const ALIASES: Record<string, string> = {
  'hiphop': 'hip hop', 'hip-hop': 'hip hop', 'rap': 'hip hop', 'rap hip hop': 'hip hop', 'rap/hip-hop': 'hip hop',
  'rnb': 'r&b', 'r n b': 'r&b', 'rhythm and blues': 'r&b',
  'dnb': 'drum and bass', 'drum & bass': 'drum and bass', 'drum n bass': 'drum and bass', 'd&b': 'drum and bass',
  'alt rock': 'alternative rock', 'alternative': 'alternative rock', 'indie': 'indie rock',
  'edm': 'electronic', 'electronica': 'electronic', 'dance': 'electronic', 'electro': 'electronic',
  'synthpop': 'synth-pop', 'lofi': 'lo-fi', 'lo fi': 'lo-fi', 'chillout': 'downtempo', 'chill': 'downtempo',
  'kpop': 'k-pop', 'latin pop': 'latin', 'afrobeat': 'afrobeats', 'afro beats': 'afrobeats',
  'metal': 'metal', 'hardrock': 'hard rock',
};

function key(label: string): string {
  return label.toLowerCase().replace(/[_]+/g, ' ').replace(/\s*[/,]\s*/g, '/').replace(/\s+/g, ' ').trim();
}

export function mapGenreLabel(label: string): { genre: string; parent: string | null } | null {
  const k = key(label);
  const candidates = [k, k.replace(/\//g, ' '), k.replace(/-/g, ' '), ...k.split('/')];
  for (const c of candidates) {
    const g = ALIASES[c] ?? (c in GENRE_PARENTS ? c : null);
    if (g) return { genre: g, parent: GENRE_PARENTS[g] ?? null };
  }
  return null;
}

export function mergeGenreProfile(votes: ReadonlyArray<{ label: string; weight: number }>): GenreProfile {
  const acc = new Map<string, number>();
  for (const v of votes) {
    if (!(v.weight > 0)) continue;
    const m = mapGenreLabel(v.label);
    if (!m) continue;
    acc.set(m.genre, (acc.get(m.genre) ?? 0) + v.weight);
    if (m.parent) acc.set(m.parent, (acc.get(m.parent) ?? 0) + v.weight * 0.5);
  }
  const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const sum = top.reduce((s, [, w]) => s + w, 0);
  const out: GenreProfile = {};
  for (const [g, w] of top) out[g] = Math.round((w / sum) * 1e4) / 1e4;
  return out;
}

export function topGenre(profile: GenreProfile): string | null {
  let best: string | null = null;
  for (const [g, w] of Object.entries(profile)) if (best === null || w > profile[best]!) best = g;
  return best;
}
```
Export from `packages/domain/src/index.ts`: `export * from './genres.js';`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @now-playing/domain test -- genres`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/genres.ts packages/domain/src/index.ts packages/domain/tests/genres.test.ts
git commit -m "domain: one genre vocabulary, label mapping and a weighted profile merge

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Video-title cleaning and featured-artist extraction (`packages/domain`)

**Files:**
- Create: `packages/domain/src/titles.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/tests/titles.test.ts`

**Interfaces:**
- Produces: `splitFeatured(title: string): { title: string; featured: string[] }`; `cleanVideoTitle(input: { title: string; channel: string | null }): { title: string; artist: string | null; featured: string[]; fromTopicChannel: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/tests/titles.test.ts
import { describe, expect, it } from 'vitest';
import { cleanVideoTitle, splitFeatured } from '../src/titles.js';

describe('splitFeatured', () => {
  it.each([
    ['Song (feat. Guest)', 'Song', ['Guest']],
    ['Song ft. A & B', 'Song', ['A', 'B']],
    ['Song (featuring A, B and C)', 'Song', ['A', 'B', 'C']],
    ['Song [Feat. Guest]', 'Song', ['Guest']],
    ['Song', 'Song', []],
  ])('%s', (input, title, featured) => {
    expect(splitFeatured(input)).toEqual({ title, featured });
  });
});

describe('cleanVideoTitle', () => {
  it.each([
    [{ title: 'Artist - Song (feat. X) [Official Video]', channel: 'SomeLabelVEVO' }, { artist: 'Artist', title: 'Song', featured: ['X'] }],
    [{ title: 'Song (Official Music Video)', channel: 'Artist - Topic' }, { artist: 'Artist', title: 'Song', featured: [] }],
    [{ title: 'Artist – Song (Lyrics) HD', channel: 'LyricsChannel' }, { artist: 'Artist', title: 'Song', featured: [] }],
    [{ title: 'Artist "Song" (Official Audio) 4K', channel: 'Artist' }, { artist: 'Artist', title: 'Song', featured: [] }],
    [{ title: 'Song | Artist', channel: 'Music Weekly' }, { artist: 'Artist', title: 'Song', featured: [] }],
    [{ title: 'Just A Title', channel: 'Random Channel' }, { artist: null, title: 'Just A Title', featured: [] }],
  ])('%j', (input, expected) => {
    const out = cleanVideoTitle(input);
    expect({ artist: out.artist, title: out.title, featured: out.featured }).toEqual(expected);
  });
  it('says when the artist came from a Topic channel', () => {
    expect(cleanVideoTitle({ title: 'Song', channel: 'Artist - Topic' }).fromTopicChannel).toBe(true);
    expect(cleanVideoTitle({ title: 'Artist - Song', channel: 'X' }).fromTopicChannel).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @now-playing/domain test -- titles`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/domain/src/titles.ts
/**
 * What a video title is trying to say. Uploaders write "Artist - Song (feat. X) [Official Video]";
 * the parts in brackets are about the video, the dash separates artist from song, and features
 * belong to the recording. Every rule here is a regex a person can read, and a title that fits none
 * of them is returned as it was, with artist null — never a guess.
 */
const NOISE = /\s*[\[(]\s*(official\s*(music\s*)?(video|audio|lyric\s*video|visualizer)|lyrics?|audio|visualizer|hd|hq|4k|explicit|clean|remaster(ed)?(\s*\d{4})?|prod\.?\s+by[^\])]*|music\s*video|mv|m\/v)\s*[\])]/gi;
const TRAILING_NOISE = /\s+(hd|hq|4k|official\s+video|official\s+audio|lyrics)\s*$/i;
const FEAT = /\s*[\[(]?\s*(?:feat\.?|ft\.?|featuring)\s+([^\])]+?)\s*[\])]?\s*$/i;
const FEAT_INLINE = /\s*[\[(]\s*(?:feat\.?|ft\.?|featuring)\s+([^\])]+)\s*[\])]/i;

function splitNames(s: string): string[] {
  return s.split(/\s*(?:,|&|\band\b|\+)\s*/i).map((n) => n.trim()).filter(Boolean);
}

export function splitFeatured(title: string): { title: string; featured: string[] } {
  let t = title;
  const m = t.match(FEAT_INLINE) ?? t.match(FEAT);
  if (!m) return { title: t.trim(), featured: [] };
  t = t.replace(m[0], '').trim();
  return { title: t, featured: splitNames(m[1]!) };
}

export function cleanVideoTitle(input: { title: string; channel: string | null }): { title: string; artist: string | null; featured: string[]; fromTopicChannel: boolean } {
  let raw = input.title.replace(NOISE, ' ').replace(TRAILING_NOISE, '').replace(/\s+/g, ' ').trim();
  const { title: noFeat, featured } = splitFeatured(raw);
  raw = noFeat;
  const topic = input.channel?.match(/^(.+?)\s+-\s+Topic$/);
  if (topic) return { title: raw.replace(/^["“](.+)["”]$/, '$1'), artist: topic[1]!.trim(), featured, fromTopicChannel: true };
  const dash = raw.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) return { title: dash[2]!.replace(/^["“](.+)["”]$/, '$1').trim(), artist: dash[1]!.trim(), featured, fromTopicChannel: false };
  const quoted = raw.match(/^(.+?)\s+["“](.+)["”]$/);
  if (quoted) return { title: quoted[2]!.trim(), artist: quoted[1]!.trim(), featured, fromTopicChannel: false };
  const pipe = raw.match(/^(.+?)\s+\|\s+(.+)$/);
  if (pipe) return { title: pipe[1]!.trim(), artist: pipe[2]!.trim(), featured, fromTopicChannel: false };
  return { title: raw, artist: null, featured, fromTopicChannel: false };
}
```
Export from `index.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @now-playing/domain test -- titles`
Expected: PASS (adjust the regexes until the table passes; do not weaken the table).

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/titles.ts packages/domain/src/index.ts packages/domain/tests/titles.test.ts
git commit -m "domain: read artist, song and featured artists out of a video title without guessing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Deezer, AcousticBrainz and Last.fm adapters

**Files:**
- Create: `docker-container/src/providers/adapters/deezer.ts`, `acousticbrainz.ts`, `lastfm.ts`
- Modify: `docker-container/src/app.ts:150-156` (register)
- Test: `docker-container/tests/integration/metadata-adapters.test.ts`

**Interfaces:**
- Consumes: `BaseAdapter`, `caps`, `healthy` from `adapters/base.ts`; `SafeHttpClient.getJson<T>(url, { allowedHosts, headers?, timeoutMs })`.
- Produces: `DeezerAdapter.bpmByIsrc(isrc): Promise<{ bpm: number; durationMs: number | null } | null>`; `DeezerAdapter.bpmBySearch(artist, title, durationMs | null): Promise<{ bpm: number } | null>` (duration gate ± 3 s); `AcousticBrainzAdapter.bpmByMbid(mbid): Promise<number | null>`; `LastFmAdapter.topTags(artist, title): Promise<Array<{ name: string; count: number }>>` (track tags, falling back to artist tags; `[]` when no `apiKey`). Each registers with `descriptor().role = 'metadata-only'` and `capabilities()` = `caps({ metadata: 'available' })`.

- [ ] **Step 1: Write the failing test**

```ts
// docker-container/tests/integration/metadata-adapters.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';
import type { DeezerAdapter } from '../../src/providers/adapters/deezer.js';
import type { AcousticBrainzAdapter } from '../../src/providers/adapters/acousticbrainz.js';
import type { LastFmAdapter } from '../../src/providers/adapters/lastfm.js';

describe('metadata adapters', () => {
  let hub: TestHub;
  beforeEach(async () => { hub = await createTestHub(); });
  afterEach(async () => { await hub.close(); });

  it('deezer: bpm by isrc, and 0 means unknown', async () => {
    const deezer = hub.ctx.providers.get('deezer') as DeezerAdapter;
    hub.fetch.on('api.deezer.com/track/isrc:USUM71703861', () => ({ body: { id: 1, bpm: 98.2, duration: 200 } }));
    expect(await deezer.bpmByIsrc('USUM71703861')).toEqual({ bpm: 98, durationMs: 200_000 });
    hub.fetch.on('api.deezer.com/track/isrc:ZERO', () => ({ body: { id: 2, bpm: 0, duration: 180 } }));
    expect(await deezer.bpmByIsrc('ZERO')).toBeNull();
  });
  it('deezer: search is gated on duration', async () => {
    const deezer = hub.ctx.providers.get('deezer') as DeezerAdapter;
    hub.fetch.on('api.deezer.com/search', () => ({ body: { data: [{ id: 7, duration: 240, title: 'Song', artist: { name: 'Artist' } }] } }));
    hub.fetch.on('api.deezer.com/track/7', () => ({ body: { id: 7, bpm: 120 } }));
    expect(await deezer.bpmBySearch('Artist', 'Song', 200_000)).toBeNull(); // 40 s off
    expect(await deezer.bpmBySearch('Artist', 'Song', 241_000)).toEqual({ bpm: 120 });
  });
  it('acousticbrainz: reads rhythm.bpm and treats 404 as unknown', async () => {
    const ab = hub.ctx.providers.get('acousticbrainz') as AcousticBrainzAdapter;
    hub.fetch.on('acousticbrainz.org/api/v1/aaaaaaaa-0000-4000-8000-000000000001/low-level', () => ({ body: { rhythm: { bpm: 174.3 } } }));
    expect(await ab.bpmByMbid('aaaaaaaa-0000-4000-8000-000000000001')).toBe(174);
    hub.fetch.on('acousticbrainz.org/api/v1/aaaaaaaa-0000-4000-8000-000000000002/low-level', () => ({ status: 404, body: {} }));
    expect(await ab.bpmByMbid('aaaaaaaa-0000-4000-8000-000000000002')).toBeNull();
  });
  it('lastfm: no key means no tags and no request', async () => {
    const lastfm = hub.ctx.providers.get('lastfm') as LastFmAdapter;
    expect(await lastfm.topTags('Artist', 'Song')).toEqual([]);
    expect(hub.fetch.calls.filter((c) => c.url.includes('audioscrobbler'))).toHaveLength(0);
  });
  it('lastfm: with a key, track tags first, artist tags as the fallback', async () => {
    const lastfm = hub.ctx.providers.get('lastfm') as LastFmAdapter;
    lastfm.configure({ ...lastfm.currentConfig(), apiKey: 'k' });
    hub.fetch.on('method=track.gettoptags', () => ({ body: { toptags: { tag: [] } } }));
    hub.fetch.on('method=artist.gettoptags', () => ({ body: { toptags: { tag: [{ name: 'hip-hop', count: 100 }, { name: 'seen live', count: 5 }] } } }));
    expect(await lastfm.topTags('Artist', 'Song')).toEqual([{ name: 'hip-hop', count: 100 }, { name: 'seen live', count: 5 }]);
  });
});
```
If `BaseAdapter` has no `currentConfig()`, add `protected config: ProviderRuntimeConfig` access via a small public getter in `LastFmAdapter` only.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @now-playing/hub test:integration -- metadata-adapters`
Expected: FAIL — modules not found / provider not registered.

- [ ] **Step 3: Implement the three adapters**

```ts
// docker-container/src/providers/adapters/deezer.ts
import type { ProviderCapabilities, ProviderDescriptor } from '@now-playing/contracts';
import type { SafeHttpClient } from '../http.js';
import { BaseAdapter, caps, REVIEWED_AT } from './base.js';

/** Deezer's public API: the one keyless source that publishes a tempo. bpm 0 means "not measured". */
const API = 'https://api.deezer.com';
const HOSTS = ['api.deezer.com'];
interface DzTrack { id: number; bpm?: number; duration?: number; title?: string; artist?: { name: string } }

export class DeezerAdapter extends BaseAdapter {
  readonly id = 'deezer';
  constructor(private readonly http: SafeHttpClient) { super(); }
  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'Deezer (tempo)', role: 'metadata-only', docsUrl: 'https://developers.deezer.com/api', authKind: 'none', reviewedAt: REVIEWED_AT, attribution: 'Tempo data from Deezer' };
  }
  capabilities(): ProviderCapabilities { return caps({ metadata: 'available', reason: 'Tempo and duration only; never audio' }); }
  override allowedHosts(): readonly string[] { return HOSTS; }
  private get<T>(path: string): Promise<T> { return this.http.getJson<T>(`${API}/${path}`, { allowedHosts: HOSTS, timeoutMs: 8_000 }); }

  async bpmByIsrc(isrc: string): Promise<{ bpm: number; durationMs: number | null } | null> {
    const t = await this.get<DzTrack & { error?: unknown }>(`track/isrc:${encodeURIComponent(isrc)}`).catch(() => null);
    if (!t || t.error || !(t.bpm && t.bpm > 0)) return null;
    return { bpm: Math.round(t.bpm), durationMs: t.duration && t.duration > 0 ? t.duration * 1000 : null };
  }
  async bpmBySearch(artist: string, title: string, durationMs: number | null): Promise<{ bpm: number } | null> {
    const q = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
    const page = await this.get<{ data?: DzTrack[] }>(`search?limit=3&q=${q}`).catch(() => null);
    const hit = (page?.data ?? []).find((d) => durationMs === null || !d.duration || Math.abs(d.duration * 1000 - durationMs) <= 3000);
    if (!hit) return null;
    const t = await this.get<DzTrack>(`track/${hit.id}`).catch(() => null);
    return t && t.bpm && t.bpm > 0 ? { bpm: Math.round(t.bpm) } : null;
  }
}
```
Copy the descriptor field names from `YouTubeAdapter.descriptor()` exactly (the object above uses the field names seen in `soundcloud.ts:44`; if `authKind`/`reviewedAt` differ, match the existing adapters).

```ts
// docker-container/src/providers/adapters/acousticbrainz.ts
const API = 'https://acousticbrainz.org/api/v1';
const HOSTS = ['acousticbrainz.org'];
export class AcousticBrainzAdapter extends BaseAdapter {
  readonly id = 'acousticbrainz';
  constructor(private readonly http: SafeHttpClient) { super(); }
  descriptor() { return { provider: this.id, displayName: 'AcousticBrainz (tempo archive)', role: 'metadata-only' as const, docsUrl: 'https://acousticbrainz.org/data', authKind: 'none' as const, reviewedAt: REVIEWED_AT, attribution: 'AcousticBrainz (CC0)' }; }
  capabilities() { return caps({ metadata: 'available', reason: 'Archived analysis by MusicBrainz id; collection ended in 2022' }); }
  override allowedHosts() { return HOSTS; }
  async bpmByMbid(mbid: string): Promise<number | null> {
    const d = await this.http.getJson<{ rhythm?: { bpm?: number } }>(`${API}/${encodeURIComponent(mbid)}/low-level`, { allowedHosts: HOSTS, timeoutMs: 8_000 }).catch(() => null);
    const bpm = d?.rhythm?.bpm;
    return bpm && bpm > 0 ? Math.round(bpm) : null;
  }
}
```
```ts
// docker-container/src/providers/adapters/lastfm.ts
const API = 'https://ws.audioscrobbler.com/2.0/';
const HOSTS = ['ws.audioscrobbler.com'];
export class LastFmAdapter extends BaseAdapter {
  readonly id = 'lastfm';
  constructor(private readonly http: SafeHttpClient) { super(); }
  descriptor() { return { provider: this.id, displayName: 'Last.fm (tags)', role: 'metadata-only' as const, docsUrl: 'https://www.last.fm/api', authKind: 'api-key' as const, reviewedAt: REVIEWED_AT, attribution: 'Tags from Last.fm' }; }
  capabilities() { return caps({ metadata: this.config.apiKey ? 'available' : 'requires_auth', reason: 'Community tags; needs an API key from last.fm/api' }); }
  override requiredConfig() { return ['apiKey']; }
  override allowedHosts() { return HOSTS; }
  currentConfig() { return this.config; }
  private async call(params: Record<string, string>): Promise<Array<{ name: string; count: number }>> {
    const url = new URL(API);
    for (const [k, v] of Object.entries({ ...params, api_key: this.config.apiKey ?? '', format: 'json', autocorrect: '1' })) url.searchParams.set(k, v);
    const d = await this.http.getJson<{ toptags?: { tag?: Array<{ name: string; count: number }> } }>(url.toString(), { allowedHosts: HOSTS, timeoutMs: 8_000 }).catch(() => null);
    return (d?.toptags?.tag ?? []).filter((t) => t.name && t.count > 0);
  }
  async topTags(artist: string, title: string): Promise<Array<{ name: string; count: number }>> {
    if (!this.config.apiKey) return [];
    const track = await this.call({ method: 'track.gettoptags', artist, track: title });
    if (track.length) return track;
    return this.call({ method: 'artist.gettoptags', artist });
  }
}
```
(`this.config` is whatever field `BaseAdapter.configure()` stores into — read `base.ts:76-83` and use that name.) Register in `app.ts` after the Bandcamp adapter:
```ts
  providers.register(new DeezerAdapter(http));
  providers.register(new AcousticBrainzAdapter(http));
  providers.register(new LastFmAdapter(http));
```

- [ ] **Step 4: Run the adapter tests, then the security suite**

Run: `pnpm --filter @now-playing/hub test:integration -- metadata-adapters && pnpm --filter @now-playing/hub test:security`
Expected: PASS. If `api-hardening.test.ts` enumerates providers by count or name, update its expectation to include the three (they are metadata-only and expose no new routes).

- [ ] **Step 5: Commit**

```bash
git add docker-container/src/providers/adapters/deezer.ts docker-container/src/providers/adapters/acousticbrainz.ts docker-container/src/providers/adapters/lastfm.ts docker-container/src/app.ts docker-container/tests
git commit -m "hub: Deezer, AcousticBrainz and Last.fm as metadata-only providers (tempo and tags)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: MusicBrainz — recording lookups, artist credits, genres and cover art

**Files:**
- Modify: `docker-container/src/providers/adapters/musicbrainz.ts` (add methods after `lookupUrl`)
- Test: `docker-container/tests/integration/musicbrainz-recordings.test.ts`

**Interfaces:**
- Produces on `MusicBrainzAdapter`:
  - `recordingsByIsrc(isrc): Promise<MbRecordingDetail[]>`
  - `searchRecordings(title, artist, limit = 5): Promise<MbRecordingDetail[]>`
  - `recordingDetail(mbid): Promise<MbRecordingDetail | null>`
  - `coverArtUrl(releaseGroupMbid): Promise<string | null>` (HEAD `https://coverartarchive.org/release-group/<id>/front-250`; 200/307 → that URL, else null)
  - `export interface MbRecordingDetail { id: string; title: string; lengthMs: number | null; isrcs: string[]; artistName: string; featuredArtists: string[]; releaseGroupId: string | null; albumName: string | null; releaseYear: number | null; genres: Array<{ name: string; count: number }>; tags: Array<{ name: string; count: number }> }`

- [ ] **Step 1: Write the failing test**

```ts
// docker-container/tests/integration/musicbrainz-recordings.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';
import type { MusicBrainzAdapter } from '../../src/providers/adapters/musicbrainz.js';

const RECORDING = {
  id: 'aaaaaaaa-0000-4000-8000-000000000010', title: 'Song', length: 200_000, isrcs: ['USUM71703861'],
  'artist-credit': [{ name: 'Artist', joinphrase: ' feat. ', artist: { id: 'x', name: 'Artist' } }, { name: 'Guest', joinphrase: '', artist: { id: 'y', name: 'Guest' } }],
  releases: [{ id: 'r1', title: 'Album', date: '2017-05-12', status: 'Official', 'release-group': { id: 'rg1', title: 'Album', 'primary-type': 'Album' } }],
  genres: [{ name: 'hip hop', count: 12 }], tags: [{ name: 'summer', count: 3 }],
};

describe('musicbrainz recordings', () => {
  let hub: TestHub; let mb: MusicBrainzAdapter;
  beforeEach(async () => { hub = await createTestHub(); mb = hub.ctx.providers.get('musicbrainz') as MusicBrainzAdapter; });
  afterEach(async () => { await hub.close(); });

  it('finds a recording by isrc with credits, album, year, genres and tags', async () => {
    hub.fetch.on('musicbrainz.org/ws/2/recording?query=isrc', () => ({ body: { recordings: [RECORDING] } }));
    const [r] = await mb.recordingsByIsrc('USUM71703861');
    expect(r).toMatchObject({ id: RECORDING.id, artistName: 'Artist', featuredArtists: ['Guest'], albumName: 'Album', releaseYear: 2017, releaseGroupId: 'rg1', lengthMs: 200_000 });
    expect(r!.genres[0]).toEqual({ name: 'hip hop', count: 12 });
  });
  it('searches by title and artist', async () => {
    hub.fetch.on('musicbrainz.org/ws/2/recording?query=recording', () => ({ body: { recordings: [RECORDING] } }));
    const hits = await mb.searchRecordings('Song', 'Artist');
    expect(hits.map((h) => h.id)).toEqual([RECORDING.id]);
    expect(hub.fetch.calls.at(-1)!.url).toContain('inc=');
  });
  it('resolves cover art to the front-250 url when the archive has it', async () => {
    hub.fetch.on('coverartarchive.org/release-group/rg1/front-250', () => ({ status: 307, headers: { location: 'https://archive.org/x.jpg' } }));
    expect(await mb.coverArtUrl('rg1')).toBe('https://coverartarchive.org/release-group/rg1/front-250');
    hub.fetch.on('coverartarchive.org/release-group/none/front-250', () => ({ status: 404 }));
    expect(await mb.coverArtUrl('none')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @now-playing/hub test:integration -- musicbrainz-recordings`
Expected: FAIL — `recordingsByIsrc is not a function`.

- [ ] **Step 3: Implement**

Add to `musicbrainz.ts` (the `HOSTS` constant already includes `coverartarchive.org`):
```ts
interface MbCredit { name: string; joinphrase?: string; artist: { id: string; name: string } }
interface MbRelease { id: string; title: string; date?: string; status?: string; 'release-group'?: { id: string; title: string; 'primary-type'?: string } }
interface MbRecordingRaw { id: string; title: string; length?: number; isrcs?: string[]; 'artist-credit'?: MbCredit[]; releases?: MbRelease[]; genres?: Array<{ name: string; count: number }>; tags?: Array<{ name: string; count: number }> }
export interface MbRecordingDetail { id: string; title: string; lengthMs: number | null; isrcs: string[]; artistName: string; featuredArtists: string[]; releaseGroupId: string | null; albumName: string | null; releaseYear: number | null; genres: Array<{ name: string; count: number }>; tags: Array<{ name: string; count: number }> }

const INC = 'artist-credits+releases+release-groups+genres+tags+isrcs';

function toDetail(r: MbRecordingRaw): MbRecordingDetail {
  const credits = r['artist-credit'] ?? [];
  const featured: string[] = [];
  let main = '';
  let inFeat = false;
  for (const c of credits) {
    if (inFeat) featured.push(c.name); else main += (main ? '' : '') + c.name;
    const jp = (c.joinphrase ?? '').toLowerCase();
    if (/feat|ft\.|featuring/.test(jp)) inFeat = true; else if (!inFeat && jp.trim()) main += c.joinphrase;
  }
  const official = (r.releases ?? []).filter((x) => x.status === 'Official' && x['release-group']?.['primary-type'] !== 'Single');
  const rel = official[0] ?? (r.releases ?? [])[0] ?? null;
  const year = rel?.date ? Number(rel.date.slice(0, 4)) : NaN;
  return { id: r.id, title: r.title, lengthMs: r.length ?? null, isrcs: r.isrcs ?? [], artistName: main.trim(), featuredArtists: featured, releaseGroupId: rel?.['release-group']?.id ?? null, albumName: rel?.['release-group']?.title ?? rel?.title ?? null, releaseYear: Number.isFinite(year) ? year : null, genres: r.genres ?? [], tags: r.tags ?? [] };
}
// methods on the class:
  async recordingsByIsrc(isrc: string): Promise<MbRecordingDetail[]> {
    const d = await this.get<{ recordings?: MbRecordingRaw[] }>('recording', { query: `isrc:${isrc}`, inc: INC, limit: '5' });
    return (d.recordings ?? []).map(toDetail);
  }
  async searchRecordings(title: string, artist: string, limit = 5): Promise<MbRecordingDetail[]> {
    const q = `recording:"${title.replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}"`;
    const d = await this.get<{ recordings?: MbRecordingRaw[] }>('recording', { query: q, inc: INC, limit: String(limit) });
    return (d.recordings ?? []).map(toDetail);
  }
  async recordingDetail(mbid: string): Promise<MbRecordingDetail | null> {
    const d = await this.get<MbRecordingRaw>(`recording/${encodeURIComponent(mbid)}`, { inc: INC }).catch(() => null);
    return d ? toDetail(d) : null;
  }
  async coverArtUrl(releaseGroupMbid: string): Promise<string | null> {
    const url = `https://coverartarchive.org/release-group/${encodeURIComponent(releaseGroupMbid)}/front-250`;
    const r = await this.http.request(url, { method: 'HEAD', allowedHosts: HOSTS, timeoutMs: 8_000, maxRedirects: 0 }).catch(() => null);
    return r && (r.status === 200 || r.status === 307 || r.status === 302) ? url : null;
  }
```
(`SafeResponse` exposes `status`; if `maxRedirects: 0` makes the client throw on 307, catch it and read the status from `ProviderHttpError` — check `http.ts:8-20` for the field name.)

- [ ] **Step 4: Run to verify it passes, plus the existing MusicBrainz tests**

Run: `pnpm --filter @now-playing/hub test:integration -- musicbrainz`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docker-container/src/providers/adapters/musicbrainz.ts docker-container/tests/integration/musicbrainz-recordings.test.ts
git commit -m "hub: MusicBrainz recordings by isrc and by title, artist credits with features, release group and cover art

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The matcher

**Files:**
- Create: `docker-container/src/enrichment/matcher.ts`
- Test: `docker-container/tests/integration/enrichment-matcher.test.ts`

**Interfaces:**
- Consumes: `MusicBrainzAdapter.recordingsByIsrc/recordingDetail/searchRecordings`, `RateLimitManager.run('musicbrainz', 'P2' | 'P3', fn, { timeoutMs })`, `cleanVideoTitle`, `normalizeArtist`, `normalizeText` from `@now-playing/domain`.
- Produces: `export interface MatchInput { title: string; artistName: string | null; channelName?: string | null; durationMs: number | null; isrc: string | null; musicbrainzRecordingId: string | null; provider: string }`; `export interface Match { recording: MbRecordingDetail; confidence: number; via: 'isrc' | 'mbid' | 'title'; cleaned: { title: string; artist: string | null; featured: string[] } }`; `export class RecordingMatcher { constructor(mb: MusicBrainzAdapter, limiter: RateLimitManager, priority: Priority = 'P2'); async match(input: MatchInput): Promise<Match | null> }`.

Confidence: ISRC hit → 0.95; MBID → 1.0; title path → `0.6 + 0.2·(artist exact) + 0.2·(duration within 1.5 s)`, and **rejected (null) when duration differs by more than 3000 ms or the normalised artist does not match**.

- [ ] **Step 1: Write the failing test**

```ts
// docker-container/tests/integration/enrichment-matcher.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';
import { RecordingMatcher } from '../../src/enrichment/matcher.js';
import type { MusicBrainzAdapter } from '../../src/providers/adapters/musicbrainz.js';

const rec = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000010', title: 'Song', length: 200_000, isrcs: [],
  'artist-credit': [{ name: 'Artist', joinphrase: '', artist: { id: 'x', name: 'Artist' } }],
  releases: [{ id: 'r1', title: 'Album', date: '2017-05-12', status: 'Official', 'release-group': { id: 'rg1', title: 'Album', 'primary-type': 'Album' } }],
  genres: [], tags: [], ...over,
});

describe('recording matcher', () => {
  let hub: TestHub; let matcher: RecordingMatcher;
  beforeEach(async () => { hub = await createTestHub(); matcher = new RecordingMatcher(hub.ctx.providers.get('musicbrainz') as MusicBrainzAdapter, hub.ctx.rateLimiter); });
  afterEach(async () => { await hub.close(); });

  it('matches by isrc first', async () => {
    hub.fetch.on('query=isrc', () => ({ body: { recordings: [rec({ isrcs: ['USUM71703861'] })] } }));
    const m = await matcher.match({ title: 'anything', artistName: 'anyone', durationMs: null, isrc: 'USUM71703861', musicbrainzRecordingId: null, provider: 'soundcloud' });
    expect(m?.via).toBe('isrc'); expect(m?.confidence).toBe(0.95);
  });
  it('falls through to the title path when the isrc is unknown', async () => {
    hub.fetch.on('query=isrc', () => ({ body: { recordings: [] } }));
    hub.fetch.on('query=recording', () => ({ body: { recordings: [rec()] } }));
    const m = await matcher.match({ title: 'Song', artistName: 'Artist', durationMs: 200_500, isrc: 'UNKNOWN0000001', musicbrainzRecordingId: null, provider: 'soundcloud' });
    expect(m?.via).toBe('title'); expect(m!.confidence).toBeCloseTo(1.0, 5);
  });
  it('cleans a YouTube title and its channel before searching', async () => {
    hub.fetch.on('query=recording', () => ({ body: { recordings: [rec()] } }));
    const m = await matcher.match({ title: 'Artist - Song (feat. X) [Official Video]', artistName: 'SomeLabelVEVO', channelName: 'SomeLabelVEVO', durationMs: 201_000, isrc: null, musicbrainzRecordingId: null, provider: 'youtube' });
    expect(hub.fetch.calls.at(-1)!.url).toMatch(/recording%3A%22Song%22.*artist%3A%22Artist%22/);
    expect(m?.cleaned).toEqual({ title: 'Song', artist: 'Artist', featured: ['X'] });
  });
  it('rejects a recording whose length is 40 s off, even with the same title and artist', async () => {
    hub.fetch.on('query=recording', () => ({ body: { recordings: [rec({ length: 240_000 })] } }));
    expect(await matcher.match({ title: 'Song', artistName: 'Artist', durationMs: 200_000, isrc: null, musicbrainzRecordingId: null, provider: 'spotify' })).toBeNull();
  });
  it('rejects a different artist with the same title', async () => {
    hub.fetch.on('query=recording', () => ({ body: { recordings: [rec()] } }));
    expect(await matcher.match({ title: 'Song', artistName: 'Someone Else', durationMs: 200_000, isrc: null, musicbrainzRecordingId: null, provider: 'spotify' })).toBeNull();
  });
  it('uses the mbid directly when the file already carries one', async () => {
    hub.fetch.on('ws/2/recording/aaaaaaaa-0000-4000-8000-000000000010', () => ({ body: rec() }));
    const m = await matcher.match({ title: 'x', artistName: null, durationMs: null, isrc: null, musicbrainzRecordingId: 'aaaaaaaa-0000-4000-8000-000000000010', provider: 'companion' });
    expect(m?.via).toBe('mbid'); expect(m?.confidence).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @now-playing/hub test:integration -- enrichment-matcher`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// docker-container/src/enrichment/matcher.ts
import { cleanVideoTitle, normalizeArtist, normalizeText } from '@now-playing/domain';
import type { MbRecordingDetail, MusicBrainzAdapter } from '../providers/adapters/musicbrainz.js';
import type { Priority, RateLimitManager } from '../providers/rate-limit-manager.js';

export interface MatchInput { title: string; artistName: string | null; channelName?: string | null; durationMs: number | null; isrc: string | null; musicbrainzRecordingId: string | null; provider: string }
export interface Match { recording: MbRecordingDetail; confidence: number; via: 'isrc' | 'mbid' | 'title'; cleaned: { title: string; artist: string | null; featured: string[] } }

const DURATION_GATE_MS = 3000;
const DURATION_TIGHT_MS = 1500;

/**
 * Which MusicBrainz recording a result is. By ISRC when there is one (a code, not a guess), by the
 * id a file already carries, and only then by name — and a name match is thrown away unless the
 * length agrees to three seconds and the artist is the same artist. Nothing here ever returns a
 * "probably".
 */
export class RecordingMatcher {
  constructor(private readonly mb: MusicBrainzAdapter, private readonly limiter: RateLimitManager, private readonly priority: Priority = 'P2') {}

  private run<T>(fn: () => Promise<T>): Promise<T> { return this.limiter.run('musicbrainz', this.priority, fn, { timeoutMs: 15_000 }); }

  async match(input: MatchInput): Promise<Match | null> {
    const cleaned = input.provider === 'youtube'
      ? cleanVideoTitle({ title: input.title, channel: input.channelName ?? input.artistName ?? null })
      : { ...splitPlain(input.title), fromTopicChannel: false };
    const artist = cleaned.artist ?? input.artistName;
    const cleanedOut = { title: cleaned.title, artist, featured: cleaned.featured };

    if (input.musicbrainzRecordingId) {
      const r = await this.run(() => this.mb.recordingDetail(input.musicbrainzRecordingId!));
      if (r) return { recording: r, confidence: 1, via: 'mbid', cleaned: cleanedOut };
    }
    if (input.isrc) {
      const hits = await this.run(() => this.mb.recordingsByIsrc(input.isrc!)).catch(() => []);
      if (hits[0]) return { recording: hits[0], confidence: 0.95, via: 'isrc', cleaned: cleanedOut };
    }
    if (!artist || !cleaned.title) return null;
    const hits = await this.run(() => this.mb.searchRecordings(cleaned.title, artist)).catch(() => []);
    const wantArtist = normalizeArtist(artist);
    for (const r of hits) {
      if (normalizeArtist(r.artistName) !== wantArtist) continue;
      if (normalizeText(r.title) !== normalizeText(cleaned.title)) continue;
      if (input.durationMs !== null && r.lengthMs !== null && Math.abs(r.lengthMs - input.durationMs) > DURATION_GATE_MS) continue;
      const tight = input.durationMs !== null && r.lengthMs !== null && Math.abs(r.lengthMs - input.durationMs) <= DURATION_TIGHT_MS;
      const confidence = 0.6 + 0.2 + (tight ? 0.2 : 0);
      return { recording: r, confidence, via: 'title', cleaned: cleanedOut };
    }
    return null;
  }
}

function splitPlain(title: string): { title: string; artist: string | null; featured: string[] } {
  // Non-video sources already give a title; only features hide inside it.
  const { title: t, featured } = require_splitFeatured(title);
  return { title: t, artist: null, featured };
}
```
Replace `require_splitFeatured` with a real import: `import { splitFeatured } from '@now-playing/domain';` and call `splitFeatured(title)`. Check the exact export names of `normalizeArtist`/`normalizeText` in `packages/domain/src/identity.ts` (line 46 shows `normalizeArtist`; the text normaliser is whichever function it delegates to) and that `rateLimiter` is exposed on `HubContext` (Task 8 wires it if not).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @now-playing/hub test:integration -- enrichment-matcher`
Expected: PASS (the title-path confidence test expects 1.0 because artist exact + duration within 1.5 s).

- [ ] **Step 5: Commit**

```bash
git add docker-container/src/enrichment/matcher.ts docker-container/tests/integration/enrichment-matcher.test.ts
git commit -m "hub: the recording matcher — isrc, then id, then a name gated by length and artist

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Tempo estimation in `packages/audio-core` (shared with the browser and the companion)

**Files:**
- Create: `packages/audio-core/src/tempo.ts`
- Modify: `packages/audio-core/src/index.ts` (export)
- Test: `packages/audio-core/tests/tempo.test.ts`

**Interfaces:**
- Produces: `estimateTempo(samples: Float32Array, sampleRate: number): { bpm: number; confidence: number } | null` — mono PCM in, tempo in the 70–180 window (halved/doubled into range), `confidence` = peak / mean of the autocorrelation in the search band (≥ 1); returns null for < 8 s of audio or silence.

- [ ] **Step 1: Write the failing test**

```ts
// packages/audio-core/tests/tempo.test.ts
import { describe, expect, it } from 'vitest';
import { estimateTempo } from '../src/tempo.js';

function clicks(bpm: number, seconds: number, sampleRate = 22050): Float32Array {
  const out = new Float32Array(seconds * sampleRate);
  const period = (60 / bpm) * sampleRate;
  for (let t = 0; t < out.length; t += period) {
    const start = Math.round(t);
    for (let i = 0; i < 200 && start + i < out.length; i++) out[start + i] = (1 - i / 200) * (i % 2 ? 1 : -1);
  }
  return out;
}

describe('estimateTempo', () => {
  it.each([90, 120, 174])('hears %d bpm clicks within one beat per minute', (bpm) => {
    const r = estimateTempo(clicks(bpm, 20), 22050);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.bpm - bpm)).toBeLessThanOrEqual(1);
    expect(r!.confidence).toBeGreaterThan(1.5);
  });
  it('folds a very slow pulse into the 70–180 window', () => {
    expect(estimateTempo(clicks(50, 20), 22050)!.bpm).toBe(100);
  });
  it('returns null for silence and for clips shorter than eight seconds', () => {
    expect(estimateTempo(new Float32Array(22050 * 20), 22050)).toBeNull();
    expect(estimateTempo(clicks(120, 4), 22050)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @now-playing/audio-core test -- tempo`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/audio-core/src/tempo.ts
/**
 * A tempo from audio, the plain way: an onset strength curve (how much louder each frame is than
 * the last), then autocorrelation over the lags that correspond to 60–200 BPM, then the strongest
 * lag. No model, no network, a few hundred lines of arithmetic that run the same in Node, in a
 * browser and in the companion. Good to about a beat per minute on anything with a beat; honest
 * (null) on silence and on clips too short to hold eight bars.
 */
const FRAME = 1024;
const HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 200;
const MIN_SECONDS = 8;

export function estimateTempo(samples: Float32Array, sampleRate: number): { bpm: number; confidence: number } | null {
  if (samples.length < sampleRate * MIN_SECONDS) return null;
  const frames = Math.floor((samples.length - FRAME) / HOP);
  if (frames < 32) return null;
  // Onset strength: positive change in frame energy across 8 coarse bands (a cheap spectral flux).
  const bands = 8;
  const prev = new Float32Array(bands);
  const onset = new Float32Array(frames);
  let total = 0;
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    const cur = new Float32Array(bands);
    for (let b = 0; b < bands; b++) {
      const lo = Math.floor((b / bands) * FRAME);
      const hi = Math.floor(((b + 1) / bands) * FRAME);
      let e = 0;
      for (let i = lo; i < hi; i++) { const s = samples[off + i]!; e += s * s; }
      cur[b] = Math.sqrt(e / (hi - lo));
    }
    let flux = 0;
    for (let b = 0; b < bands; b++) { const d = cur[b]! - prev[b]!; if (d > 0) flux += d; prev[b] = cur[b]!; }
    onset[f] = flux;
    total += flux;
  }
  if (total <= 1e-6) return null;
  const mean = total / frames;
  for (let f = 0; f < frames; f++) onset[f] = Math.max(0, onset[f]! - mean);
  // Autocorrelation over the lag window.
  const fps = sampleRate / HOP;
  const minLag = Math.floor((60 / MAX_BPM) * fps);
  const maxLag = Math.ceil((60 / MIN_BPM) * fps);
  let bestLag = -1, best = 0, sum = 0, n = 0;
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += onset[f]! * onset[f - lag]!;
    ac[lag] = s / (frames - lag);
    sum += ac[lag]!; n++;
    if (ac[lag]! > best) { best = ac[lag]!; bestLag = lag; }
  }
  if (bestLag < 0 || best <= 0) return null;
  // Parabolic interpolation around the peak for sub-lag precision.
  const l = ac[bestLag - 1] ?? best, r = ac[bestLag + 1] ?? best;
  const denom = l - 2 * best + r;
  const shift = denom !== 0 ? 0.5 * (l - r) / denom : 0;
  let bpm = 60 / ((bestLag + shift) / fps);
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  const confidence = best / (sum / n);
  if (!Number.isFinite(confidence) || confidence < 1.2) return null;
  return { bpm: Math.round(bpm), confidence: Math.round(confidence * 100) / 100 };
}
```
Export from `index.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @now-playing/audio-core test -- tempo`
Expected: PASS. If 174 lands at 87 or 87 at 174, the folding window is doing its job — the test expects 174 because 174 is inside 70–180; do not widen the window, fix the peak choice (prefer the lag whose `2×` or `½×` harmonic is also strong).

- [ ] **Step 5: Commit**

```bash
git add packages/audio-core/src/tempo.ts packages/audio-core/src/index.ts packages/audio-core/tests/tempo.test.ts
git commit -m "audio-core: a tempo estimator that runs anywhere — onset flux, autocorrelation, folded to 70–180

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The enrichment service and job handler

**Files:**
- Create: `docker-container/src/enrichment/service.ts`
- Modify: `docker-container/src/context.ts` (add `enrichment: EnrichmentService`; ensure `rateLimiter` is on the context)
- Modify: `docker-container/src/app.ts` (construct; register job handler)
- Modify: `docker-container/src/jobs/scheduler.ts:76-100` (`registerDefaults`: `this.handle('enrich-track', (job, ctx) => ctx.enrichment.runJob(job))`)
- Test: `docker-container/tests/integration/enrichment-service.test.ts`

**Interfaces:**
- Consumes: `RecordingMatcher`, `MusicBrainzAdapter.coverArtUrl`, `DeezerAdapter`, `AcousticBrainzAdapter`, `LastFmAdapter`, `mergeGenreProfile`, `CanonicalRepository`, `JobScheduler.enqueue`.
- Produces:
  - `ENRICHMENT_USER_ID = '00000000-0000-4000-8000-00000000e001'` (system jobs; `discovery_jobs.user_id` has no foreign key).
  - `class EnrichmentService { constructor(deps: { repos, providers, rateLimiter, scheduler, clock, log, ffmpeg: () => Promise<FfmpegInfo>, http: SafeHttpClient }); async enrichResult(result: SearchResult, budgetMs: number): Promise<SearchResult>; enqueueForTrack(key: EnrichmentKey): void; async runJob(job: DiscoveryJob): Promise<void>; applyCanonical(result: SearchResult, track: CanonicalTrack): SearchResult }`
  - `type EnrichmentKey = { canonicalId: string } | { provider: string; providerId: string; title: string; artistName: string | null; channelName?: string | null; durationMs: number | null; isrc: string | null; musicbrainzRecordingId: string | null; previewUrl: string | null; genreHint?: string | null }`
- `enrichResult`: look up canonical by `identity.musicbrainzRecordingId` → `identity.isrc` → normalised title+artist (via `findTracksByNormalized`, duration ± 3 s). Hit with `enrichedAt` → `applyCanonical`, return. Otherwise enqueue an `enrich-track` job with the key as payload (deduplicated by `provider:providerId` — skip if a queued job with that payload exists; add `CanonicalRepository.hasQueuedJob(kind, payloadKey)` if needed) and return the result unchanged. Never awaits network beyond the DB.
- `runJob`: match → if no match and no ISRC and no MBID: create/upsert a canonical row with `matchConfidence 0`, `enrichedAt now` (so it is not retried daily), fill BPM by search/preview only. If matched: upsert canonical (album, year, features, `musicbrainzRecordingId`, `isrc` from MB if missing), `artworkUrl = coverArtUrl(releaseGroupId)`, genre profile = `mergeGenreProfile([...mb recording genres×1.0, tags×0.5, ...lastfm×0.8, genreHint×0.3])`, `genres = Object.keys(profile)`, `tags` = unmapped labels (top 10), BPM chain: `deezer.bpmByIsrc` → `acousticbrainz.bpmByMbid` → `deezer.bpmBySearch` → preview-clip analysis (Task 10) — first non-null wins, `bpmSource` set accordingly. `enrichedAt = now`.
- Backoff: throw from `runJob` on transport errors so the scheduler's own retry/backoff applies (`JOB_MAX_ATTEMPTS = 5`); a 429 with `Retry-After` → `rateLimiter` already opens the circuit; nothing else to do.

- [ ] **Step 1: Write the failing test**

```ts
// docker-container/tests/integration/enrichment-service.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';

const RECORDING = { id: 'aaaaaaaa-0000-4000-8000-000000000010', title: 'Song', length: 200_000, isrcs: ['USUM71703861'],
  'artist-credit': [{ name: 'Artist', joinphrase: ' feat. ', artist: { id: 'x', name: 'Artist' } }, { name: 'Guest', joinphrase: '', artist: { id: 'y', name: 'Guest' } }],
  releases: [{ id: 'r1', title: 'Album', date: '2017-05-12', status: 'Official', 'release-group': { id: 'rg1', title: 'Album', 'primary-type': 'Album' } }],
  genres: [{ name: 'hip hop', count: 12 }, { name: 'trap', count: 4 }], tags: [{ name: 'summer', count: 3 }] };

function spotifyResult() {
  return { id: 'spotify:track:abc', kind: 'track', provider: 'spotify', providerId: 'abc', title: 'Song', artistName: 'Artist', albumName: null, durationMs: 200_000, artworkUrl: null, canonicalUrl: null, year: null, genre: null,
    capabilities: hubCapsFixture(), identity: { contentHash: null, quickHash: null, isrc: 'USUM71703861', musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustid: null, matchConfidence: null }, attribution: null, cachedAt: null, stale: false, accessState: 'available', previewUrl: null, trackId: null, variants: [], genres: [], genreProfile: {}, featuredArtists: [], bpm: null, bpmSource: null } as const;
}

describe('enrichment service', () => {
  let hub: TestHub;
  beforeEach(async () => { hub = await createTestHub(); });
  afterEach(async () => { await hub.close(); });

  it('answers at once from an empty cache and queues one job per result', async () => {
    const out = await hub.ctx.enrichment.enrichResult(spotifyResult() as never, 200);
    expect(out.albumName).toBeNull();
    expect(hub.ctx.repos.canonical.jobCounts()['queued']).toBe(1);
    await hub.ctx.enrichment.enrichResult(spotifyResult() as never, 200);
    expect(hub.ctx.repos.canonical.jobCounts()['queued']).toBe(1); // deduplicated
  });
  it('the job fills album, features, cover, profile and bpm, and the next answer comes from the cache', async () => {
    hub.fetch.on('query=isrc', () => ({ body: { recordings: [RECORDING] } }));
    hub.fetch.on('coverartarchive.org/release-group/rg1/front-250', () => ({ status: 307, headers: { location: 'https://archive.org/x.jpg' } }));
    hub.fetch.on('api.deezer.com/track/isrc:USUM71703861', () => ({ body: { id: 1, bpm: 98, duration: 200 } }));
    await hub.ctx.enrichment.enrichResult(spotifyResult() as never, 200);
    await hub.scheduler.runJobOnce();
    const out = await hub.ctx.enrichment.enrichResult(spotifyResult() as never, 200);
    expect(out.albumName).toBe('Album'); expect(out.featuredArtists).toEqual(['Guest']);
    expect(out.artworkUrl).toBe('https://coverartarchive.org/release-group/rg1/front-250');
    expect(out.genreProfile['hip hop']).toBeGreaterThan(out.genreProfile['trap']!);
    expect(out.bpm).toBe(98); expect(out.bpmSource).toBe('deezer');
    expect(out.identity.matchConfidence).toBe(0.95);
    expect(hub.fetch.calls.filter((c) => c.url.includes('acousticbrainz'))).toHaveLength(0); // deezer answered first
  });
  it('records a no-match honestly and does not retry it', async () => {
    hub.fetch.on('query=recording', () => ({ body: { recordings: [] } }));
    hub.fetch.on('api.deezer.com/search', () => ({ body: { data: [] } }));
    const r = { ...spotifyResult(), identity: { ...spotifyResult().identity, isrc: null } };
    await hub.ctx.enrichment.enrichResult(r as never, 200);
    await hub.scheduler.runJobOnce();
    const out = await hub.ctx.enrichment.enrichResult(r as never, 200);
    expect(out.albumName).toBeNull(); expect(out.identity.matchConfidence).toBe(0);
    expect(hub.ctx.repos.canonical.jobCounts()['queued'] ?? 0).toBe(0);
  });
  it('a transport failure leaves the job to be retried, not finished', async () => {
    hub.fetch.on('query=isrc', () => ({ status: 503, body: {} }));
    await hub.ctx.enrichment.enrichResult(spotifyResult() as never, 200);
    await hub.scheduler.runJobOnce();
    const job = Object.values(hub.ctx.repos.canonical.jobCounts());
    expect(hub.ctx.repos.canonical.jobCounts()['queued']).toBe(1); // re-queued with backoff
  });
});
```
`hubCapsFixture()` = the `caps({})` result — import `caps` from `../../src/providers/adapters/base.js`. If `hub.scheduler` is not exposed by `createTestHub`, expose it (it is constructed in `app.ts`; add it to `TestHub`).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @now-playing/hub test:integration -- enrichment-service`
Expected: FAIL — `ctx.enrichment` undefined.

- [ ] **Step 3: Implement the service**

```ts
// docker-container/src/enrichment/service.ts
import type { CanonicalTrack, DiscoveryJob, SearchResult } from '@now-playing/contracts';
import { mergeGenreProfile, normalizeArtist, normalizeText } from '@now-playing/domain';
import { randomUUID } from 'node:crypto';
import type { HubContext } from '../context.js';
import type { AcousticBrainzAdapter } from '../providers/adapters/acousticbrainz.js';
import type { DeezerAdapter } from '../providers/adapters/deezer.js';
import type { LastFmAdapter } from '../providers/adapters/lastfm.js';
import type { MusicBrainzAdapter } from '../providers/adapters/musicbrainz.js';
import { RecordingMatcher, type Match } from './matcher.js';
import { bpmFromPreviewClip } from './preview-bpm.js';

export const ENRICHMENT_USER_ID = '00000000-0000-4000-8000-00000000e001';
const DURATION_GATE_MS = 3000;

export type EnrichmentKey = { provider: string; providerId: string; title: string; artistName: string | null; channelName?: string | null; durationMs: number | null; isrc: string | null; musicbrainzRecordingId: string | null; previewUrl: string | null; genreHint?: string | null };

type Deps = Pick<HubContext, 'repos' | 'providers' | 'rateLimiter' | 'clock' | 'log' | 'ffmpeg' | 'http'> & { enqueue: (input: { userId: string; kind: DiscoveryJob['kind']; priority?: DiscoveryJob['priority']; payload?: Record<string, unknown> }) => unknown };

export class EnrichmentService {
  private readonly matcher: RecordingMatcher;
  constructor(private readonly deps: Deps) {
    this.matcher = new RecordingMatcher(deps.providers.get('musicbrainz') as MusicBrainzAdapter, deps.rateLimiter);
  }
  private now(): string { return new Date(this.deps.clock.now()).toISOString(); }

  private findCanonical(r: { identity: SearchResult['identity']; title: string; artistName: string | null; durationMs: number | null }): CanonicalTrack | undefined {
    const c = this.deps.repos.canonical;
    if (r.identity.musicbrainzRecordingId) { const t = c.findTrackByMbid(r.identity.musicbrainzRecordingId); if (t) return t; }
    if (r.identity.isrc) { const t = c.findTrackByIsrc(r.identity.isrc); if (t) return t; }
    if (!r.artistName) return undefined;
    return c.findTracksByNormalized(normalizeArtist(r.artistName), normalizeText(r.title)).find((t) => r.durationMs === null || t.durationMs === null || Math.abs(t.durationMs - r.durationMs) <= DURATION_GATE_MS);
  }

  applyCanonical(result: SearchResult, t: CanonicalTrack): SearchResult {
    const conf = t.matchConfidence ?? 0;
    const matched = conf >= 0.5;
    return {
      ...result,
      albumName: matched ? t.albumName ?? result.albumName : result.albumName,
      artistName: matched ? t.artistName : result.artistName,
      featuredArtists: matched ? t.featuredArtists : result.featuredArtists,
      artworkUrl: matched && t.artworkUrl ? t.artworkUrl : result.artworkUrl,
      year: matched ? t.releaseYear ?? result.year : result.year,
      genres: matched ? t.genres : result.genres,
      genreProfile: matched ? t.genreProfile : result.genreProfile,
      genre: matched ? t.genres[0] ?? result.genre : result.genre,
      bpm: t.bpm ?? result.bpm,
      bpmSource: t.bpm !== null ? t.bpmSource : result.bpmSource,
      identity: { ...result.identity, isrc: result.identity.isrc ?? t.isrc, musicbrainzRecordingId: result.identity.musicbrainzRecordingId ?? t.musicbrainzRecordingId, matchConfidence: t.matchConfidence },
    };
  }

  async enrichResult(result: SearchResult, _budgetMs: number): Promise<SearchResult> {
    if (result.kind !== 'track') return result;
    const t = this.findCanonical(result);
    if (t?.enrichedAt) return this.applyCanonical(result, t);
    this.enqueueForTrack({ provider: result.provider, providerId: result.providerId, title: result.title, artistName: result.artistName, channelName: result.provider === 'youtube' ? result.artistName : null, durationMs: result.durationMs, isrc: result.identity.isrc, musicbrainzRecordingId: result.identity.musicbrainzRecordingId, previewUrl: result.previewUrl, genreHint: result.genre });
    return t ? this.applyCanonical(result, t) : result;
  }

  enqueueForTrack(key: EnrichmentKey): void {
    const payloadKey = `${key.provider}:${key.providerId}`;
    if (this.deps.repos.canonical.hasQueuedJob('enrich-track', payloadKey)) return;
    this.deps.enqueue({ userId: ENRICHMENT_USER_ID, kind: 'enrich-track', priority: 'P3', payload: { key: payloadKey, ...key } });
  }

  async runJob(job: DiscoveryJob): Promise<void> {
    const key = job.payload as unknown as EnrichmentKey;
    const match = await this.matcher.match({ title: key.title, artistName: key.artistName, channelName: key.channelName ?? null, durationMs: key.durationMs, isrc: key.isrc, musicbrainzRecordingId: key.musicbrainzRecordingId, provider: key.provider });
    const now = this.now();
    const existing = this.findCanonical({ identity: { isrc: key.isrc, musicbrainzRecordingId: match?.recording.id ?? key.musicbrainzRecordingId, contentHash: null, quickHash: null, musicbrainzReleaseId: null, acoustid: null, matchConfidence: null }, title: key.title, artistName: key.artistName, durationMs: key.durationMs });
    const base: CanonicalTrack = existing ?? { id: randomUUID(), musicbrainzRecordingId: null, isrc: key.isrc, title: key.title, normalizedTitle: normalizeText(key.title), artistId: null, artistName: key.artistName ?? '', normalizedArtist: normalizeArtist(key.artistName ?? ''), albumId: null, albumName: null, releaseYear: null, durationMs: key.durationMs, genres: [], tags: [], popularity: null, createdAt: now, updatedAt: now, featuredArtists: [], genreProfile: {}, bpm: null, bpmSource: null, artworkUrl: null, matchConfidence: null, enrichedAt: null };
    const track: CanonicalTrack = match ? await this.fill(base, match, key) : { ...base, matchConfidence: 0 };
    if (track.bpm === null) {
      const bpm = await this.bpmChain(track, key);
      if (bpm) { track.bpm = bpm.bpm; track.bpmSource = bpm.source; }
    }
    track.updatedAt = now; track.enrichedAt = now;
    this.deps.repos.canonical.upsertTrack(track);
  }

  private async fill(base: CanonicalTrack, m: Match, key: EnrichmentKey): Promise<CanonicalTrack> {
    const mb = this.deps.providers.get('musicbrainz') as MusicBrainzAdapter;
    const lastfm = this.deps.providers.get('lastfm') as LastFmAdapter | undefined;
    const r = m.recording;
    const artwork = r.releaseGroupId ? await this.deps.rateLimiter.run('musicbrainz', 'P3', () => mb.coverArtUrl(r.releaseGroupId!), { timeoutMs: 10_000 }).catch(() => null) : null;
    const lfm = lastfm ? await this.deps.rateLimiter.run('lastfm', 'P3', () => lastfm.topTags(r.artistName, r.title), { timeoutMs: 10_000 }).catch(() => []) : [];
    const maxG = Math.max(1, ...r.genres.map((g) => g.count)), maxT = Math.max(1, ...r.tags.map((g) => g.count)), maxL = Math.max(1, ...lfm.map((g) => g.count));
    const votes = [
      ...r.genres.map((g) => ({ label: g.name, weight: g.count / maxG })),
      ...r.tags.map((g) => ({ label: g.name, weight: 0.5 * (g.count / maxT) })),
      ...lfm.map((g) => ({ label: g.name, weight: 0.8 * (g.count / maxL) })),
      ...(key.genreHint ? [{ label: key.genreHint, weight: 0.3 }] : []),
    ];
    const profile = mergeGenreProfile(votes);
    const unmapped = [...r.tags, ...lfm].map((t) => t.name.toLowerCase()).filter((n) => !(n in profile)).slice(0, 10);
    return { ...base, musicbrainzRecordingId: r.id, isrc: base.isrc ?? r.isrcs[0] ?? null, title: r.title, normalizedTitle: normalizeText(r.title), artistName: r.artistName, normalizedArtist: normalizeArtist(r.artistName), albumName: r.albumName, releaseYear: r.releaseYear, durationMs: base.durationMs ?? r.lengthMs, featuredArtists: r.featuredArtists.length ? r.featuredArtists : m.cleaned.featured, genres: Object.keys(profile), genreProfile: profile, tags: [...new Set(unmapped)], artworkUrl: artwork, matchConfidence: m.confidence };
  }

  private async bpmChain(t: CanonicalTrack, key: EnrichmentKey): Promise<{ bpm: number; source: CanonicalTrack['bpmSource'] } | null> {
    const deezer = this.deps.providers.get('deezer') as DeezerAdapter | undefined;
    const ab = this.deps.providers.get('acousticbrainz') as AcousticBrainzAdapter | undefined;
    const run = <T,>(p: string, fn: () => Promise<T>) => this.deps.rateLimiter.run(p, 'P3', fn, { timeoutMs: 10_000 }).catch(() => null as T | null);
    if (deezer && t.isrc) { const d = await run('deezer', () => deezer.bpmByIsrc(t.isrc!)); if (d) return { bpm: d.bpm, source: 'deezer' }; }
    if (ab && t.musicbrainzRecordingId) { const b = await run('acousticbrainz', () => ab.bpmByMbid(t.musicbrainzRecordingId!)); if (b) return { bpm: b, source: 'acousticbrainz' }; }
    if (deezer && t.artistName) { const d = await run('deezer', () => deezer.bpmBySearch(t.artistName, t.title, t.durationMs)); if (d) return { bpm: d.bpm, source: 'deezer' }; }
    if (key.previewUrl) { const p = await bpmFromPreviewClip(this.deps, key.previewUrl); if (p) return { bpm: p.bpm, source: 'preview-analysis' }; }
    return null;
  }
}
```
Add to `CanonicalRepository`:
```ts
  hasQueuedJob(kind: DiscoveryJob['kind'], payloadKey: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM discovery_jobs WHERE kind = ? AND state IN ('queued','running') AND json_extract(payload, '$.key') = ? LIMIT 1").get(kind, payloadKey);
  }
```
Wire: in `context.ts` add `enrichment: EnrichmentService` and, if missing, `rateLimiter: RateLimitManager` and `http: SafeHttpClient`; in `app.ts` construct after the scheduler exists (`new EnrichmentService({ ...ctxSlice, enqueue: (i) => scheduler.enqueue(i) })`) and in `scheduler.registerDefaults()` add `this.handle('enrich-track', (job, ctx) => ctx.enrichment.runJob(job));`. Create `enrichment/preview-bpm.ts` as a stub exporting `bpmFromPreviewClip = async () => null` so this task compiles; Task 10 implements it.

- [ ] **Step 4: Run the service tests, then the whole hub integration suite**

Run: `pnpm --filter @now-playing/hub test:integration`
Expected: PASS (the scheduler's existing tests must not change: jobs of unknown kinds still fail cleanly).

- [ ] **Step 5: Commit**

```bash
git add docker-container/src/enrichment docker-container/src/context.ts docker-container/src/app.ts docker-container/src/jobs/scheduler.ts docker-container/src/db/repositories/canonical.ts docker-container/tests
git commit -m "hub: the enrichment service — cache-first answers, one queued job per track, album, features, cover, genre profile and bpm

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: BPM from the preview clip

**Files:**
- Modify: `docker-container/src/enrichment/preview-bpm.ts` (replace the stub)
- Test: `docker-container/tests/integration/preview-bpm.test.ts`

**Interfaces:**
- Consumes: `estimateTempo` (Task 8), `SafeHttpClient.request(url, { allowedHosts, maxBytes, timeoutMs })` returning bytes (check `SafeResponse` for the body accessor — `bytes()` / `arrayBuffer()`), `deps.ffmpeg()` → `FfmpegInfo { available, path }`, `node:child_process.spawn`.
- Produces: `bpmFromPreviewClip(deps: { http; ffmpeg; log }, url: string): Promise<{ bpm: number; confidence: number } | null>`; `PREVIEW_HOSTS = ['audio-ssl.itunes.apple.com', 'p.scdn.co', 'cf-media.sndcdn.com', 'cf-hls-media.sndcdn.com']`; `MAX_CLIP_BYTES = 4 * 1024 * 1024`.

- [ ] **Step 1: Write the failing test**

```ts
// docker-container/tests/integration/preview-bpm.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';
import { bpmFromPreviewClip, PREVIEW_HOSTS } from '../../src/enrichment/preview-bpm.js';

describe('bpm from a preview clip', () => {
  let hub: TestHub;
  beforeEach(async () => { hub = await createTestHub({ ffmpeg: { available: true, path: process.execPath, version: 'fake', encoders: [] } }); });
  afterEach(async () => { await hub.close(); });

  it('refuses hosts that are not preview hosts', async () => {
    expect(await bpmFromPreviewClip(hub.ctx, 'https://www.youtube.com/watch?v=x')).toBeNull();
    expect(hub.fetch.calls).toHaveLength(0);
  });
  it('gives up on a clip over the size cap without decoding', async () => {
    hub.fetch.on('p.scdn.co/mp3-preview/big', () => ({ status: 200, headers: { 'content-length': String(5 * 1024 * 1024) }, body: new Uint8Array(10) }));
    expect(await bpmFromPreviewClip(hub.ctx, 'https://p.scdn.co/mp3-preview/big')).toBeNull();
  });
  it('is null when ffmpeg is absent', async () => {
    const noFfmpeg = await createTestHub({ ffmpeg: { available: false, path: null, version: null, encoders: [] } });
    noFfmpeg.fetch.on('p.scdn.co/mp3-preview/x', () => ({ status: 200, body: new Uint8Array(1000) }));
    expect(await bpmFromPreviewClip(noFfmpeg.ctx, 'https://p.scdn.co/mp3-preview/x')).toBeNull();
    await noFfmpeg.close();
  });
  it('decodes through the given ffmpeg and hears the tempo', async () => {
    // The fake "ffmpeg" is node itself running a script that writes 20 s of 120 bpm clicks as s16le mono 22050 to stdout.
    hub.fetch.on('audio-ssl.itunes.apple.com/clip', () => ({ status: 200, body: new Uint8Array(1000) }));
    const r = await bpmFromPreviewClip({ ...hub.ctx, ffmpeg: async () => ({ available: true, path: process.execPath, version: 'fake', encoders: [] }), ffmpegArgsOverride: ['-e', CLICK_SCRIPT] } as never, 'https://audio-ssl.itunes.apple.com/clip');
    expect(r?.bpm).toBe(120);
  });
  it('lists exactly the four preview hosts', () => {
    expect(PREVIEW_HOSTS).toEqual(['audio-ssl.itunes.apple.com', 'p.scdn.co', 'cf-media.sndcdn.com', 'cf-hls-media.sndcdn.com']);
  });
});
const CLICK_SCRIPT = `const sr=22050,sec=20,bpm=120;const n=sr*sec;const b=Buffer.alloc(n*2);const period=60/bpm*sr;for(let t=0;t<n;t+=period){const s=Math.round(t);for(let i=0;i<200&&s+i<n;i++){b.writeInt16LE(Math.round((1-i/200)*(i%2?1:-1)*20000),(s+i)*2);}}process.stdout.write(b);`;
```
`createTestHub` accepts a `ffmpegLocator`-style option (see `app.ts:127` `deps.ffmpegLocator`); pass it through as `ffmpeg` in `TestHubOptions` if it is not already exposed. `ffmpegArgsOverride` is a test-only seam: when present, the function spawns `ffmpeg.path` with those args instead of the real decode args.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @now-playing/hub test:integration -- preview-bpm`
Expected: FAIL — `PREVIEW_HOSTS` not exported / stub returns null for the click case.

- [ ] **Step 3: Implement**

```ts
// docker-container/src/enrichment/preview-bpm.ts
import { estimateTempo } from '@now-playing/audio-core';
import { spawn } from 'node:child_process';
import type { FfmpegInfo } from '../deps.js';
import type { SafeHttpClient } from '../providers/http.js';

/**
 * A tempo for a song nobody has downloaded: the 30-second clip the listing plays, decoded in memory
 * and discarded. Only the platforms' preview hosts, only up to four megabytes, only when ffmpeg is
 * there to decode it. No clip is written to disk.
 */
export const PREVIEW_HOSTS = ['audio-ssl.itunes.apple.com', 'p.scdn.co', 'cf-media.sndcdn.com', 'cf-hls-media.sndcdn.com'] as const;
export const MAX_CLIP_BYTES = 4 * 1024 * 1024;
const SAMPLE_RATE = 22050;

type Deps = { http: SafeHttpClient; ffmpeg: () => Promise<FfmpegInfo>; log: { warn: (o: unknown, m?: string) => void }; ffmpegArgsOverride?: string[] };

export async function bpmFromPreviewClip(deps: Deps, url: string): Promise<{ bpm: number; confidence: number } | null> {
  let host: string;
  try { host = new URL(url).hostname; } catch { return null; }
  if (!PREVIEW_HOSTS.includes(host as (typeof PREVIEW_HOSTS)[number])) return null;
  const ffmpeg = await deps.ffmpeg();
  if (!ffmpeg.available || !ffmpeg.path) return null;
  const res = await deps.http.request(url, { allowedHosts: PREVIEW_HOSTS, timeoutMs: 15_000, maxBytes: MAX_CLIP_BYTES }).catch(() => null);
  if (!res || res.status !== 200) return null;
  const declared = Number(res.headers['content-length'] ?? 0);
  if (declared > MAX_CLIP_BYTES) return null;
  const clip = await res.bytes();
  if (clip.byteLength === 0 || clip.byteLength > MAX_CLIP_BYTES) return null;
  const pcm = await decode(ffmpeg.path, clip, deps.ffmpegArgsOverride);
  if (!pcm) return null;
  const samples = new Float32Array(pcm.byteLength / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return estimateTempo(samples, SAMPLE_RATE);
}

function decode(ffmpegPath: string, clip: Uint8Array, argsOverride?: string[]): Promise<Uint8Array | null> {
  const args = argsOverride ?? ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-t', '30', 'pipe:1'];
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 20_000);
    child.stdout.on('data', (c: Buffer) => { total += c.length; if (total > SAMPLE_RATE * 2 * 40) { child.kill(); } else chunks.push(c); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 || chunks.length ? Buffer.concat(chunks) : null); });
    if (!argsOverride) { child.stdin.on('error', () => {}); child.stdin.end(clip); } else child.stdin.end();
  });
}
```
Check `SafeResponse`'s body accessor name in `http.ts:55-75` (`bytes()`, `arrayBuffer()` or a `body` field) and use it; check `res.headers` is a plain record or a `Headers` (use `.get`).

- [ ] **Step 4: Run the test and the security suite (the new hosts are outbound-validated)**

Run: `pnpm --filter @now-playing/hub test:integration -- preview-bpm && pnpm --filter @now-playing/hub test:security`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docker-container/src/enrichment/preview-bpm.ts docker-container/tests/integration/preview-bpm.test.ts docker-container/tests/helpers/hub.ts
git commit -m "hub: a tempo from the preview clip — preview hosts only, four megabytes, decoded in memory and discarded

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Wire enrichment into search, resolve and library sync

**Files:**
- Modify: `docker-container/src/providers/search-service.ts:91-200` (`search`, `resolveUrl`, `toTrackRef`)
- Modify: `docker-container/src/library/service.ts:308-375` (`buildRecord`) and the companion push path in `sync` (wherever companion tracks are upserted into `canonical_tracks` — search for `upsertTrack(` outside the repository)
- Test: `docker-container/tests/integration/enrichment-wiring.test.ts`

**Interfaces:**
- Consumes: `EnrichmentService.enrichResult`, `enqueueForTrack`.
- Produces: `/search` and `/providers/resolve` responses carry `albumName/featuredArtists/genres/genreProfile/bpm/bpmSource/artworkUrl` from the cache when known; `toTrackRef` copies `bpm` and `genres` so a queued item carries them; every hub library track without a MusicBrainz id and every companion-synced track is enqueued once.

- [ ] **Step 1: Write the failing test**

```ts
// docker-container/tests/integration/enrichment-wiring.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';

describe('enrichment on the request paths', () => {
  let hub: TestHub;
  beforeEach(async () => { hub = await createTestHub(); });
  afterEach(async () => { await hub.close(); });

  it('a resolved spotify link is queued, and after the job the same link answers with album and bpm', async () => {
    // register the spotify fixture the existing provider tests use for a track resolve (copy from tests/integration that exercise providersResolve)
    hub.fetch.on('api.spotify.com/v1/tracks/abc', () => ({ body: { id: 'abc', name: 'Song', duration_ms: 200000, artists: [{ name: 'Artist', id: 'a' }], album: { name: 'Album', release_date: '2017-05-12', images: [] }, external_ids: { isrc: 'USUM71703861' }, preview_url: null } }));
    hub.fetch.on('accounts.spotify.com/api/token', () => ({ body: { access_token: 't', expires_in: 3600 } }));
    hub.fetch.on('query=isrc', () => ({ body: { recordings: [/* RECORDING from Task 9 */] } }));
    hub.fetch.on('api.deezer.com/track/isrc:USUM71703861', () => ({ body: { id: 1, bpm: 98, duration: 200 } }));
    const device = await hub.pairDevice({ scopes: ['search:use'] });
    const first = await hub.app.inject({ method: 'GET', url: '/api/v1/providers/resolve?url=https://open.spotify.com/track/abc', headers: { authorization: device.authorization } });
    expect(first.json().bpm).toBeNull();
    await hub.scheduler.runJobOnce();
    const second = await hub.app.inject({ method: 'GET', url: '/api/v1/providers/resolve?url=https://open.spotify.com/track/abc', headers: { authorization: device.authorization } });
    expect(second.json().bpm).toBe(98); expect(second.json().albumName).toBe('Album'); expect(second.json().featuredArtists).toEqual(['Guest']);
  });
  it('search results get the same treatment and a queued TrackRef carries bpm and genres', async () => {
    // seed the canonical row directly (enriched), then search the hub-library provider for it
    // ... upsertTrack({... bpm: 120, bpmSource: 'deezer', genres: ['house'], enrichedAt: now, matchConfidence: 0.95 ...})
    // ... expect(hub.ctx.search.toTrackRef(result).bpm).toBe(120)
  });
  it('a scanned library track without a MusicBrainz id is queued once', async () => {
    // use the public-domain fixture root the existing library tests scan; after scanRoot, expect jobCounts().queued >= 1 and a second scan not to add more
  });
});
```
Fill the two sketched tests with the fixtures the existing `library` and `search` integration tests already use (search `docker-container/tests/integration` for `scanRoot(` and `'/api/v1/search'`) — same setup, then the assertions above.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @now-playing/hub test:integration -- enrichment-wiring`
Expected: FAIL — `bpm` stays null after the job (the resolve path never asks the cache).

- [ ] **Step 3: Wire it**

In `search-service.ts`:
- `search()`: after results are assembled and before the response object is built, `results = await Promise.all(results.map((r) => this.ctx.enrichment.enrichResult(r, 200)))` (obtain the service through whatever the search service is constructed with — add an `enrichment` field to its constructor deps and pass it in `app.ts`; the service is DB-only so the `Promise.all` is effectively synchronous).
- `resolveUrl()`: same call on the single result.
- `toTrackRef()`: copy `bpm`, `genres`, `genre` (top of profile), `featuredArtists`, `artworkUrl` into the `TrackRef` (extend `TrackRef` in `packages/contracts/src/entities/library.ts:100` with `bpm: z.number().nullable().default(null)` and `genres: z.array(z.string()).default([])` if it lacks them).

In `library/service.ts` `buildRecord`: after the record is built, if `rec.track.identity.musicbrainzRecordingId === null`, call `this.enrichment.enqueueForTrack({ provider: 'hub', providerId: rec.id, title: rec.track.title, artistName: rec.track.artistName, durationMs: rec.track.durationMs, isrc: rec.track.identity.isrc, musicbrainzRecordingId: null, previewUrl: null, genreHint: rec.track.genre })` — dedup makes repeated scans free. Do the same in the companion sync upsert path with `provider: 'companion'`.

- [ ] **Step 4: Run the wiring test, then the whole hub suite**

Run: `pnpm --filter @now-playing/hub test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docker-container/src packages/contracts docker-container/tests
git commit -m "hub: search, resolve and library sync go through enrichment; queued tracks carry bpm and genres

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Recommender — genre profile and tempo

**Files:**
- Modify: `packages/recommendations/src/candidates.ts:41-49, 76-80` (`TrackFeatures`, `trackFeatures`)
- Modify: `packages/recommendations/src/ranking.ts` (`ScoreBreakdown`, `RankingWeights`, the component computation near line 192, explanations near 259)
- Modify: `packages/recommendations/src/config.ts` (`DEFAULT_RECOMMENDATION_CONFIG.weights`)
- Modify: `packages/recommendations/src/similarity.ts` (add `profileSimilarity`, `tempoAffinity`)
- Test: `packages/recommendations/tests/tempo-and-profile.test.ts`

**Interfaces:**
- Consumes: `CanonicalTrack.genreProfile`, `.bpm`.
- Produces: `TrackFeatures` += `genreProfile: GenreProfile`, `bpm: number | null`; `profileSimilarity(a, b): number` (cosine over shared keys, 0 when either empty); `tempoAffinity(a: number | null, b: number | null): number` (`exp(-(Δ/12)²)`, best of direct, `2×`, `½×` with the harmonic ones scaled by 0.7; 0 when either null); new ranking component `tempoFit` with default weight `0.15`; when both tracks carry a profile, `genreAffinity` uses `profileSimilarity` instead of the list overlap.

- [ ] **Step 1: Write the failing test**

```ts
// packages/recommendations/tests/tempo-and-profile.test.ts
import { describe, expect, it } from 'vitest';
import { profileSimilarity, tempoAffinity } from '../src/similarity.js';
import { DEFAULT_RECOMMENDATION_CONFIG } from '../src/config.js';

describe('tempo affinity', () => {
  it('is 1 at the same tempo, about a half at 10 bpm apart, near 0 at 40', () => {
    expect(tempoAffinity(120, 120)).toBe(1);
    expect(tempoAffinity(120, 130)).toBeCloseTo(Math.exp(-(10 / 12) ** 2), 5);
    expect(tempoAffinity(120, 160)).toBeLessThan(0.01);
  });
  it('counts double and half time at 0.7', () => {
    expect(tempoAffinity(85, 170)).toBeCloseTo(0.7, 5);
    expect(tempoAffinity(170, 85)).toBeCloseTo(0.7, 5);
  });
  it('is 0 when either is unknown', () => { expect(tempoAffinity(null, 120)).toBe(0); });
});
describe('profile similarity', () => {
  it('is cosine over the two profiles and 0 when one is empty', () => {
    expect(profileSimilarity({ rock: 1 }, { rock: 1 })).toBeCloseTo(1, 6);
    expect(profileSimilarity({ rock: 0.5, pop: 0.5 }, { rock: 1 })).toBeCloseTo(Math.SQRT1_2, 6);
    expect(profileSimilarity({}, { rock: 1 })).toBe(0);
  });
});
describe('ranking config', () => {
  it('has a tempo weight', () => { expect(DEFAULT_RECOMMENDATION_CONFIG.weights.tempoFit).toBe(0.15); });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @now-playing/recommendations test -- tempo-and-profile`
Expected: FAIL — `tempoAffinity` not exported.

- [ ] **Step 3: Implement**

```ts
// similarity.ts — append
export function profileSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (!ka.length || !kb.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (const k of ka) { na += a[k]! ** 2; if (k in b) dot += a[k]! * b[k]!; }
  for (const k of kb) nb += b[k]! ** 2;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
export function tempoAffinity(a: number | null | undefined, b: number | null | undefined): number {
  if (!a || !b) return 0;
  const g = (x: number, y: number) => Math.exp(-((x - y) / 12) ** 2);
  return Math.max(g(a, b), 0.7 * g(a * 2, b), 0.7 * g(a, b * 2));
}
```
In `candidates.ts`: `TrackFeatures` += `genreProfile: GenreProfile; bpm: number | null;` and `trackFeatures()` returns `genreProfile: track.genreProfile ?? {}, bpm: track.bpm ?? null`. In `ranking.ts`: add `tempoFit` to `RankingWeights` and `ScoreBreakdown`; where `genreAffinity` is computed, if `seedFeatures.genreProfile` and `f.genreProfile` are both non-empty use `profileSimilarity`, else the existing list path; compute `tempoFit = tempoAffinity(seedBpm, f.bpm)` where `seedBpm` is the seed track's bpm (or the profile's preferred tempo when the seed is a taste profile — add `preferredBpm: number | null` to the profile built in `profile.ts` as the play-weighted median of known bpms; 0 affinity when null). Explanation line: `if (w.tempoFit > 0 && e.tempoFit >= 0.6) add('tempoFit', w.tempoFit, \`Because it moves at about ${bpm} bpm, like what you've been playing\`)`. In `config.ts` weights: `tempoFit: 0.15`. Any place that enumerates weights (`effectiveWeights`, mode overrides) gets the new key.

- [ ] **Step 4: Run the package's whole suite**

Run: `pnpm --filter @now-playing/recommendations test`
Expected: PASS; if a snapshot of the score breakdown exists, update it deliberately and say so in the commit.

- [ ] **Step 5: Commit**

```bash
git add packages/recommendations
git commit -m "recommendations: genre profiles compare by cosine and tempo is a ranking term

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Docs, capability rows, the plan, verify, push

**Files:**
- Modify: `docs/PROVIDER_CAPABILITIES.md` (three rows in the main table; a short "Enrichment" section)
- Modify: `.agents/plans/2026-09-21-airwave-oneshot.md` (append "Sub-project 1 — hub enrichment: what shipped, measured")
- Modify: `.agents/prompts/2026-09-26-hermes-connect-and-triage.md` (§3.6: what to check for album/genre/bpm in `/providers/resolve` and `/search`)
- Test: `pnpm verify`

- [ ] **Step 1: Write the rows and the section**

Add to the capability table after the External media tool row:
```
| Deezer (tempo) | metadata only | https://developers.deezer.com/api | none | ◐ tempo + duration by ISRC or search | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | unsupported | ⛔ | "Tempo data from Deezer" | 1/s, backoff | canonical row | — | bpm 0 = unknown |
| AcousticBrainz (tempo archive) | metadata only | https://acousticbrainz.org/data | none | ◐ by MusicBrainz id | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | unsupported | ⛔ | CC0 | archive | canonical row | — | collection ended 2022 |
| Last.fm (tags) | metadata only | https://www.last.fm/api | API key (optional) | ◐ tags → genre profile | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | unsupported | ⛔ | "Tags from Last.fm" | 5/s | canonical row | — | skipped without a key |
```
And a section:
```
## Enrichment — what a link becomes

A link or a search result is matched to a MusicBrainz recording (by ISRC, by the id a file carries, or by cleaned title + artist gated on length ± 3 s). A match fills album, release year, featured artists (from the artist credit), cover (Cover Art Archive), a weighted genre profile on one fixed vocabulary (MusicBrainz genres/tags, Last.fm tags when a key is set, the platform's own genre as a weak vote) and a tempo (Deezer → AcousticBrainz → the file's tag → the 30-second preview clip decoded in memory). Below confidence 0.5 nothing is filled; the row keeps the platform's own words and `identity.matchConfidence` says how sure the hub is. No audio is ever taken from YouTube or Spotify streams; the preview hosts are the only ones a clip is fetched from.
```

- [ ] **Step 2: Append to the plan and the Hermes prompt**

Plan: a section with the test counts from this sub-project's runs (copy the numbers from the terminal, do not remember them), the migration number, the three providers, and the two things deliberately not done (Spotify audio features; key/energy). Hermes §3.6: add "Resolve a Spotify and a SoundCloud link at `/api/v1/providers/resolve?url=` twice ten seconds apart: the second answer must carry `albumName`, `featuredArtists`, `genreProfile`, `bpm` and `bpmSource`; a YouTube link must show `identity.matchConfidence` and never a guessed album."

- [ ] **Step 3: Run the release gates**

Run: `node scripts/verify.mjs`
Expected: every gate PASS (docker included now). Fix forward anything red; do not skip.

- [ ] **Step 4: Commit and push**

```bash
git add docs/PROVIDER_CAPABILITIES.md .agents
git commit -m "docs: the enrichment providers and what a link becomes; plan and Hermes prompt updated

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin claude/airwave-oneshot-build
```
(The owner asked for this sub-project's work to be pushed; this is the one place the plan pushes.)

---

## Self-review

- **Spec coverage:** matching (T7), fills (T9), genre profile (T3, T9), Last.fm optional (T5), BPM chain incl. preview clip (T5, T8, T9, T10), contracts/storage (T1, T2), adapters + GUI rows (T5 — the Providers GUI renders the registry, so no GUI code), errors/backoff (T9 via scheduler), request-path budget (T9 `enrichResult` is DB-only), library sync hook (T11), recommender tempo + profile (T12), docs (T13). Not in this plan by design: the player listing and companion analysis (sub-projects 2 and 3).
- **Placeholders:** Task 11's two sketched tests point at existing fixtures by name rather than inventing them; the implementer copies the setup from the named tests. Task 9 stubs `preview-bpm.ts` so it compiles before Task 10 — stated explicitly.
- **Type consistency:** `EnrichmentKey`, `Match`, `MbRecordingDetail`, `BpmSource`, `GenreProfile`, `estimateTempo`, `bpmFromPreviewClip`, `PREVIEW_HOSTS`, `tempoAffinity`, `profileSimilarity`, `tempoFit` are used with the same names throughout.
- **Review Focus:** items 1 (T4), 2 (T7), 3 (T7), 4 (T5), 5 (T10) each have a pinned test.
