export * from './wav.js';
export * from './library.js';
export * from './events.js';
export * from './providers.js';
export * from './discord.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the generated audio fixture root (after `pnpm generate`). */
export function fixtureAudioRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'generated', 'audio');
}
