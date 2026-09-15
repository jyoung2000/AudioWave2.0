/**
 * Which source of tools, if any, this device has.
 *
 * The built-in one is asked first because it costs nothing — it is an object already sitting on
 * `window` in this process — and because where it exists it is the right answer: a native shell
 * carrying the tool beats a program the person would have to start themselves.
 *
 * Everything else about tools lives in `tools-core.ts`, which neither transport may import back
 * into. This file is the one place that knows both exist.
 */
import { androidBackend } from './android-bridge.js';
import { helperBackend, type SavedHelper } from './fetch-helper.js';
import type { ToolBackend } from './tools-core.js';

export type { SavedHelper };
export { ToolError, runFetch, toolIn, backendCovers, protocolMatches, type ToolBackend } from './tools-core.js';

/** Never throws: "no tools" is the normal state for almost everyone, not an error to handle. */
export async function detectBackend(saved: SavedHelper | null, doc: Document = document): Promise<ToolBackend | null> {
  return (await androidBackend()) ?? (await helperBackend(saved, doc));
}
