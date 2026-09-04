/**
 * The equaliser.
 *
 * Three things it insists on, all of them audible rather than cosmetic:
 *
 * - **Bypass is level-matched.** Comparing "EQ on" against a quieter "EQ off" is not a comparison,
 *   it is a loudness test — louder always wins. The engine matches the bypass level so the switch
 *   compares tone, and the panel says so.
 * - **Headroom is shown, not hidden.** Boosting five bands by 8 dB will clip; the trim that prevents
 *   it is displayed with its value.
 * - **Retuning reports what actually happened.** If the worklet is unavailable and the fallback
 *   changed playback speed, the tempo changed too, and the panel says that rather than claiming
 *   "preserve tempo".
 */
import { useMemo, useState } from 'react';
import { Button, Checkbox, KeyValueList, Panel, PanelSection, PopUpMenu, Slider, StatusDot, TextField, useToast } from '@now-playing/aqua-ui';
import { EQ_BAND_FREQUENCIES_HZ, EQ_GAIN_MAX_DB, EQ_GAIN_MIN_DB } from '@now-playing/contracts';
import { ALL_BUILTIN_PRESETS, eqCurve, exportEqPresets, planEqPresetImport, requiredHeadroomDb, SOLFEGGIO_PRESETS, uuidv7 } from '@now-playing/domain';
import type { EqPreset } from '@now-playing/contracts';
import { useAppState, usePlayer } from '../state/context.js';

const CURVE_FREQUENCIES = Array.from({ length: 96 }, (_, i) => 20 * (20000 / 20) ** (i / 95));

export function EqualiserView() {
  const { store } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const engine = state.playback.engine;
  const [presetName, setPresetName] = useState('');

  const active = state.presets.find((p) => p.id === state.resolvedEq.presetId) ?? ALL_BUILTIN_PRESETS[0]!;
  const bands = engine?.bands ?? active.bands;
  const headroom = useMemo(() => requiredHeadroomDb({ ...active, bands: bands as EqPreset['bands'], preampDb: engine?.preampDb ?? active.preampDb }), [active, bands, engine?.preampDb]);
  const curve = useMemo(() => eqCurve({ ...active, bands: bands as EqPreset['bands'], preampDb: engine?.preampDb ?? active.preampDb }, CURVE_FREQUENCIES), [active, bands, engine?.preampDb]);

  const entry = state.queue[state.queueIndex] ?? null;
  const isSolfeggio = SOLFEGGIO_PRESETS.some((p) => p.id === active.id);

  return (
    <>
      <div className="np-section-head">
        <h2>Equaliser</h2>
        <p>Ten bands, a preamp, and an honest account of what each one does to the signal.</p>
      </div>
      <Panel title="Equaliser">
        <PanelSection>
          {/*
            * The iTunes equaliser window from the supplied screenshot: On beside the preset menu,
            * then a preamp and ten bands on a ±12 dB scale. The frequencies are the app's real band
            * centres — 32 through 16K — because they already were the ones in the picture.
            */}
          <div className="eqw">
            <div className="eqw__head">
              <Checkbox checked={!(engine?.bypassed ?? false)} onChange={(e) => store.setBypass(!e.currentTarget.checked)}>
                On
              </Checkbox>
              <PopUpMenu
                label="Preset"
                hideLabel
                value={state.resolvedEq.presetId ?? ''}
                onChange={(e) => void store.bindPreset('global', e.currentTarget.value)}
                options={state.presets.map((p) => ({ value: p.id, label: p.kind === 'builtin' ? `${p.name} (built in)` : p.name }))}
              />
            </div>

            <div className="eqw__bank" role="group" aria-label="Equaliser bands">
              <div className="eqw__scale" aria-hidden="true">
                <span>+12 dB</span>
                <span>0 dB</span>
                <span>−12 dB</span>
              </div>
              <div className="eqw__band eqw__band--preamp">
                <Slider
                  label="Preamp"
                  orientation="vertical"
                  min={-12}
                  max={12}
                  step={0.5}
                  value={engine?.preampDb ?? active.preampDb}
                  onChange={(value) => store.playback.setPreamp(value)}
                  format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
                />
                <span className="eqw__label">Preamp</span>
              </div>
              {bands.map((band, index) => (
                <div className="eqw__band" key={band.frequencyHz}>
                  <Slider
                    // The visible label is the short EQ convention ("1K"); the accessible name spells
                    // out the frequency, which matters more once a parametric preset puts a band on
                    // 528 Hz rather than on one of the familiar graphic centres.
                    label={`${band.frequencyHz} Hz band`}
                    orientation="vertical"
                    min={EQ_GAIN_MIN_DB}
                    max={EQ_GAIN_MAX_DB}
                    step={0.5}
                    value={band.gainDb}
                    onChange={(value) => store.playback.setBandGain(index, value)}
                    format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
                  />
                  <span className="eqw__label">{formatFrequency(band.frequencyHz)}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="player-hint">{state.resolvedEq.explanation}</p>
          {isSolfeggio ? (
            <p className="player-hint">
              {active.description} These presets are filters, the same as every other preset here: they change how loud that part of the recording is. They do not generate a tone, they do not retune the
              music (the Retuning panel below does that), and this app makes no claim that any frequency has a physical or medical effect.
            </p>
          ) : null}

          <EqCurve values={curve} frequencies={CURVE_FREQUENCIES} />

          <div className="player-toolbar-row">
            <Checkbox checked={engine?.limiterEnabled ?? true} onChange={(e) => store.playback.setLimiter(e.currentTarget.checked)}>
              Limiter
            </Checkbox>
          </div>
          <p className="player-hint">
            Switching <strong>On</strong> off is a level-matched bypass: it plays the unprocessed signal at the same loudness as the processed one, so the switch compares tone rather than volume. A louder
            signal always sounds better; matching the level is the only way the comparison means anything.
          </p>
        </PanelSection>

        <PanelSection title="What the equaliser is doing to the signal">
          <KeyValueList
            items={[
              { key: 'Headroom needed', value: `${headroom.toFixed(1)} dB` },
              { key: 'Trim applied', value: engine ? `${engine.headroomTrimDb.toFixed(1)} dB — keeps the boosted signal below full scale so it cannot clip` : '—' },
              { key: 'Bypass matched at', value: engine ? `${engine.bypassMatchedGainDb.toFixed(1)} dB` : '—' },
              { key: 'Limiter', value: engine?.limiterEnabled ? 'On — catches transients the trim does not' : 'Off — loud boosts may clip' },
              {
                key: 'Applied to',
                value: state.playback.dspUnavailableReason ? (
                  <span className="player-inline-status">
                    <StatusDot kind="warning" label="Nothing" /> {state.playback.dspUnavailableReason}
                  </span>
                ) : (
                  entry?.track.title ?? 'the next thing you play'
                ),
              },
            ]}
          />
        </PanelSection>

        <PanelSection title="Save, import and export">
          <form
            className="player-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const name = presetName.trim();
              if (!name || !engine) return;
              const now = new Date().toISOString();
              const preset: EqPreset = {
                id: uuidv7(),
                schemaVersion: 1,
                createdAt: now,
                updatedAt: now,
                deletedAt: null,
                name,
                kind: 'user',
                mode: 'graphic',
                preampDb: engine.preampDb,
                bands: engine.bands.map((b) => ({ frequencyHz: b.frequencyHz, gainDb: b.gainDb, q: b.q, type: b.type, enabled: b.enabled })),
                description: null,
              };
              void store.savePreset(preset).then(() => {
                setPresetName('');
                toast.show(`Saved “${name}”`, { kind: 'success' });
              });
            }}
          >
            <TextField label="Save current settings as" value={presetName} onChange={(e) => setPresetName(e.currentTarget.value)} placeholder="My headphones" />
            <Button type="submit" disabled={!presetName.trim() || !engine}>
              Save
            </Button>
          </form>
          <div className="player-toolbar-row">
            <Button
              size="small"
              onClick={() => {
                const payload = exportEqPresets(state.presets.filter((p) => p.kind !== 'builtin'), new Date().toISOString());
                downloadJson(payload, `now-playing-presets-${new Date().toISOString().slice(0, 10)}.json`);
              }}
            >
              Export my presets
            </Button>
            <Button size="small" onClick={() => importPresets(store, state.presets, toast)} ellipsis>
              Import presets
            </Button>
            {state.resolvedEq.presetId && !ALL_BUILTIN_PRESETS.some((p) => p.id === state.resolvedEq.presetId) ? (
              <Button size="small" variant="destructive" onClick={() => void store.deletePreset(state.resolvedEq.presetId!)}>
                Delete “{state.resolvedEq.presetName}”
              </Button>
            ) : null}
          </div>
        </PanelSection>
      </Panel>

      <RetunePanel />
    </>
  );
}

function RetunePanel() {
  const { store } = usePlayer();
  const state = useAppState();
  const applied = state.playback.engine?.retune;

  return (
    <Panel title="Retuning">
      <PanelSection>
        <p className="player-hint">
          Plays music at a different reference pitch — 432 Hz instead of the standard 440 Hz, for instance. This shifts the pitch of an existing recording; it does not recreate what the musicians would have
          played at that tuning.
        </p>
        <PopUpMenu
          label="Mode"
          value={state.retune.mode}
          onChange={(e) => void store.setRetune({ ...state.retune, mode: e.currentTarget.value as typeof state.retune.mode, updatedAt: new Date().toISOString() })}
          options={[
            { value: 'off', label: 'Off — original pitch' },
            { value: 'preserve-tempo', label: 'Shift pitch, keep tempo' },
            { value: 'linked-speed', label: 'Change speed (pitch and tempo together)' },
          ]}
        />
        <Slider
          label="Reference pitch (A4)"
          min={400}
          max={480}
          step={1}
          value={state.retune.referenceHz}
          onChange={(value) => void store.setRetune({ ...state.retune, referenceHz: value, updatedAt: new Date().toISOString() })}
          format={(v) => `${v} Hz`}
        />
        <Slider
          label="Additional offset"
          min={-100}
          max={100}
          step={1}
          value={state.retune.pitchOffsetCents}
          onChange={(value) => void store.setRetune({ ...state.retune, pitchOffsetCents: value, updatedAt: new Date().toISOString() })}
          format={(v) => `${v > 0 ? '+' : ''}${v} cents`}
        />
        <KeyValueList
          items={[
            { key: 'Shift', value: `${((1200 * Math.log2(state.retune.referenceHz / 440)) + state.retune.pitchOffsetCents).toFixed(1)} cents` },
            { key: 'How it is applied', value: applied ? describeApplication(applied.applied) : 'Starts with the first play' },
            ...(state.retuneNote ? [{ key: 'Note', value: state.retuneNote }] : []),
          ]}
        />
      </PanelSection>
    </Panel>
  );
}

function describeApplication(applied: string): string {
  switch (applied) {
    case 'worklet':
      return 'A pitch-shifting worklet: the tempo is unchanged.';
    case 'playback-rate':
      return 'By changing playback speed, so the tempo changes with the pitch.';
    default:
      return 'Not applied.';
  }
}

/** The response curve, drawn as an SVG so it scales and prints. */
function EqCurve({ values, frequencies }: { values: readonly number[]; frequencies: readonly number[] }) {
  const width = 640;
  const height = 120;
  const toY = (db: number): number => height / 2 - (db / 15) * (height / 2 - 8);
  const toX = (index: number): number => (index / (frequencies.length - 1)) * width;
  const path = values.map((db, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(db).toFixed(1)}`).join(' ');
  const peak = Math.max(...values.map(Math.abs));
  return (
    <svg className="player-eq-curve" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Equaliser response curve, peak deviation ${peak.toFixed(1)} decibels`} preserveAspectRatio="none">
      <line x1="0" y1={height / 2} x2={width} y2={height / 2} className="player-eq-curve__zero" />
      <path d={path} className="player-eq-curve__line" />
    </svg>
  );
}

function formatFrequency(hz: number): string {
  // "1K", not "1k": the equaliser this is drawn from sets its band labels in caps.
  return hz >= 1000 ? `${hz / 1000}K` : String(hz);
}

function downloadJson(payload: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function importPresets(store: ReturnType<typeof usePlayer>['store'], existing: readonly EqPreset[], toast: ReturnType<typeof useToast>): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    // The payload is validated against the schema and never executed; unknown fields are dropped.
    const plan = planEqPresetImport(JSON.parse(await file.text()), existing, 'rename');
    if (!plan.valid) {
      toast.show(`That file is not a valid preset export: ${plan.errors[0] ?? 'unknown problem'}`, { kind: 'error' });
      return;
    }
    for (const preset of plan.presets) await store.savePreset(preset);
    toast.show(`Imported ${plan.presets.length} preset${plan.presets.length === 1 ? '' : 's'}${plan.conflicts.length ? `, renaming ${plan.conflicts.length} that clashed` : ''}`, { kind: 'success' });
  };
  input.click();
}

export { EQ_BAND_FREQUENCIES_HZ };
