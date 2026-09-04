import type { IconProps } from './Icon.js';

/** Built-in avatar silhouettes: original, single-colour, top-lit via the avatar frame CSS. */
const AVATARS = {
  headphones: 'M12 3a8 8 0 0 0-8 8v6a2 2 0 0 0 2 2h2v-7H6a6 6 0 0 1 12 0h-2v7h2a2 2 0 0 0 2-2v-6a8 8 0 0 0-8-8z',
  vinyl: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  cassette: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm5 5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zm8 0a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6 7v1.5h12V7z',
  note: 'M19.6 3 9.8 5.2a1 1 0 0 0-.8 1v9.7a3.1 3.1 0 1 0 1.6 2.7V9.6l7.6-1.7v5.6a3.1 3.1 0 1 0 1.6 2.7V3.8a.8.8 0 0 0-1-.8z',
  wave: 'M2 12h2l2-5 3 10 3-12 3 9 2-4h5v2h-3.8l-3.2 6.4-3-9-3 12-3-10-1 2.6H2z',
  radio: 'M4 8h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zm3-5 9 3.5V8H6.4zM8 12a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm6 0h5v2h-5zm0 3h5v2h-5z',
  speaker: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',
  mic: 'M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zm-6 9h2a4 4 0 0 0 8 0h2a6 6 0 0 1-5 5.9V19h3v2H8v-2h3v-2.1A6 6 0 0 1 6 11z',
} as const;

export type AvatarIconId = keyof typeof AVATARS;
export const AVATAR_ICON_IDS = Object.keys(AVATARS) as AvatarIconId[];

export function AvatarIcon({ id, title, ...props }: IconProps & { id: AvatarIconId }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} focusable="false" {...props}>
      {title ? <title>{title}</title> : null}
      <path d={AVATARS[id] ?? AVATARS.headphones} fill="currentColor" />
    </svg>
  );
}
