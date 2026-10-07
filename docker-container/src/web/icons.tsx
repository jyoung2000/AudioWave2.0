/**
 * The toolbar icons of the Airwave Hub window: the six `design/frontends/origin/airwave-hub.html` draws, and Search's.
 *
 * They live in their own module, as the companion's do, so the window (`App.tsx`) and the styleguide
 * (`packages/aqua-ui/styleguide/screens.tsx`) draw the same pictures.
 */
import type { ReactNode } from 'react';

export type TabIconId = 'overview' | 'devices' | 'music' | 'search' | 'groups' | 'sharing' | 'system';

export const TAB_ICONS: Record<TabIconId, ReactNode> = {
  overview: (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <rect x="3" y="4" width="20" height="16" rx="2" fill="#e9eef3" stroke="#4c637c" strokeWidth="1.1" />
      <rect x="6" y="13" width="3" height="4" fill="#7d97b3" />
      <rect x="11.5" y="9" width="3" height="8" fill="#7d97b3" />
      <rect x="17" y="7" width="3" height="10" fill="#4c637c" />
      <path d="M9 23h8" stroke="#4c637c" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  devices: (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <rect x="8" y="3" width="10" height="20" rx="2" fill="#5b6770" stroke="#39424a" strokeWidth="1.1" />
      <rect x="9.6" y="5.5" width="6.8" height="13" rx=".6" fill="#9fd2ee" />
      <circle cx="13" cy="20.8" r=".9" fill="#dfe6ea" />
    </svg>
  ),
  music: (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <path d="M20 3.5 10 5.8a1 1 0 0 0-.8 1v10.3a3.2 3.2 0 1 0 1.7 2.8V10.2l7.7-1.8v6.1a3.2 3.2 0 1 0 1.7 2.8V4.4a.8.8 0 0 0-1-.9z" fill="#7d97b3" stroke="#4c637c" strokeWidth=".9" />
    </svg>
  ),
  // Not in the design, which drew six tools: the Search tool (DEC-039) in the same two blues and
  // stroke weights — a lens over a note.
  search: (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="11" cy="11" r="7.2" fill="#e9eef3" stroke="#4c637c" strokeWidth="1.6" />
      <path d="M12.6 6.6v6.1a1.9 1.9 0 1 1-1-1.7V8.2l2.6-.6" fill="#7d97b3" stroke="#4c637c" strokeWidth=".8" strokeLinejoin="round" />
      <path d="M16.3 16.3 22.5 22.5" stroke="#4c637c" strokeWidth="3" strokeLinecap="round" />
    </svg>
  ),
  groups: (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="8" cy="9" r="3.2" fill="#9fb3c8" stroke="#4c637c" />
      <circle cx="18" cy="9" r="3.2" fill="#9fb3c8" stroke="#4c637c" />
      <circle cx="13" cy="11" r="3.6" fill="#7d97b3" stroke="#4c637c" />
      <path d="M3 21c.5-4 3-6 5-6M23 21c-.5-4-3-6-5-6M6.5 22c.6-4.6 3.4-7 6.5-7s5.9 2.4 6.5 7z" fill="#7d97b3" stroke="#4c637c" strokeLinejoin="round" />
    </svg>
  ),
  sharing: (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <path d="M11 15a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12.8 6.8" fill="none" stroke="#4c637c" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M15 11a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4" fill="none" stroke="#7d97b3" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  ),
  system: (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="13" cy="13" r="8.3" fill="none" stroke="#4c637c" strokeWidth="3.4" strokeDasharray="3.26 3.26" />
      <circle cx="13" cy="13" r="6.6" fill="#7d97b3" stroke="#4c637c" strokeWidth="1.1" />
      <circle cx="13" cy="13" r="2.4" fill="#e3e3e3" stroke="#4c637c" />
    </svg>
  ),
};
