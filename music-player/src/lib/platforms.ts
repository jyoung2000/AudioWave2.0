/**
 * What each platform actually allows — carried by the player itself.
 *
 * Until now the player only knew what a paired hub told it, so with no hub it could say nothing
 * about YouTube or Spotify at all. That is the wrong way round: the question "can I get my Spotify
 * library in here?" is asked *before* anyone pairs anything, and the answer does not depend on a
 * hub. So this table ships in the player, is reviewed against each platform's own published terms,
 * and is merged with the live capability states a hub reports when one is paired.
 *
 * Three columns, because they are three different questions and platforms answer them differently:
 *
 *   Play here    — can this app put sound out of this device from that platform?
 *   Keep offline — can a copy live in your library and play with the network off?
 *   Save a file  — can you end up with a file of your own on your disk?
 *
 * The honest summary of the whole table: **no platform lets an app take audio out of its stream.**
 * Spotify's and YouTube's audio is protected and their terms forbid it; getting past either would
 * mean circumventing protection or scraping, which this project does not do and this browser would
 * not permit (docs/DOWNLOADS_AND_LEGAL.md). What the platforms *do* offer is an export of the music
 * that is already yours — a Bandcamp purchase, a Google Takeout of your YouTube Music uploads, a
 * SoundCloud track whose creator turned downloads on — and every one of those arrives as files this
 * player can read. That route is `bringIn`, and it is the one that works with no key and no hub.
 *
 * Keep in step with docs/PROVIDER_CAPABILITIES.md and with `PROVIDER_MARKS`; a unit test fails if a
 * platform appears in one and not the others.
 */
import type { CapabilityState, HelperHealth, HelperToolId, KnownProvider, ProviderDescriptor } from '@now-playing/contracts';
import { KNOWN_PROVIDERS } from '@now-playing/contracts';
import { markFor } from '@now-playing/aqua-ui';

export interface PlatformRoute {
  state: CapabilityState;
  /** Why it is what it is. Shown next to it, always — a state with no reason is a shrug. */
  detail: string;
}

/**
 * What a tool running beside the player can do — which is a different question from what the
 * platform permits, and is kept in a different field for that reason. A local yt-dlp does not
 * change YouTube's terms; it changes what is technically possible on this machine. Collapsing the
 * two would turn an honest "No" into a "Yes" the app has no standing to say.
 */
export interface ToolNote {
  tool: HelperToolId;
  available: boolean;
  detail: string;
}

export interface Platform {
  provider: KnownProvider;
  name: string;
  /** What this platform is to this app, in one line. */
  summary: string;
  play: PlatformRoute;
  keep: PlatformRoute;
  save: PlatformRoute;
  /** How music from here legitimately reaches your library, or null when there is no route. */
  bringIn: string | null;
  /** True when the route exists only through a paired hub, because it needs a key or a server. */
  needsHub: boolean;
  home: string | null;
  /** The document that decides the answers above. */
  terms: string | null;
  /** Set only while a helper is actually answering. Absent means nobody asked and nothing is claimed. */
  viaTool?: ToolNote;
}

/**
 * Which hosts belong to which platform, for matching against a helper's allowlist. Kept beside the
 * table rather than inside each row: it is a fact about addresses, not about permissions, and every
 * row that does not appear here simply has no tool route.
 */
const PLATFORM_HOSTS: Partial<Record<KnownProvider, readonly string[]>> = {
  youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'],
  soundcloud: ['soundcloud.com', 'api.soundcloud.com', 'on.soundcloud.com'],
  spotify: ['open.spotify.com'],
  bandcamp: ['bandcamp.com'],
  'public-domain': ['archive.org'],
};

const YES = (detail: string): PlatformRoute => ({ state: 'available', detail });
const AUTH = (detail: string): PlatformRoute => ({ state: 'requires_auth', detail });
const SOME = (detail: string): PlatformRoute => ({ state: 'restricted', detail });
const NO = (detail: string): PlatformRoute => ({ state: 'unsupported', detail });

/** Reviewed 2026-09-15 against each platform's published terms; sources in the docs column. */
export const PLATFORMS: readonly Platform[] = [
  {
    provider: 'local',
    name: 'This device',
    summary: 'The folders and files you added. This is the player’s home ground and needs nothing else.',
    play: YES('The file is here, decoded here, and goes through the equaliser and the crossfade like everything else.'),
    keep: YES('Already offline. Files chosen with the file picker are copied into the app so they survive a reload.'),
    save: YES('Download… writes a copy — the original, or a FLAC or WAV made from it — wherever you chose in Downloads.'),
    bringIn: 'Add folder, or Choose files. A .zip from any platform can be imported the same way.',
    needsHub: false,
    home: null,
    terms: null,
  },
  {
    provider: 'hub',
    name: 'Your hub',
    summary: 'Your own container on your own network, holding the music you put there.',
    play: AUTH('Pair a hub in Settings. It streams its files to this player over your network, with ranges, so seeking works.'),
    keep: NO('This player does not keep a second copy of a hub file. Add that folder to this device if you want it offline.'),
    save: SOME('The hub can serve you the file it holds; this player’s Download… only writes copies of files it can reach here.'),
    bringIn: 'Anything you put in the hub’s library folder.',
    needsHub: true,
    home: null,
    terms: null,
  },
  {
    provider: 'companion',
    name: 'Windows companion',
    summary: 'A PC’s library, offered to your hub by the companion app running on it.',
    play: AUTH('Only after the companion authorises a transfer to the hub. Until then the hub has a listing, not a file.'),
    keep: NO('What arrives lands on the hub, not in this player.'),
    save: SOME('Once a transfer completes the file is the hub’s, and is yours on the terms you already had for it.'),
    bringIn: 'A completed transfer, or the same folder added directly to this device.',
    needsHub: true,
    home: null,
    terms: null,
  },
  {
    provider: 'musicbrainz',
    name: 'MusicBrainz',
    summary: 'Names, releases and identities. It is a catalogue, never a source of audio.',
    play: NO('MusicBrainz has no audio. It tells you what a recording *is*, so two copies of the same song can be recognised as one.'),
    keep: NO('There is nothing to keep — the data is used to label tracks you already have.'),
    save: NO('MusicBrainz serves no audio at all, so there is nothing here that could be saved.'),
    bringIn: null,
    needsHub: true,
    home: 'https://musicbrainz.org/',
    terms: 'https://musicbrainz.org/doc/MusicBrainz_API',
  },
  {
    provider: 'youtube',
    name: 'YouTube',
    summary: 'Search and metadata through the Data API; playback only inside YouTube’s own embedded player.',
    play: SOME('The embed plays in a frame the hub shows. Its audio never reaches this app, so the equaliser, crossfade and the visualiser do not apply to it.'),
    keep: NO('The embed is a player, not a file. Nothing is stored and nothing plays with the network off.'),
    save: NO('YouTube’s API Services Terms of Service prohibit downloading content, and no permitted route exists. This app will not work around that.'),
    bringIn: 'Google Takeout exports the music you uploaded to YouTube Music as .zip files. Those are your own files — import the .zip and they become library tracks.',
    needsHub: true,
    home: 'https://music.youtube.com/',
    terms: 'https://developers.google.com/youtube/terms/api-services-terms-of-service',
  },
  {
    provider: 'soundcloud',
    name: 'SoundCloud',
    summary: 'Search, your likes and playlists, and streams for tracks the uploader made playable.',
    play: AUTH('Sign in through the hub. A track plays when SoundCloud reports it playable; some are preview-only or region-locked, and the row says which.'),
    keep: SOME('Only a track whose creator turned on Download. That file is offered to you deliberately, so it can live in your library.'),
    save: SOME('Same rule: the Download button appears for tracks marked downloadable, and for nothing else.'),
    bringIn: 'Download a downloadable track from SoundCloud, then add that folder — or import the .zip if you grabbed a set.',
    needsHub: true,
    home: 'https://soundcloud.com/',
    terms: 'https://developers.soundcloud.com/docs/api/guide.html',
  },
  {
    provider: 'bandcamp',
    name: 'Bandcamp',
    summary: 'Where you buy the music. No public API, so this app links out rather than pretending to search it.',
    play: NO('There is no public API to play from. A Bandcamp track opens on Bandcamp.'),
    keep: SOME('Music you bought is yours, in whatever format you chose at checkout — including FLAC.'),
    save: SOME('Bandcamp itself gives you the files; this app does not need to and does not try.'),
    bringIn: 'A purchase downloads as a .zip. Import it and the whole album lands in your library, artwork and tags included.',
    needsHub: false,
    home: 'https://bandcamp.com/',
    terms: 'https://bandcamp.com/terms_of_use',
  },
  {
    provider: 'spotify',
    name: 'Spotify',
    summary: 'Your library and playlists as lists, and — with Premium — playback through Spotify’s own browser SDK.',
    play: SOME('Premium only, through the Web Playback SDK the hub hosts. It plays into its own output, so this app’s equaliser and crossfade cannot touch it.'),
    keep: NO('Spotify’s audio is protected and its offline mode belongs to Spotify’s own apps. Nothing can be kept here.'),
    save: NO('The Web API offers no audio download at all. There is no permitted route, and this app will not circumvent the protection that enforces that.'),
    bringIn: 'Import your playlists and likes as *lists*: the songs are matched to copies you already own, so the ordering survives even though the audio never leaves Spotify.',
    needsHub: true,
    home: 'https://open.spotify.com/',
    terms: 'https://developer.spotify.com/documentation/web-api',
  },
  {
    provider: 'public-domain',
    name: 'Public domain',
    summary: 'Generated tones the project ships, so every path here can be exercised end to end without an account.',
    play: YES('Plays like any other file.'),
    keep: YES('Copied into your library on request.'),
    save: YES('Free to save in any format the encoders can produce.'),
    bringIn: 'Served by the hub, or added from the fixtures folder.',
    needsHub: false,
    home: null,
    terms: null,
  },
  {
    provider: 'external-tool',
    name: 'External tool',
    summary: 'An optional binary a hub administrator may enable for content they are entitled to download.',
    play: NO('It is a fetcher, not a source. Whatever it produces becomes an ordinary file.'),
    keep: SOME('Off by default. Enabling it requires an administrator to accept, in writing, that it is used only for content they hold the rights to.'),
    save: SOME('Same condition. Hosts are allow-listed, no cookies are passed, and nothing that carries protection is touched.'),
    bringIn: 'Whatever it produces lands in the hub’s library.',
    needsHub: true,
    home: null,
    terms: null,
  },
];

export function platform(provider: string): Platform | undefined {
  return PLATFORMS.find((p) => p.provider === provider);
}

/** The order the settings table shows: what works here first, what needs a hub after. */
export function platformsInOrder(): Platform[] {
  return [...PLATFORMS].sort((a, b) => Number(a.needsHub) - Number(b.needsHub) || a.name.localeCompare(b.name));
}

export function displayName(provider: string): string {
  return platform(provider)?.name ?? markFor(provider).name;
}

/**
 * A hub knows things this table cannot: whether its administrator configured YouTube at all,
 * whether a token expired, whether a provider's circuit is open right now. Where it reports a
 * *worse* state than the table promises, the hub wins — the table is a ceiling, never a claim that
 * something is working.
 */
export function withHubReport(platforms: readonly Platform[], descriptors: readonly ProviderDescriptor[] | null): Platform[] {
  if (!descriptors?.length) return [...platforms];
  const byProvider = new Map(descriptors.map((d) => [d.provider, d]));
  return platforms.map((p) => {
    const live = byProvider.get(p.provider);
    if (!live) return p;
    if (!live.enabled || !live.configured) {
      const detail = live.enabled ? `${p.name} is not configured on your hub yet.` : `${p.name} is switched off on your hub.`;
      return { ...p, play: worse(p.play, { state: 'temporarily_unavailable', detail }), keep: worse(p.keep, { state: 'temporarily_unavailable', detail }), save: worse(p.save, { state: 'temporarily_unavailable', detail }) };
    }
    return {
      ...p,
      play: worse(p.play, { state: live.capabilities.playback, detail: live.capabilities.reason ?? p.play.detail }),
      keep: worse(p.keep, { state: live.capabilities.userOwnedDownload, detail: live.capabilities.reason ?? p.keep.detail }),
      save: worse(p.save, { state: live.capabilities.creatorDownload, detail: live.capabilities.reason ?? p.save.detail }),
    };
  });
}

/** Ranked worst-first, so `worse` can pick without a table of every pairing. */
const SEVERITY: Record<CapabilityState, number> = { unsupported: 0, temporarily_unavailable: 1, restricted: 2, requires_auth: 3, available: 4 };

function worse(a: PlatformRoute, b: PlatformRoute): PlatformRoute {
  return SEVERITY[b.state] < SEVERITY[a.state] ? b : a;
}

/**
 * Fold in what a running helper can do.
 *
 * Note what this does *not* touch: `play`, `keep` and `save` come back exactly as they were. Those
 * three answer "what does this platform allow", and no amount of software on your own machine
 * changes that answer. The helper adds a fourth statement — "a tool you installed can reach this,
 * and you are the one saying you are entitled to" — which is true, and is different.
 */
export function withHelper(platforms: readonly Platform[], health: HelperHealth | null): Platform[] {
  if (!health) return [...platforms];
  return platforms.map((platform) => {
    const hosts = PLATFORM_HOSTS[platform.provider];
    if (!hosts?.some((host) => health.allowedHosts.includes(host))) return platform;
    const tool: HelperToolId = platform.provider === 'spotify' ? 'spotdl' : 'yt-dlp';
    const found = health.tools.find((entry) => entry.id === tool);
    if (!found?.present) {
      return { ...platform, viaTool: { tool, available: false, detail: found?.installHint ?? `${tool} is not installed where your helper can see it.` } };
    }
    return { ...platform, viaTool: { tool, available: true, detail: toolDetail(platform.provider, tool) } };
  });
}

function toolDetail(provider: KnownProvider, tool: HelperToolId): string {
  if (provider === 'spotify') {
    // The thing people most often have backwards, and the one place it would be easy to imply
    // something untrue by saying nothing.
    return 'spotDL is running beside the player. It never takes Spotify’s audio — it reads Spotify for the track list and fetches a match from YouTube Music, so what you get is a re-recording of the same song, not Spotify’s file.';
  }
  return `${tool} is running beside the player and can fetch from here. Whether you may is between you and this platform: the player asks what entitles you to each file and sends that with the request.`;
}

export const ROUTE_LABELS: Record<CapabilityState, string> = {
  available: 'Yes',
  requires_auth: 'Sign in',
  restricted: 'Sometimes',
  temporarily_unavailable: 'Not now',
  unsupported: 'No',
};

export const ROUTE_TONE: Record<CapabilityState, 'ok' | 'warning' | 'neutral' | 'info'> = {
  available: 'ok',
  requires_auth: 'info',
  restricted: 'warning',
  temporarily_unavailable: 'warning',
  unsupported: 'neutral',
};

/** Every slug the contracts know about has a row here. Asserted by a test, not by hope. */
export const COVERED: ReadonlySet<string> = new Set(PLATFORMS.map((p) => p.provider));
export const UNCOVERED: readonly string[] = KNOWN_PROVIDERS.filter((p) => !COVERED.has(p));
