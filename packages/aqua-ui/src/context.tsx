import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type AquaProfile = 'snow-leopard-itunes-9' | 'classic-aqua-gel-accent' | 'itunes-10-transition';
export const AQUA_PROFILES: readonly AquaProfile[] = ['snow-leopard-itunes-9', 'classic-aqua-gel-accent', 'itunes-10-transition'];
export const DEFAULT_AQUA_PROFILE: AquaProfile = 'snow-leopard-itunes-9';

export interface AquaContextValue {
  profile: AquaProfile;
  /** Whether the hosting window/document is active (focused + visible). */
  active: boolean;
  reducedMotion: boolean;
}

const AquaContext = createContext<AquaContextValue>({ profile: DEFAULT_AQUA_PROFILE, active: true, reducedMotion: false });

/** Apply a profile to the document root so profile-driven CSS applies everywhere (spec §7.4). */
export function applyAquaProfile(profile: AquaProfile, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (!root) return;
  root.setAttribute('data-aqua-profile', profile);
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => (typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Tracks whether the document has focus and is visible: the "inactive window" state (spec §10.3). */
export function useWindowActive(): boolean {
  const [active, setActive] = useState<boolean>(() => (typeof document === 'undefined' ? true : document.hasFocus() && document.visibilityState !== 'hidden'));
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const update = () => setActive(document.hasFocus() && document.visibilityState !== 'hidden');
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return active;
}

export interface AquaProviderProps {
  profile?: AquaProfile;
  /** Force the active state (e.g. in the gallery); defaults to tracking the document. */
  active?: boolean;
  /** Force reduced motion (gallery/tests); defaults to the OS setting. */
  reducedMotion?: boolean;
  applyToDocument?: boolean;
  children: ReactNode;
}

export function AquaProvider({ profile = DEFAULT_AQUA_PROFILE, active, reducedMotion, applyToDocument = true, children }: AquaProviderProps) {
  const trackedActive = useWindowActive();
  const osReduced = useReducedMotion();
  const value = useMemo<AquaContextValue>(() => ({ profile, active: active ?? trackedActive, reducedMotion: reducedMotion ?? osReduced }), [profile, active, trackedActive, reducedMotion, osReduced]);
  useEffect(() => {
    if (!applyToDocument || typeof document === 'undefined') return;
    applyAquaProfile(profile);
    if (reducedMotion !== undefined) document.documentElement.setAttribute('data-aqua-reduced-motion', String(reducedMotion));
    else document.documentElement.removeAttribute('data-aqua-reduced-motion');
  }, [profile, reducedMotion, applyToDocument]);
  return <AquaContext.Provider value={value}>{children}</AquaContext.Provider>;
}

export function useAqua(): AquaContextValue {
  return useContext(AquaContext);
}
