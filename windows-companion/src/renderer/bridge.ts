/**
 * The renderer's view of the main process.
 *
 * Every call goes through the preload bridge. When it is missing — running the renderer in a plain
 * browser, or in a test — the calls fail with a clear message rather than a `TypeError` on
 * `undefined`, which is what makes the interface debuggable outside Electron.
 */
import type { CompanionBridge, IpcChannel, IpcEvent, IpcEventPayload, IpcRequest, IpcResponse } from '../shared/ipc.js';

declare global {
  interface Window {
    companion?: CompanionBridge;
  }
}

export class BridgeUnavailableError extends Error {
  constructor() {
    super('This window is not running inside the companion app, so it cannot reach your files.');
    this.name = 'BridgeUnavailableError';
  }
}

export function bridgeAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.companion?.invoke === 'function';
}

export async function invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> {
  if (!bridgeAvailable()) throw new BridgeUnavailableError();
  return window.companion!.invoke(channel, request);
}

export function subscribe<E extends IpcEvent>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void {
  if (!bridgeAvailable()) return () => undefined;
  return window.companion!.on(event, listener);
}
