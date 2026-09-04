import { EQ_BAND_FREQUENCIES_HZ, EQ_GAIN_MAX_DB, EQ_GAIN_MIN_DB, EqPreset as EqPresetSchema, EqPresetJson as EqPresetJsonSchema, SCHEMA_VERSIONS, type EqBand, type EqBinding, type EqPreset, type EqPresetJson, type ResolvedEq } from '@now-playing/contracts';

export const FLAT_PRESET_ID = '00000000-0000-7000-8000-00000000f1a7';
const BUILTIN_EPOCH = '2026-01-01T00:00:00.000Z';

function graphic(gains: readonly number[]): EqBand[] {
  return EQ_BAND_FREQUENCIES_HZ.map((frequencyHz, i) => ({ frequencyHz, gainDb: gains[i] ?? 0, q: 1.1, type: 'peaking', enabled: true }));
}

function builtin(id: string, name: string, description: string, gains: readonly number[], preampDb = 0): EqPreset {
  return { id, schemaVersion: SCHEMA_VERSIONS.entities, name, kind: 'builtin', mode: 'graphic', preampDb, bands: graphic(gains), description, createdAt: BUILTIN_EPOCH, updatedAt: BUILTIN_EPOCH, deletedAt: null };
}

export const FLAT_PRESET: EqPreset = builtin(FLAT_PRESET_ID, 'Flat', 'No equalisation; the reference for bypass comparisons.', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

/** Original preset names; deliberately not described as therapeutic or scientific. */
export const BUILTIN_PRESETS: readonly EqPreset[] = [
  FLAT_PRESET,
  builtin('00000000-0000-7000-8000-00000000f1b1', 'Bass Lift', 'Gentle low-end emphasis for small headphones.', [5, 4, 3, 1, 0, 0, 0, 0, 0, 0], -3),
  builtin('00000000-0000-7000-8000-00000000f1b2', 'Bright Room', 'Adds presence and air.', [0, 0, 0, 0, 0, 1, 2, 3, 4, 4], -2),
  builtin('00000000-0000-7000-8000-00000000f1b3', 'Small Speakers', 'Trims sub-bass laptop speakers cannot reproduce and lifts the mids.', [-6, -4, -1, 1, 2, 2, 1, 1, 0, -1]),
  builtin('00000000-0000-7000-8000-00000000f1b4', 'Late Night', 'Softer highs and a touch less bass for quiet listening.', [-2, -1, 0, 0, 0, 0, -1, -2, -3, -4]),
  builtin('00000000-0000-7000-8000-00000000f1b5', 'Vocal Focus', 'Lifts the upper mids where voices sit.', [-2, -1, 0, 1, 2, 3, 3, 2, 0, -1], -2),
  builtin('00000000-0000-7000-8000-00000000f1b6', 'Loudness Contour', 'Classic low-volume contour: more lows and highs.', [4, 3, 1, 0, 0, 0, 0, 1, 2, 3], -3),
  builtin('00000000-0000-7000-8000-00000000f1b7', 'Club', 'Punchy lows and crisp highs for dance music.', [4, 5, 3, 0, -1, 0, 1, 3, 4, 3], -4),
];

/**
 * The nine frequencies of the "solfeggio" set, with the Latin syllables traditionally attached to
 * the middle six.
 *
 * They are included because people ask for them and because a music player is the right place to
 * try a tuning or an emphasis for yourself. What the presets below do is exactly what any other
 * preset does: a narrow peaking filter at that frequency. They do not synthesise a tone, they do
 * not "convert" a recording to a frequency, and nothing in this codebase claims a physical or
 * medical effect for them — see docs/DEVIATIONS.md.
 */
export const SOLFEGGIO_FREQUENCIES = [
  { hz: 174, syllable: null },
  { hz: 285, syllable: null },
  { hz: 396, syllable: 'UT' },
  { hz: 417, syllable: 'RE' },
  { hz: 528, syllable: 'MI' },
  { hz: 639, syllable: 'FA' },
  { hz: 741, syllable: 'SOL' },
  { hz: 852, syllable: 'LA' },
  { hz: 963, syllable: null },
] as const;

/** Emphasis width. Q 4 is roughly a third of an octave: clearly audible, not a whistle. */
const SOLFEGGIO_Q = 4;
const SOLFEGGIO_GAIN_DB = 6;

function parametric(id: string, name: string, description: string, bands: readonly Omit<EqBand, 'enabled' | 'type'>[], preampDb: number): EqPreset {
  return {
    id,
    schemaVersion: SCHEMA_VERSIONS.entities,
    name,
    kind: 'builtin',
    mode: 'parametric',
    preampDb,
    bands: bands.map((band) => ({ ...band, type: 'peaking' as const, enabled: true })),
    description,
    createdAt: BUILTIN_EPOCH,
    updatedAt: BUILTIN_EPOCH,
    deletedAt: null,
  };
}

/**
 * One preset per solfeggio frequency, plus one that lifts all nine at once.
 *
 * Parametric rather than graphic: the ten graphic bands are at 32 Hz … 16 kHz, and none of them
 * sits on 528 Hz. Rounding a request for 528 Hz to the 500 Hz slider would be a different filter
 * wearing the right label.
 */
export const SOLFEGGIO_PRESETS: readonly EqPreset[] = [
  ...SOLFEGGIO_FREQUENCIES.map((entry, index) =>
    parametric(
      `00000000-0000-7000-8000-0000000050${String(index + 1).padStart(2, '0')}`,
      entry.syllable ? `${entry.hz} Hz (${entry.syllable})` : `${entry.hz} Hz`,
      `A narrow +${SOLFEGGIO_GAIN_DB} dB peak at ${entry.hz} Hz, Q ${SOLFEGGIO_Q}. It emphasises what the recording already has there; it does not add a ${entry.hz} Hz tone.`,
      [{ frequencyHz: entry.hz, gainDb: SOLFEGGIO_GAIN_DB, q: SOLFEGGIO_Q }],
      -3,
    ),
  ),
  parametric(
    '00000000-0000-7000-8000-000000005010',
    'Solfeggio (all nine)',
    'A +4 dB peak at each of the nine frequencies, Q 6. Nine narrow boosts at once colour a recording heavily; the headroom trim keeps it from clipping.',
    SOLFEGGIO_FREQUENCIES.map((entry) => ({ frequencyHz: entry.hz, gainDb: 4, q: 6 })),
    -6,
  ),
];

/** Every preset the app ships with: the tone presets above, then the solfeggio set. */
export const ALL_BUILTIN_PRESETS: readonly EqPreset[] = [...BUILTIN_PRESETS, ...SOLFEGGIO_PRESETS];

export function clampGain(db: number): number {
  return Math.max(EQ_GAIN_MIN_DB, Math.min(EQ_GAIN_MAX_DB, db));
}

export interface EqScope {
  playlistId?: string | null;
  trackId?: string | null;
}

/**
 * Resolve the effective preset in this exact order:
 * per-track-per-playlist override > track default > playlist default > global default > Flat.
 */
export function resolveEq(bindings: readonly EqBinding[], scope: EqScope, presets: readonly EqPreset[], names: { playlistName?: string | null; trackTitle?: string | null } = {}): ResolvedEq {
  const live = bindings.filter((b) => !b.deletedAt);
  const presetById = new Map(presets.map((p) => [p.id, p]));
  const pick = (binding: EqBinding | undefined, source: ResolvedEq['source'], explain: (name: string) => string): ResolvedEq | null => {
    if (!binding) return null;
    const preset = presetById.get(binding.presetId);
    if (!preset || preset.deletedAt) return null;
    return { presetId: preset.id, presetName: preset.name, source, explanation: explain(preset.name) };
  };
  const { playlistId, trackId } = scope;
  const playlistName = names.playlistName ?? 'this playlist';
  const override = playlistId && trackId ? live.find((b) => b.scope === 'playlist-track' && b.playlistId === playlistId && b.trackId === trackId) : undefined;
  const track = trackId ? live.find((b) => b.scope === 'track' && b.trackId === trackId) : undefined;
  const playlist = playlistId ? live.find((b) => b.scope === 'playlist' && b.playlistId === playlistId) : undefined;
  const global = live.find((b) => b.scope === 'global');
  return (
    pick(override, 'playlist-track', (n) => `${n} — overridden for this song in ${playlistName}`) ??
    pick(track, 'track', (n) => `${n} — this song's default`) ??
    pick(playlist, 'playlist', (n) => `${n} — ${playlistName} default`) ??
    pick(global, 'global', (n) => `${n} — your default preset`) ?? { presetId: FLAT_PRESET.id, presetName: 'Flat', source: 'flat', explanation: 'Flat — no preset selected' }
  );
}

export interface EqPresetImportPlan {
  valid: boolean;
  errors: string[];
  presets: EqPreset[];
  conflicts: Array<{ incoming: EqPreset; existing: EqPreset; resolution: 'skip' | 'replace' | 'rename' }>;
}

/** Validate an import payload. No code is ever executed; unknown fields are dropped by the schema. */
export function planEqPresetImport(payload: unknown, existing: readonly EqPreset[], resolution: 'skip' | 'replace' | 'rename' = 'rename'): EqPresetImportPlan {
  const parsed = EqPresetJsonSchema.safeParse(payload);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`), presets: [], conflicts: [] };
  }
  const byId = new Map(existing.map((p) => [p.id, p]));
  const byName = new Map(existing.map((p) => [p.name.toLowerCase(), p]));
  const errors: string[] = [];
  const presets: EqPreset[] = [];
  const conflicts: EqPresetImportPlan['conflicts'] = [];
  for (const raw of parsed.data.presets) {
    const preset: EqPreset = { ...raw, kind: raw.kind === 'builtin' ? 'imported' : raw.kind, bands: raw.bands.map((b) => ({ ...b, gainDb: clampGain(b.gainDb) })) };
    const clash = byId.get(preset.id) ?? byName.get(preset.name.toLowerCase());
    if (clash) {
      conflicts.push({ incoming: preset, existing: clash, resolution });
      if (resolution === 'skip') continue;
      if (resolution === 'rename') {
        let n = 2;
        let name = `${preset.name} (${n})`;
        while (byName.has(name.toLowerCase())) name = `${preset.name} (${(n += 1)})`;
        presets.push({ ...preset, id: clash.id === preset.id ? cryptoRandomId() : preset.id, name });
        byName.set(name.toLowerCase(), preset);
        continue;
      }
      if (clash.kind === 'builtin') {
        errors.push(`Cannot replace built-in preset "${clash.name}"`);
        continue;
      }
      presets.push({ ...preset, id: clash.id });
      continue;
    }
    presets.push(preset);
    byName.set(preset.name.toLowerCase(), preset);
  }
  return { valid: errors.length === 0, errors, presets, conflicts };
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function exportEqPresets(presets: readonly EqPreset[], now: string): EqPresetJson {
  return { format: 'now-playing-eq-preset', schemaVersion: SCHEMA_VERSIONS.eqPresetJson, exportedAt: now, presets: presets.map((p) => EqPresetSchema.parse(p)) };
}

/** Optional CSV export of band values (JSON remains canonical). */
export function eqPresetToCsv(preset: EqPreset): string {
  const header = 'preset,preamp_db,frequency_hz,gain_db,q,type,enabled';
  const rows = preset.bands.map((b) => [csvCell(preset.name), preset.preampDb, b.frequencyHz, b.gainDb, b.q, b.type, b.enabled ? 'true' : 'false'].join(','));
  return [header, ...rows].join('\r\n') + '\r\n';
}

function csvCell(v: string): string {
  const needs = /[",\r\n]/.test(v) || /^[=+\-@\t\r]/.test(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return needs ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Approximate the combined magnitude response (dB) of a graphic preset at given frequencies for curve display. */
export function eqCurve(preset: EqPreset, frequencies: readonly number[], sampleRate = 48000): number[] {
  return frequencies.map((f) => {
    let db = preset.preampDb;
    for (const band of preset.bands) {
      if (!band.enabled) continue;
      db += biquadMagnitudeDb(band, f, sampleRate);
    }
    return db;
  });
}

/** RBJ cookbook magnitude response for the filter types used in the EQ. */
export function biquadMagnitudeDb(band: EqBand, freq: number, sampleRate: number): number {
  const w0 = (2 * Math.PI * band.frequencyHz) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const A = 10 ** (band.gainDb / 40);
  const Q = band.q;
  const alpha = sin / (2 * Q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (band.type) {
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + s); b1 = 2 * A * (A - 1 - (A + 1) * cos); b2 = A * (A + 1 - (A - 1) * cos - s);
      a0 = A + 1 + (A - 1) * cos + s; a1 = -2 * (A - 1 + (A + 1) * cos); a2 = A + 1 + (A - 1) * cos - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + s); b1 = -2 * A * (A - 1 + (A + 1) * cos); b2 = A * (A + 1 + (A - 1) * cos - s);
      a0 = A + 1 - (A - 1) * cos + s; a1 = 2 * (A - 1 - (A + 1) * cos); a2 = A + 1 - (A - 1) * cos - s;
      break;
    }
    case 'lowpass':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'highpass':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'notch':
      b0 = 1; b1 = -2 * cos; b2 = 1; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'peaking':
    default:
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break;
  }
  const w = (2 * Math.PI * freq) / sampleRate;
  const cw = Math.cos(w), sw = Math.sin(w), c2w = Math.cos(2 * w), s2w = Math.sin(2 * w);
  const numRe = b0 + b1 * cw + b2 * c2w, numIm = -(b1 * sw + b2 * s2w);
  const denRe = a0 + a1 * cw + a2 * c2w, denIm = -(a1 * sw + a2 * s2w);
  const mag = Math.sqrt((numRe ** 2 + numIm ** 2) / (denRe ** 2 + denIm ** 2));
  return 20 * Math.log10(Math.max(mag, 1e-9));
}

/** Headroom needed so a boosted preset cannot clip: the maximum positive band gain plus the preamp. */
export function requiredHeadroomDb(preset: EqPreset): number {
  const maxBoost = Math.max(0, ...preset.bands.filter((b) => b.enabled).map((b) => b.gainDb));
  return Math.max(0, maxBoost + preset.preampDb);
}
