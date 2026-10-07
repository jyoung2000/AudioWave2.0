/**
 * The companion window's bridge to its main process, as the style guide gives it to the
 * companion's real views.
 *
 * The styleguide build puts this module where `windows-companion/src/renderer/bridge.ts` would be
 * (see `specimenTransports` in `../vite.config.ts`), so `BackupView`, `AboutView` and `SettingsView`
 * render exactly as they do in the app, with the answers a real companion gave
 * (`companion-ipc.json`, written by `record-companion-ipc.mjs`). Reads are answered from the
 * recording; anything that would act on the PC is refused with a sentence, which the views show the
 * way they show any refused action. The one event that arrives is a search's chunks.
 */
import type { IpcChannel, IpcEvent, IpcEventPayload, IpcRequest, IpcResponse } from '../../../../windows-companion/src/shared/ipc.js';
import recording from './companion-ipc.json';
import catalog from './catalog-stock.json';

/**
 * The Search tool's channels (DEC-039) answer from the stock catalog the mockups and tests use
 * (`catalog-stock.json`) — a recorded companion would have asked the real music services — and a
 * search's chunks reach the window as `event:catalog-chunk`, as the main process sends them.
 */
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const FILTER = { sections: ['tracks', 'artists', 'albums'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud'] };
const CATALOG: Record<string, (request: Record<string, unknown>) => unknown> = {
  'catalog:search': async (request) => {
    const q = String(request['q'] ?? '');
    const chunks = /^https?:/.test(q) ? [{ ...catalog.searchLink[0], resolve: q }] : Number(request['offset'] ?? 0) > 0 ? catalog.searchPage2 : catalog.search;
    for (const chunk of chunks) for (const listener of listeners.get('event:catalog-chunk') ?? []) listener({ searchId: request['searchId'], chunk });
    return { reason: null };
  },
  'catalog:cancel': () => ({ ok: true }),
  'catalog:album': () => ({ result: catalog.album, reason: null }),
  'catalog:artist': () => ({ result: catalog.artist, reason: null }),
  'catalog:resolve': (request) => ({ result: request['url'] === catalog.playlistUrl ? catalog.resolvePlaylist : catalog.resolveUnsupported, reason: null }),
  'catalog:lyrics': () => ({ result: catalog.lyrics, reason: null }),
  'catalog:enrich': () => ({ result: catalog.enrich, reason: null }),
  'catalog:saved': () => catalog.saved,
  'catalog:filter': () => FILTER,
};

const RECORDED = recording as { recordedAt: string; channels: Record<string, unknown> };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const DAY = 86_400_000;

/**
 * The recording, brought up to now: what had happened moves by exactly however long ago it was
 * recorded, so "4 min ago" stays "4 min ago"; what was still to come moves by whole days, so a
 * backup due at 03:00 is still due at 03:00 and a link that had a week left still has one.
 */
function revive(value: unknown, recordedAt: number): unknown {
  if (typeof value === 'string') {
    if (!ISO.test(value)) return value;
    const at = Date.parse(value);
    const now = Date.now();
    const elapsed = now - recordedAt;
    if (at <= recordedAt) return new Date(at + elapsed).toISOString();
    // Whole days, as many as have passed, and never so few that it is already over.
    const days = Math.max(Math.round(elapsed / DAY), Math.ceil((now - at) / DAY), 0);
    return new Date(at + days * DAY).toISOString();
  }
  if (Array.isArray(value)) return value.map((item) => revive(item, recordedAt));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item, recordedAt)]));
  return value;
}

export class BridgeUnavailableError extends Error {
  constructor() {
    super('This window is a specimen in the style guide, so there is no companion behind it to do that.');
    this.name = 'BridgeUnavailableError';
  }
}

export function bridgeAvailable(): boolean {
  return true;
}

export async function invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> {
  const stock = CATALOG[channel];
  if (stock) return (await stock((request ?? {}) as Record<string, unknown>)) as IpcResponse<C>;
  if (!(channel in RECORDED.channels)) throw new BridgeUnavailableError();
  return revive(RECORDED.channels[channel], Date.parse(RECORDED.recordedAt)) as IpcResponse<C>;
}

export function subscribe<E extends IpcEvent>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void {
  // Only a search's chunks ever arrive here.
  if (event !== 'event:catalog-chunk') return () => undefined;
  const set = listeners.get(event) ?? new Set();
  listeners.set(event, set);
  const wrapped = listener as (payload: unknown) => void;
  set.add(wrapped);
  return () => set.delete(wrapped);
}
