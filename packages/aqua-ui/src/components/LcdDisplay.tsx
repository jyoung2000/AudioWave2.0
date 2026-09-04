import type { ReactNode } from 'react';
import { ProgressBar } from './ProgressBar.js';

export interface LcdDisplayProps {
  title: string;
  detail?: string;
  artworkSrc?: string | null;
  /** Temporary status mode (import/sync/buffering) replaces the now-playing rows. */
  status?: { text: string; percent?: number | null } | null;
  /** Scrubber or progress channel rendered inside the display. */
  channel?: ReactNode;
  /** Announce changes politely. */
  live?: boolean;
  className?: string;
}

/** Inset LCD information display (spec §9.5). Truncated text exposes the full value through title. */
export function LcdDisplay({ title, detail, artworkSrc, status, channel, live = true, className }: LcdDisplayProps) {
  return (
    <section className={['aqua-lcd', artworkSrc && 'aqua-lcd--with-art', className].filter(Boolean).join(' ')} data-mode={status ? 'status' : undefined} aria-live={live ? 'polite' : undefined} aria-atomic="true" aria-label="Now playing">
      {artworkSrc ? <img className="aqua-lcd__art" src={artworkSrc} alt="" /> : null}
      <div className="aqua-lcd__title" title={title}>
        {title}
      </div>
      <div className="aqua-lcd__detail" title={detail}>
        {detail ?? ' '}
      </div>
      {channel ? <div className="aqua-lcd__channel">{channel}</div> : null}
      <div className="aqua-lcd__status">
        {status?.text}
        {status && status.percent !== undefined && status.percent !== null ? <ProgressBar className="aqua-lcd__status-progress" size="small" value={status.percent} label={status.text} showValue={false} /> : null}
      </div>
    </section>
  );
}
