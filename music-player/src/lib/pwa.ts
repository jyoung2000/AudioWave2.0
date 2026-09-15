/**
 * Service worker registration, and the one thing it owes the listener: to say when a new version
 * is ready and let them choose the moment, instead of swapping the app out under a playing track.
 *
 * Nothing here runs in the single-file build, from a `file://` page, or in development: there is
 * no worker to register in any of those, and a registration that fails would only be noise.
 */
import { isFileOrigin, isSingleFileBuild } from './build-flags.js';

export interface UpdateReady {
  /** Hand over to the waiting version and reload once it is in control. */
  reload(): void;
}

export function serviceWorkerApplies(): boolean {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  if (isSingleFileBuild() || isFileOrigin()) return false;
  return import.meta.env.PROD;
}

/** Register the worker built beside the app. Resolves once registration has been attempted. */
export async function registerServiceWorker(onUpdateReady: (update: UpdateReady) => void): Promise<boolean> {
  if (!serviceWorkerApplies()) return false;
  try {
    const { Workbox } = await import('workbox-window');
    const wb = new Workbox(`${import.meta.env.BASE_URL}sw.js`);
    wb.addEventListener('waiting', () => {
      onUpdateReady({
        reload: () => {
          wb.addEventListener('controlling', () => window.location.reload());
          void wb.messageSkipWaiting();
        },
      });
    });
    await wb.register();
    return true;
  } catch {
    // A failed registration only costs starting with no network; the app itself is unaffected.
    return false;
  }
}
