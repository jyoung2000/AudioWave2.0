import { Glyph } from '../icons/glyphs.js';
import { Slider } from './Slider.js';

export interface VolumeSliderProps {
  /** 0–1 */
  value: number;
  muted?: boolean;
  onChange: (value: number) => void;
  onToggleMute?: () => void;
  disabled?: boolean;
}

export function VolumeSlider({ value, muted, onChange, onToggleMute, disabled }: VolumeSliderProps) {
  const percent = Math.round(value * 100);
  const icon = muted || value === 0 ? 'mute' : value < 0.5 ? 'volume-low' : 'volume-high';
  return (
    <div className="aqua-volume">
      {onToggleMute ? (
        <button type="button" className="aqua-icon-button" data-variant="plain" aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'} aria-pressed={Boolean(muted)} onClick={onToggleMute} disabled={disabled} style={{ minWidth: 24, minHeight: 24 }}>
          <span className="aqua-icon-button__face" style={{ width: 20, height: 18 }}>
            <Glyph name={icon} />
          </span>
        </button>
      ) : (
        <span className="aqua-volume__icon" aria-hidden="true">
          <Glyph name="volume-low" />
        </span>
      )}
      <Slider label="Volume" value={muted ? 0 : percent} min={0} max={100} step={2} largeStep={10} onChange={(v) => onChange(v / 100)} disabled={disabled} format={(v) => `${v}%`} />
      <span className="aqua-volume__icon" aria-hidden="true">
        <Glyph name="volume-high" />
      </span>
    </div>
  );
}
