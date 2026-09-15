/**
 * The slot for a platform's official artwork.
 *
 * The built-in marks are deliberately not the platforms' logos (see `provider-marks.tsx`). Anyone
 * who holds a platform's official asset under that platform's own brand terms can put it here, and
 * every mark in the product switches to it — the list, the search results, the settings table —
 * without any of them knowing where it came from.
 *
 * The values are whatever an `<img src>` accepts. The player stores the files people choose in its
 * own database and hands over object URLs, so nothing is fetched over the network and no logo is
 * shipped in the bundle.
 */
import { createContext, useContext, type ReactNode } from 'react';

export type ProviderArtworkMap = Readonly<Record<string, string>>;

const EMPTY: ProviderArtworkMap = Object.freeze({});
const ProviderArtworkContext = createContext<ProviderArtworkMap>(EMPTY);

export function ProviderArtworkProvider({ artwork, children }: { artwork: ProviderArtworkMap; children: ReactNode }) {
  return <ProviderArtworkContext.Provider value={artwork}>{children}</ProviderArtworkContext.Provider>;
}

export function useProviderArtwork(provider: string): string | null {
  return useContext(ProviderArtworkContext)[provider] ?? null;
}
