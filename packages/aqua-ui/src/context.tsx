import { createContext, useContext } from 'react';

export type AquaProfile = 'snow-leopard-itunes-9' | 'classic-aqua-gel-accent' | 'itunes-10-transition';
export const AQUA_PROFILES: readonly AquaProfile[] = ['snow-leopard-itunes-9', 'classic-aqua-gel-accent', 'itunes-10-transition'];
export const DEFAULT_AQUA_PROFILE: AquaProfile = 'snow-leopard-itunes-9';

export interface AquaContextValue {
  profile: AquaProfile;
  /** Whether the hosting window/document is active (focused + visible). */
  active: boolean;
  reducedMotion: boolean;
}

/**
 * What a component may ask of its host. No provider ships: every library component reads these
 * defaults, and motion and focus follow the stylesheet's own media queries and attributes.
 */
const AquaContext = createContext<AquaContextValue>({ profile: DEFAULT_AQUA_PROFILE, active: true, reducedMotion: false });

/** Apply a profile to the document root so profile-driven CSS applies everywhere (spec §7.4). */
export function applyAquaProfile(profile: AquaProfile, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (!root) return;
  root.setAttribute('data-aqua-profile', profile);
}

export function useAqua(): AquaContextValue {
  return useContext(AquaContext);
}
