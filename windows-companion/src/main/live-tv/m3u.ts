/**
 * Reading a channel playlist (M3U / M3U8).
 *
 * The format is a convention more than a standard, so this reads what IPTV playlists actually
 * carry: an `#EXTINF` line with quoted attributes and a name after the comma, an optional
 * `#EXTGRP`, then the stream's address on a line of its own. Anything it does not understand is
 * skipped rather than guessed at, and only http(s) streams count — a player in a browser can open
 * nothing else.
 *
 * Pure text in, plain records out: no network, no filesystem, so the tests are just strings.
 */

export interface M3uChannel {
  name: string;
  url: string;
  tvgId: string | null;
  logo: string | null;
  group: string | null;
  /** The playlist's own channel number (`tvg-chno`), when it gives a whole positive one. */
  chno: number | null;
}

export interface M3uResult {
  /**
   * `channels` for a list of channels; `stream` when the link is itself one HLS stream (a media or
   * master playlist), which is then a single channel rather than a list of its segments.
   */
  kind: 'channels' | 'stream';
  channels: M3uChannel[];
  /** True when the list was cut at the limit, so the caller can say so. */
  truncated: boolean;
}

/** More channels than any real playlist carries; a guard against a file that is not one. */
export const MAX_CHANNELS = 50_000;

const ATTRIBUTE = /([A-Za-z][A-Za-z0-9-]*)="([^"]*)"/g;

function clean(value: string | undefined, max: number): string | null {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function httpUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The name is whatever follows the first comma that is not inside a quoted attribute. */
function splitExtinf(line: string): { head: string; name: string } {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) return { head: line.slice(0, i), name: line.slice(i + 1) };
  }
  return { head: line, name: '' };
}

function nameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '').replace(/\.(m3u8?|ts|mpd)$/i, '');
    return (last || parsed.hostname).slice(0, 200);
  } catch {
    return 'Channel';
  }
}

export function parseM3u(input: string, limit: number = MAX_CHANNELS): M3uResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  // An HLS playlist describes one stream's segments or renditions; its lines are not channels.
  if (/^#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)\b/m.test(text)) return { kind: 'stream', channels: [], truncated: false };

  const channels: M3uChannel[] = [];
  let pending: Omit<M3uChannel, 'url'> | null = null;
  let truncated = false;

  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const { head, name } = splitExtinf(line);
      const attributes: Record<string, string> = {};
      for (const match of head.matchAll(ATTRIBUTE)) attributes[match[1]!.toLowerCase()] = match[2]!;
      const chno = Number(attributes['tvg-chno'] ?? attributes['channel-number'] ?? '');
      pending = {
        name: clean(name, 200) ?? clean(attributes['tvg-name'], 200) ?? '',
        tvgId: clean(attributes['tvg-id'], 200),
        logo: httpUrl(attributes['tvg-logo']),
        group: clean(attributes['group-title'], 200),
        chno: Number.isInteger(chno) && chno > 0 && chno < 1_000_000 ? chno : null,
      };
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      if (pending && !pending.group) pending.group = clean(line.slice('#EXTGRP:'.length), 200);
      continue;
    }
    if (line.startsWith('#')) continue;

    const url = httpUrl(line);
    const entry = pending;
    pending = null;
    if (!url) continue;
    if (channels.length >= limit) {
      truncated = true;
      break;
    }
    channels.push({ name: entry?.name || nameFromUrl(url), url, tvgId: entry?.tvgId ?? null, logo: entry?.logo ?? null, group: entry?.group ?? null, chno: entry?.chno ?? null });
  }

  return { kind: 'channels', channels, truncated };
}

/** The one channel a link is when it turned out to be a stream itself. */
export function channelFromStream(url: string): M3uChannel {
  return { name: nameFromUrl(url), url, tvgId: null, logo: null, group: null, chno: null };
}
