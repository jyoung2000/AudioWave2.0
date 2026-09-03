import { describe, expect, it } from 'vitest';
import type { EqBinding, EqPreset } from '@now-playing/contracts';
import { BUILTIN_PRESETS, FLAT_PRESET, biquadMagnitudeDb, eqCurve, eqPresetToCsv, exportEqPresets, planEqPresetImport, requiredHeadroomDb, resolveEq } from '../../src/eq.js';

const NOW = '2026-09-03T12:00:00.000Z';
const preset = (id: string, name: string): EqPreset => ({ ...FLAT_PRESET, id, name, kind: 'user', createdAt: NOW, updatedAt: NOW });
const club = preset('0192b1f0-0000-7000-8000-00000000c1b0', 'Club EQ');
const chill = preset('0192b1f0-0000-7000-8000-00000000c1b1', 'Chill');
const drive = preset('0192b1f0-0000-7000-8000-00000000c1b2', 'Drive');
const global = preset('0192b1f0-0000-7000-8000-00000000c1b3', 'Everyday');
const presets = [FLAT_PRESET, club, chill, drive, global];
const bind = (scope: EqBinding['scope'], presetId: string, extra: Partial<EqBinding> = {}): EqBinding => ({ id: `0192b1f0-0000-7000-8000-00000000b${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`, schemaVersion: 1, createdAt: NOW, updatedAt: NOW, deletedAt: null, scope, presetId, playlistId: null, trackId: null, ...extra });
const PL = '0192b1f0-0000-7000-8000-00000000aaaa';
const TR = '0192b1f0-0000-7000-8000-00000000bbbb';

describe('EQ precedence', () => {
  it('falls back to Flat', () => {
    expect(resolveEq([], { playlistId: PL, trackId: TR }, presets).source).toBe('flat');
  });
  it('resolves in exact order: playlist-track > track > playlist > global > flat', () => {
    const bindings = [bind('global', global.id), bind('playlist', drive.id, { playlistId: PL }), bind('track', chill.id, { trackId: TR }), bind('playlist-track', club.id, { playlistId: PL, trackId: TR })];
    const r = resolveEq(bindings, { playlistId: PL, trackId: TR }, presets, { playlistName: 'Road Trip' });
    expect(r.source).toBe('playlist-track');
    expect(r.explanation).toBe('Club EQ — overridden for this song in Road Trip');
    expect(resolveEq(bindings.slice(0, 3), { playlistId: PL, trackId: TR }, presets).presetName).toBe('Chill');
    expect(resolveEq(bindings.slice(0, 2), { playlistId: PL, trackId: TR }, presets).presetName).toBe('Drive');
    expect(resolveEq(bindings.slice(0, 1), { playlistId: PL, trackId: TR }, presets).presetName).toBe('Everyday');
    expect(resolveEq(bindings, { playlistId: 'other', trackId: 'other' }, presets).presetName).toBe('Everyday');
  });
  it('ignores tombstoned bindings and missing presets', () => {
    const bindings = [bind('track', chill.id, { trackId: TR, deletedAt: NOW }), bind('global', 'missing')];
    expect(resolveEq(bindings, { trackId: TR }, presets).source).toBe('flat');
  });
});

describe('EQ presets import/export', () => {
  it('round-trips and detects conflicts', () => {
    const json = exportEqPresets([club], NOW);
    const plan = planEqPresetImport(json, [club], 'rename');
    expect(plan.valid).toBe(true);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.presets[0]!.name).toBe('Club EQ (2)');
    const skip = planEqPresetImport(json, [club], 'skip');
    expect(skip.presets).toHaveLength(0);
    const replace = planEqPresetImport(json, [club], 'replace');
    expect(replace.presets[0]!.id).toBe(club.id);
  });
  it('rejects invalid payloads without executing anything', () => {
    const plan = planEqPresetImport({ format: 'now-playing-eq-preset', schemaVersion: 1, exportedAt: NOW, presets: [{ ...club, bands: [{ frequencyHz: 100, gainDb: 99 }] }] }, []);
    expect(plan.valid).toBe(false);
    expect(plan.errors[0]).toContain('gainDb');
    expect(planEqPresetImport('<script>alert(1)</script>', []).valid).toBe(false);
  });
  it('never replaces built-ins', () => {
    const plan = planEqPresetImport(exportEqPresets([{ ...FLAT_PRESET, kind: 'user', name: 'Flat' }], NOW), BUILTIN_PRESETS, 'replace');
    expect(plan.valid).toBe(false);
  });
  it('csv export sanitizes formulas', () => {
    const csv = eqPresetToCsv({ ...club, name: '=cmd()' });
    expect(csv.split('\r\n')[1]).toMatch(/^"'=cmd\(\)"/);
  });
});

describe('EQ maths', () => {
  it('peaking filter gain equals band gain at centre and ~0 far away', () => {
    const band = { frequencyHz: 1000, gainDb: 6, q: 1.1, type: 'peaking' as const, enabled: true };
    expect(biquadMagnitudeDb(band, 1000, 48000)).toBeCloseTo(6, 1);
    expect(Math.abs(biquadMagnitudeDb(band, 40, 48000))).toBeLessThan(0.3);
    const curve = eqCurve({ ...FLAT_PRESET, bands: [band] }, [1000]);
    expect(curve[0]).toBeCloseTo(6, 1);
    expect(requiredHeadroomDb({ ...FLAT_PRESET, preampDb: -3, bands: [band] })).toBe(3);
  });
});
