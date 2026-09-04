/**
 * The names of every IPC channel and event, and nothing else.
 *
 * This list is split out from `ipc.ts` so the preload script can hold the allowlist without
 * pulling in Zod and the whole contracts package. A preload runs in the renderer's process with
 * privileges the page does not have, so its bundle is attack surface: it should contain the
 * smallest amount of code that can do the job, and this is that.
 *
 * `ipc.ts` declares its schema registry as `satisfies Record<IpcChannel, …>`, so a channel added
 * there without being added here — or here without a schema there — fails to compile. The two
 * cannot drift.
 */
export const IPC_CHANNELS = [
  'app:info',
  'app:preferences:get',
  'app:preferences:set',
  'app:open-external',
  'app:reveal',

  'library:folders',
  'library:add-folder',
  'library:remove-folder',
  'library:scan',
  'library:tracks',
  'library:playlists',
  'library:presets',

  'hub:status',
  'hub:pair-start',
  'hub:pair-await',
  'hub:forget',
  'hub:sync-now',
  'hub:share-library',

  'transfers:list',
  'transfers:send',
  'transfers:cancel',

  'backup:create',
  'backup:restore',
  'backup:export-playlists',

  'downloads:list',
  'downloads:choose-directory',
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** Events the main process pushes to the renderer. Same rule: an event not listed does not exist. */
export const IPC_EVENT_NAMES = ['event:scan-progress', 'event:hub-status', 'event:transfer-progress', 'event:notice'] as const;

export type IpcEvent = (typeof IPC_EVENT_NAMES)[number];
