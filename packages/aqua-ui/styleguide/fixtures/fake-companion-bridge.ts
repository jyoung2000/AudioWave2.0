/**
 * The companion window's bridge to its main process, as the style guide gives it to the
 * companion's real views.
 *
 * The styleguide build puts this module where `windows-companion/src/renderer/bridge.ts` would be
 * (see `specimenTransports` in `../vite.config.ts`), so `BackupView`, `AboutView` and `SettingsView`
 * render exactly as they do in the app, with the answers a real companion gave
 * (`companion-ipc.json`, written by `record-companion-ipc.mjs`). Reads are answered from the
 * recording; anything that would act on the PC is refused with a sentence, which the views show the
 * way they show any refused action. No event ever arrives.
 */
import type { IpcChannel, IpcEvent, IpcEventPayload, IpcRequest, IpcResponse } from '../../../../windows-companion/src/shared/ipc.js';
import recording from './companion-ipc.json';

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

export async function invoke<C extends IpcChannel>(channel: C, _request: IpcRequest<C>): Promise<IpcResponse<C>> {
  if (!(channel in RECORDED.channels)) throw new BridgeUnavailableError();
  return revive(RECORDED.channels[channel], Date.parse(RECORDED.recordedAt)) as IpcResponse<C>;
}

export function subscribe<E extends IpcEvent>(_event: E, _listener: (payload: IpcEventPayload<E>) => void): () => void {
  return () => undefined;
}
