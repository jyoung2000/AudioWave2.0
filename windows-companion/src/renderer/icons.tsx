/**
 * The design's own icons, as it drew them (design/frontends/airwave-companion.html): the four
 * toolbar tools at 26px and the three row glyphs at 15px. Decorative, so hidden from assistive
 * technology — the control or row beside each one carries the words.
 */

export function LibraryToolIcon() {
  return (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <path d="M2.5 8.5 A 1.5 1.5 0 0 1 4 7 h6 l2 2.5 h10 a1.5 1.5 0 0 1 1.5 1.5 v8 A 1.5 1.5 0 0 1 22 20.5 H4 A 1.5 1.5 0 0 1 2.5 19 Z" fill="#7d97b3" stroke="#4c637c" strokeWidth="1.1" />
      <path d="M2.5 12 h21" stroke="#a9bccd" strokeWidth="1" />
    </svg>
  );
}

export function LiveTvToolIcon() {
  return (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <rect x="3" y="6.5" width="20" height="13" rx="2" fill="#5b6770" stroke="#39424a" strokeWidth="1.1" />
      <rect x="5" y="8.5" width="16" height="9" rx="1" fill="#9fd2ee" />
      <path d="M9 22.5 h8" stroke="#39424a" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function RemoteToolIcon() {
  return (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <path d="M13 19 a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" fill="#4c637c" />
      <path d="M6.5 16.5a9 9 0 0 1 13 0M3.5 12.5a14 14 0 0 1 19 0M9.5 19.2a4.6 4.6 0 0 1 7 0" fill="none" stroke="#4c637c" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function SettingsToolIcon() {
  return (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="13" cy="13" r="8.3" fill="none" stroke="#4c637c" strokeWidth="3.4" strokeDasharray="3.26 3.26" />
      <circle cx="13" cy="13" r="6.6" fill="#7d97b3" stroke="#4c637c" strokeWidth="1.1" />
      <circle cx="13" cy="13" r="2.4" fill="#e3e3e3" stroke="#4c637c" strokeWidth="1" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg className="ic" viewBox="0 0 15 15" aria-hidden="true">
      <path d="M1 4.2 A 1.2 1.2 0 0 1 2.2 3 h3.4 l1.2 1.6 h6 A 1.2 1.2 0 0 1 14 5.8 v5 A 1.2 1.2 0 0 1 12.8 12 H2.2 A 1.2 1.2 0 0 1 1 10.8 Z" fill="currentColor" />
    </svg>
  );
}

export function LinkIcon() {
  return (
    <svg className="ic" viewBox="0 0 15 15" aria-hidden="true">
      <circle cx="7.5" cy="7.5" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 7.5h11M7.5 2c-2.8 3.4-2.8 7.6 0 11 2.8-3.4 2.8-7.6 0-11z" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

export function DeviceIcon() {
  return (
    <svg className="ic" viewBox="0 0 15 15" aria-hidden="true">
      <rect x="4" y="1.5" width="7" height="12" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7.5" cy="11.2" r=".9" fill="currentColor" />
    </svg>
  );
}
