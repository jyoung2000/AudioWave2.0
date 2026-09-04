import type { KeyboardEvent } from 'react';
import { formatDuration } from '@now-playing/domain';
import { useDragFraction } from '../hooks/index.js';

export interface ScrubberProps {
  positionMs: number;
  durationMs: number | null;
  onSeek: (positionMs: number) => void;
  /** Called continuously while dragging (optional; onSeek fires on release). */
  onScrub?: (positionMs: number) => void;
  disabled?: boolean;
  /** Live broadcast: seeking disabled, LIVE marker replaces the remaining time. */
  live?: boolean;
  compact?: boolean;
  tall?: boolean;
  showThumb?: boolean;
  label?: string;
  stepMs?: number;
  largeStepMs?: number;
  showRemaining?: boolean;
}

/** iPod-style scrubber: role="slider", keyboard seek, drag with capture, elapsed/remaining (spec §9.17). */
export function Scrubber({ positionMs, durationMs, onSeek, onScrub, disabled, live, compact, tall, showThumb, label = 'Seek', stepMs = 5000, largeStepMs = 15000, showRemaining = true }: ScrubberProps) {
  const duration = durationMs ?? 0;
  const inert = disabled || live || duration <= 0;
  const fraction = live ? 1 : duration > 0 ? Math.max(0, Math.min(1, positionMs / duration)) : 0;
  const drag = useDragFraction(
    (f, phase) => {
      const ms = Math.round(f * duration);
      if (phase === 'end') onSeek(ms);
      else (onScrub ?? onSeek)(ms);
    },
    { disabled: inert },
  );
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (inert) return;
    const step = e.shiftKey ? largeStepMs : stepMs;
    const targets: Record<string, number> = { ArrowRight: positionMs + step, ArrowUp: positionMs + step, ArrowLeft: positionMs - step, ArrowDown: positionMs - step, Home: 0, End: duration, PageUp: positionMs + largeStepMs * 4, PageDown: positionMs - largeStepMs * 4 };
    const next = targets[e.key];
    if (next === undefined) return;
    e.preventDefault();
    onSeek(Math.max(0, Math.min(duration, next)));
  };
  return (
    <div className={['aqua-scrubber', compact && 'aqua-scrubber--compact', tall && 'aqua-scrubber--tall', live && 'aqua-scrubber--live', showThumb && 'aqua-scrubber--thumb'].filter(Boolean).join(' ')} style={{ '--aqua-fill': `${fraction * 100}%` } as React.CSSProperties}>
      <span className="aqua-scrubber__time" aria-hidden="true">
        {formatDuration(positionMs)}
      </span>
      <div
        className="aqua-scrubber__track"
        role={live ? 'img' : 'slider'}
        tabIndex={inert ? -1 : 0}
        aria-label={live ? `Live broadcast, ${formatDuration(positionMs)} elapsed` : label}
        aria-valuemin={live ? undefined : 0}
        aria-valuemax={live ? undefined : Math.round(duration)}
        aria-valuenow={live ? undefined : Math.round(positionMs)}
        aria-valuetext={live ? undefined : `${formatDuration(positionMs)} of ${formatDuration(duration)}`}
        aria-disabled={inert && !live ? true : undefined}
        data-dragging={drag.dragging ? 'true' : undefined}
        onKeyDown={onKeyDown}
        {...drag.handlers}
      >
        <div className="aqua-scrubber__channel">
          <div className="aqua-scrubber__fill" />
          <div className="aqua-scrubber__thumb" />
        </div>
      </div>
      {live ? (
        <span className="aqua-scrubber__live" role="status">
          <span className="aqua-scrubber__live-dot" aria-hidden="true" />
          LIVE
        </span>
      ) : (
        <span className="aqua-scrubber__time aqua-scrubber__time--remaining" aria-hidden="true">
          {showRemaining ? `-${formatDuration(Math.max(0, duration - positionMs))}` : formatDuration(duration)}
        </span>
      )}
    </div>
  );
}
