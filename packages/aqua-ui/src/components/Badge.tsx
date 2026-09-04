import type { AnchorHTMLAttributes, HTMLAttributes } from 'react';

/** Monochrome source badge with initials (never a logo). */
export function SourceBadge({ provider, label, href, ...rest }: { provider: string; label?: string; href?: string } & HTMLAttributes<HTMLElement> & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const initials = INITIALS[provider] ?? provider.slice(0, 2).toUpperCase();
  const name = label ?? PROVIDER_NAMES[provider] ?? provider;
  if (href) {
    return (
      <a className="aqua-badge" data-len={String(initials.length)} href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open on ${name}`} title={name} {...rest}>
        {initials}
      </a>
    );
  }
  return (
    <span className="aqua-badge" data-len={String(initials.length)} title={name} aria-label={name} role="img" {...rest}>
      {initials}
    </span>
  );
}

export const INITIALS: Record<string, string> = { local: 'L', hub: 'H', companion: 'PC', musicbrainz: 'MB', youtube: 'YT', soundcloud: 'SC', bandcamp: 'B', spotify: 'S', 'public-domain': 'PD', 'external-tool': 'X' };
export const PROVIDER_NAMES: Record<string, string> = { local: 'Local library', hub: 'Hub library', companion: 'Windows companion', musicbrainz: 'MusicBrainz (metadata)', youtube: 'YouTube', soundcloud: 'SoundCloud', bandcamp: 'Bandcamp', spotify: 'Spotify', 'public-domain': 'Public domain', 'external-tool': 'External tool' };
