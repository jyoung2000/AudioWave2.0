/**
 * The application's Windows identity, in one place.
 *
 * Windows groups a running window, its taskbar button, its Start-menu entry, its jump list and its
 * toasts by an Application User Model ID. electron-builder puts that ID into the installer's
 * shortcuts and registry entries from `appId`; the main process has to declare the SAME string at
 * runtime with `app.setAppUserModelId`. When the two disagree, or when the runtime call is missing
 * altogether, Windows treats the pinned shortcut and the running window as two different programs:
 * the user pins the app, launches it, and gets a second taskbar button and a second icon — which
 * reads, from the seat, as "the pin doesn't work".
 *
 * So the value lives here rather than inline, the main process imports it, and
 * `tests/contract/app-identity.test.ts` pins it against `electron-builder.config.cjs` so the two
 * cannot drift apart again.
 *
 * Do not change this casually: a Windows user who has already pinned the app under this identity
 * gets a new taskbar entry, a new Start-menu grouping and a new jump list if it changes. Changing
 * it is a migration decision for the owner, not a refactor.
 */
export const APP_ID = 'com.nowplaying.companion';

/** What the owner sees in Start-menu, Add/Remove Programs and the taskbar. */
export const PRODUCT_NAME = 'Airwave Companion';
