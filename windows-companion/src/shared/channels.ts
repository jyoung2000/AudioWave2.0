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
  'app:preferences:reset',
  'app:open-external',
  'app:reveal',
  'app:open-data-folder',
  'app:update-status',
  'app:check-update',
  'app:open-release',
  'app:storage',
  'app:clear-cache',
  'app:open-logs',
  'app:export-logs',
  'downloads:pick-dir',

  'library:folders',
  'library:add-folder',
  'library:remove-folder',
  'library:scan',
  'library:tracks',
  'library:track-ids',
  'library:playlists',
  'library:presets',

  'hub:status',
  'hub:pair-start',
  'hub:pair-await',
  'hub:forget',
  'hub:sync-now',
  'hub:share-library',
  'hub:sharing',
  'hub:groups',
  'hub:request',

  'transfers:list',
  'transfers:send',
  'transfers:cancel',

  'backup:settings:get',
  'backup:settings:set',
  'backup:pick-dir',
  'backup:estimate',
  'backup:list',
  'backup:create',
  'backup:restore',
  'backup:remove',
  'backup:export-playlists',
  'backup:algorithms',

  'awsp:status',
  'awsp:set-enabled',
  'awsp:set-port',
  'awsp:new-code',
  'awsp:revoke',
  'awsp:set-tier',
  'awsp:set-networks',

  'helper:status',
  'helper:check-tools',
  'helper:install-tools',
  'helper:check-tool',
  'helper:update-tool',
  'helper:token',

  'tv:links',
  'tv:add',
  'tv:remove',
  'tv:refresh',

  // The music catalog through the embedded helper (DEC-039; UX-SEARCH-001…007).
  'catalog:search',
  'catalog:cancel',
  'catalog:album',
  'catalog:artist',
  'catalog:resolve',
  'catalog:lyrics',
  'catalog:enrich',
  'catalog:download',
  'catalog:saved',
  'catalog:save',
  'catalog:unsave',
  'catalog:filter',
  'catalog:filter:set',

  // The playlist folder (DEC-041; CMP-PL-001…): .m3u8 files and their sidecars, read and written here.
  'playlists:list',
  'playlists:get',
  'playlists:create',
  'playlists:update',
  'playlists:delete',
  'playlists:add',
  'playlists:remove',
  'playlists:move',
  'playlists:export',
  'playlists:folder',
  'playlists:pick-dir',
  'playlists:open-folder',
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** Events the main process pushes to the renderer. Same rule: an event not listed does not exist. */
export const IPC_EVENT_NAMES = ['event:scan-progress', 'event:hub-status', 'event:transfer-progress', 'event:backup-progress', 'event:awsp-status', 'event:tv-links', 'event:notice', 'event:catalog-chunk', 'event:playlists-changed'] as const;

export type IpcEvent = (typeof IPC_EVENT_NAMES)[number];
