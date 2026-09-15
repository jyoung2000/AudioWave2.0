/**
 * What `workbox-window` resolves to in the single-file build.
 *
 * That build never registers a worker — a `file://` page has no origin to register one against, and
 * the registration code checks before it tries — but bundling the real module would still put the
 * text `serviceWorker.register` into a file whose test, rightly, insists it carries no such thing.
 * So the local build aliases the module to this shape, which does nothing and is never reached.
 */
export class Workbox {
  constructor(_scriptUrl: string) {
    // Nothing to hold: there is no worker.
  }
  addEventListener(_type: string, _listener: (event: { isUpdate?: boolean }) => void): void {
    // No events will ever fire.
  }
  register(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  messageSkipWaiting(): void {
    // No worker is waiting.
  }
}
