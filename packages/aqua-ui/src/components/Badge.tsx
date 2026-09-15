import type { AnchorHTMLAttributes, HTMLAttributes } from 'react';
import { markFor, ProviderMark, PROVIDER_MARKS } from '../icons/provider-marks.js';

/**
 * Says which platform a row came from, and opens it there when the platform gave us a URL.
 *
 * The mark is ours, not the platform's logo — `provider-marks.tsx` explains why, and how to put the
 * official asset in its place. The name is always in the accessible name and the tooltip, so the
 * mark never has to carry meaning on its own.
 */
export function SourceBadge({ provider, label, href, ...rest }: { provider: string; label?: string; href?: string } & HTMLAttributes<HTMLElement> & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const name = label ?? markFor(provider).name;
  if (href) {
    return (
      <a className="aqua-badge" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open on ${name}`} title={name} {...rest}>
        <ProviderMark provider={provider} />
      </a>
    );
  }
  return (
    <span className="aqua-badge" title={name} aria-label={name} role="img" {...rest}>
      <ProviderMark provider={provider} />
    </span>
  );
}

/** Kept for anywhere a mark will not fit — a plain-text list, a log line, a narrow column header. */
export const INITIALS: Record<string, string> = Object.fromEntries(Object.entries(PROVIDER_MARKS).map(([slug, mark]) => [slug, mark.initials]));
export const PROVIDER_NAMES: Record<string, string> = Object.fromEntries(Object.entries(PROVIDER_MARKS).map(([slug, mark]) => [slug, mark.name]));
