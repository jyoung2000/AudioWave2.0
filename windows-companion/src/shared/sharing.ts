/**
 * Whether this PC's library is synced to the hub.
 *
 * Pairing with a hub that grants `library:share` is the decision to share — it is what pairing a
 * companion is for — so sharing is on from then until it is turned off in Remote ▸ What is shared.
 * `stored` is what the window last saved: `false` once it was turned off, `true` or nothing
 * otherwise (forgetting a hub clears it). A hub that never granted the permission is never shared
 * with, whatever was stored.
 */
export function sharingIsOn(stored: boolean | null | undefined, hubGrantsSharing: boolean): boolean {
  if (stored === false) return false;
  return hubGrantsSharing;
}
