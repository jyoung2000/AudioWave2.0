import type { ReactNode } from 'react';
import { Glyph } from '../icons/glyphs.js';
import type { RepeatMode } from '@now-playing/contracts';

export interface TransportProps {
  playing: boolean;
  onPlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  canPrevious?: boolean;
  canNext?: boolean;
  disabled?: boolean;
  /** Optional built-in toggles. */
  shuffle?: boolean;
  onShuffle?: () => void;
  repeat?: RepeatMode;
  onRepeat?: () => void;
  /** Generic aux controls rendered in the same row (Star, Add to Playlist, Share…). */
  leading?: ReactNode;
  trailing?: ReactNode;
  size?: 'regular' | 'large';
  label?: string;
  /** Explains why the transport is inert (e.g. live broadcast). */
  disabledReason?: string;
}

/** Previous / play-pause / next cluster with stable footprint; aux controls share the row (spec §9.4). */
export function Transport({ playing, onPlayPause, onPrevious, onNext, canPrevious = true, canNext = true, disabled, shuffle, onShuffle, repeat, onRepeat, leading, trailing, size = 'regular', label = 'Playback controls', disabledReason }: TransportProps) {
  const repeatLabel = repeat === 'one' ? 'Repeat: one' : repeat === 'all' ? 'Repeat: all' : 'Repeat: off';
  return (
    <div className={['aqua-transport', size === 'large' && 'aqua-transport--large'].filter(Boolean).join(' ')} role="group" aria-label={label} title={disabled && disabledReason ? disabledReason : undefined}>
      {leading || onShuffle ? (
        <span className="aqua-transport__aux aqua-transport__aux--leading">
          {leading}
          {onShuffle ? (
            <button type="button" className="aqua-transport__button aqua-transport__button--aux" aria-label="Shuffle" title="Shuffle" aria-pressed={Boolean(shuffle)} onClick={onShuffle} disabled={disabled}>
              <span className="aqua-transport__disc">
                <Glyph name="shuffle" />
              </span>
            </button>
          ) : null}
        </span>
      ) : null}
      <button type="button" className="aqua-transport__button" aria-label="Previous track" title="Previous track" onClick={onPrevious} disabled={disabled || !canPrevious}>
        <span className="aqua-transport__disc">
          <Glyph name="previous" />
        </span>
      </button>
      <button type="button" className="aqua-transport__button aqua-transport__button--play" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'} aria-pressed={playing} onClick={onPlayPause} disabled={disabled}>
        <span className="aqua-transport__disc">
          <Glyph name={playing ? 'pause' : 'play'} />
        </span>
      </button>
      <button type="button" className="aqua-transport__button" aria-label="Next track" title="Next track" onClick={onNext} disabled={disabled || !canNext}>
        <span className="aqua-transport__disc">
          <Glyph name="next" />
        </span>
      </button>
      {trailing || onRepeat ? (
        <span className="aqua-transport__aux aqua-transport__aux--trailing">
          {onRepeat ? (
            <button type="button" className="aqua-transport__button aqua-transport__button--aux" aria-label={repeatLabel} title={repeatLabel} aria-pressed={repeat !== undefined && repeat !== 'off'} onClick={onRepeat} disabled={disabled}>
              <span className="aqua-transport__disc">
                <Glyph name={repeat === 'one' ? 'repeat-one' : 'repeat'} />
              </span>
            </button>
          ) : null}
          {trailing}
        </span>
      ) : null}
    </div>
  );
}

/** Small aux button matching the transport material, for Star / Add to Playlist / Share in the same row. */
export function TransportAuxButton({ label, pressed, onClick, disabled, children, menu, expanded }: { label: string; pressed?: boolean; onClick?: () => void; disabled?: boolean; children: ReactNode; menu?: boolean; expanded?: boolean }) {
  return (
    <button type="button" className="aqua-transport__button aqua-transport__button--aux" aria-label={label} title={label} aria-pressed={pressed} aria-haspopup={menu ? 'menu' : undefined} aria-expanded={menu ? Boolean(expanded) : undefined} onClick={onClick} disabled={disabled}>
      <span className="aqua-transport__disc">{children}</span>
    </button>
  );
}
