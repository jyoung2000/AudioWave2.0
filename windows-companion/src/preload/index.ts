/**
 * The preload script: the only bridge between the renderer and the operating system.
 *
 * It runs with `contextIsolation: true`, so what it exposes on `window.companion` is a frozen
 * object in a separate world — the page cannot reach the objects behind it, and a script injected
 * into the page cannot reach Node. Two rules make that boundary meaningful:
 *
 * 1. **The channel list is an allowlist**, checked here as well as in the main process. A typo or
 *    an injected string simply is not a channel.
 * 2. **Nothing else is exposed.** No `require`, no `process`, no `ipcRenderer`, no path helpers.
 *    Every capability the renderer has is a named channel with a validated shape.
 */
import { contextBridge, ipcRenderer } from 'electron';
// Names only — deliberately not `../shared/ipc.js`, which would drag Zod and the contracts package
// into the preload bundle. See the note at the top of `shared/channels.ts`.
import { IPC_CHANNELS, IPC_EVENT_NAMES, type IpcChannel, type IpcEvent } from '../shared/channels.js';
import type { CompanionBridge } from '../shared/ipc.js';

const channels = new Set<string>(IPC_CHANNELS);
const events = new Set<string>(IPC_EVENT_NAMES);

const bridge: CompanionBridge = {
  invoke(channel, request) {
    if (!channels.has(channel)) return Promise.reject(new Error(`Unknown channel ${String(channel)}`));
    return ipcRenderer.invoke(channel, request) as never;
  },
  on(event, listener) {
    if (!events.has(event)) throw new Error(`Unknown event ${String(event)}`);
    const handler = (_e: unknown, payload: unknown): void => listener(payload as never);
    ipcRenderer.on(event, handler);
    return () => {
      ipcRenderer.off(event, handler);
    };
  },
};

contextBridge.exposeInMainWorld('companion', Object.freeze(bridge));

export type { IpcChannel, IpcEvent };
