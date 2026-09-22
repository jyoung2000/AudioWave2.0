/** The seams the bridge (music-player/src/shell/bridge.ts) puts on `window`, as the e2e tests see them. */
export {};

declare global {
  interface Window {
    NP_READY?: Promise<void>;
    LIBRARY?: Array<{ id: string; title: string; artist: string; album: string; duration: number; url: string | null; local?: boolean }>;
    NP_PLAYER?: {
      play(id: string): Promise<{ ok: boolean; reason: string | null }>;
      pause(): void;
      resume(): Promise<{ ok: boolean; reason: string | null }>;
      seek(seconds: number): void;
      position(): number;
      duration(): number | null;
      playing(): boolean;
      trackId(): string | null;
    };
    NP_LIBRARY?: { addFiles(files: File[]): Promise<{ added: number; reason: string | null }>; count(): number };
    NP_TOOLS?: {
      detect(): Promise<{ label: string; tools: Array<{ id: string; present: boolean; version: string | null }> } | null>;
      fetch(url: string, basis: string): Promise<{ added: number; trackId: string | null; reason: string | null }>;
    };
    NP_BRIDGE?: { version: number; log: string[] };
  }
}
