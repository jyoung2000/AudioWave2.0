/** The seams the bridge (music-player/src/shell/bridge.ts) puts on `window`, as the e2e tests see them. */
export {};

interface NpAwsp {
  pair(ticket: string, code: string): Promise<{ ok: boolean; serverName: string | null; reason: string | null }>;
  connect(): Promise<{ ok: boolean; reason: string | null }>;
  status(): Promise<{ paired: boolean; serverName: string | null; status: string; connectionType: string | null; endpointId: string | null; lastError: string | null; tracks: number }>;
  browse(page?: number, query?: string): Promise<{ page: number; total: number; items: Array<Record<string, unknown>> }>;
  connectionType(): string | null;
  companion(operation: string, args?: Record<string, unknown>): Promise<unknown>;
  stats(): Promise<unknown>;
  tune(options: { pingMs?: number; relayOverride?: string | null }): void;
}

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
    COMPANION?: string;
    NP_HELPER_TOKEN?: string;
    NP_TOOLS?: {
      detect(): Promise<{ kind: 'built-in' | 'helper' | 'awsp'; label: string; origin: string | null; saved: boolean; health: Record<string, unknown>; tools: Array<{ id: string; present: boolean; version: string | null }> } | null>;
      connect(origin: string, token: string): Promise<{ kind: 'built-in' | 'helper' | 'awsp'; label: string; origin: string | null; saved: boolean; health: Record<string, unknown>; tools: Array<{ id: string; present: boolean; version: string | null }> } | null>;
      hasSaved(): Promise<boolean>;
      forgetSaved(): Promise<boolean>;
      fetch(url: string, basis: string): Promise<{ added: number; trackId: string | null; reason: string | null }>;
    };
    NP_HUB?: {
      status(): { connected: boolean; endpoint: string | null; hubName: string | null; reason: string | null };
      refresh(): Promise<{ connected: boolean; endpoint: string | null; hubName: string | null; reason: string | null }>;
      subscribe(listener: (status: { connected: boolean; endpoint: string | null; hubName: string | null; reason: string | null }) => void): () => void;
    };
    NP_BRIDGE?: { version: number; log: string[] };
    NP_AWSP?: NpAwsp;
    NP_AWSP_READY?: Promise<NpAwsp | null>;
  }
}
