import { PlaylistJson as PlaylistJsonSchema, SCHEMA_VERSIONS, type EqPreset, type Playlist, type PlaylistItem, type PlaylistJson, type TrackRef } from '@now-playing/contracts';
import { isSafeRelativePath } from './security.js';

export interface M3uEntry {
  path: string;
  title: string | null;
  durationSeconds: number | null;
}

/** Parse M3U/M3U8 (#EXTINF aware). Absolute paths and traversal are rejected; only relative entries or https URLs are kept. */
export function parseM3u(text: string): { entries: M3uEntry[]; rejected: Array<{ line: number; reason: string }> } {
  const lines = text.replace(/^\ufeff/, '').split(/\r?\n/);
  const entries: M3uEntry[] = [];
  const rejected: Array<{ line: number; reason: string }> = [];
  let pending: { title: string | null; duration: number | null } | null = null;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('#EXTINF:')) {
      const m = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)?\s*,?(.*)$/.exec(line);
      pending = { duration: m?.[1] ? Number(m[1]) : null, title: m?.[2]?.trim() || null };
      return;
    }
    if (line.startsWith('#')) return;
    const isUrl = /^https?:\/\//i.test(line);
    if (!isUrl && !isSafeRelativePath(line)) {
      rejected.push({ line: i + 1, reason: 'absolute path or traversal' });
      pending = null;
      return;
    }
    if (isUrl && !/^https:\/\//i.test(line)) {
      rejected.push({ line: i + 1, reason: 'only https URLs are accepted' });
      pending = null;
      return;
    }
    entries.push({ path: line, title: pending?.title ?? null, durationSeconds: pending?.duration ?? null });
    pending = null;
  });
  return { entries, rejected };
}

export function serializeM3u(items: ReadonlyArray<{ relativePath: string; title: string; artistName: string; durationMs: number | null }>): string {
  const lines = ['#EXTM3U'];
  for (const it of items) {
    const secs = it.durationMs ? Math.round(it.durationMs / 1000) : -1;
    lines.push(`#EXTINF:${secs},${it.artistName} - ${it.title}`);
    lines.push(it.relativePath.replace(/\\/g, '/'));
  }
  return lines.join('\n') + '\n';
}

export function buildPlaylistJson(playlist: Playlist, items: readonly PlaylistItem[], presets: readonly EqPreset[], now: string, exportedBy?: string): PlaylistJson {
  const referenced = new Set<string>();
  if (playlist.eqPresetId) referenced.add(playlist.eqPresetId);
  for (const it of items) if (it.eqOverridePresetId) referenced.add(it.eqOverridePresetId);
  const json: PlaylistJson = {
    format: 'now-playing-playlist',
    schemaVersion: SCHEMA_VERSIONS.playlistJson,
    exportedAt: now,
    playlist: { id: playlist.id, name: playlist.name, description: playlist.description, eqPresetId: playlist.eqPresetId, kind: playlist.kind, mood: playlist.mood, activity: playlist.activity },
    items: items.filter((i) => !i.deletedAt).sort((a, b) => a.position - b.position).map((i) => ({ id: i.id, position: i.position, track: stripLocalLocators(i.track), eqOverridePresetId: i.eqOverridePresetId, note: i.note })),
    presets: presets.filter((p) => referenced.has(p.id) && p.kind !== 'builtin'),
  };
  if (exportedBy) json.exportedBy = exportedBy;
  return json;
}

/** Locators that only make sense on the exporting device are dropped; provider/hub locators travel. */
function stripLocalLocators(track: TrackRef): TrackRef {
  return { ...track, locators: track.locators.filter((l) => l.kind === 'provider' || l.kind === 'hub-blob') };
}

export function parsePlaylistJson(payload: unknown): { ok: true; data: PlaylistJson } | { ok: false; errors: string[] } {
  const parsed = PlaylistJsonSchema.safeParse(payload);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, errors: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
