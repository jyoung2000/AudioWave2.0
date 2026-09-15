/**
 * Shuffle, the way a click wheel did it.
 *
 * The obvious implementation — pick a random track each time the current one
 * ends — is what this player had, and it is not what any music player has
 * ever done. It repeats songs while others go unplayed: over a 20-track
 * album, a third of the tracks typically never come up before something
 * repeats, and the listener notices long before they can say why.
 *
 * An iPod shuffled the *order*, once, and then played it. Every song comes up
 * exactly once before any of them comes up twice, "previous" walks back
 * through the order you actually heard, and turning shuffle on does not
 * interrupt what is playing — the song you are on stays on, and the shuffle
 * begins after it.
 *
 * So the queue keeps its own order (an album stays in album order in the Up
 * next list, which is what that list is for) and this module keeps a
 * permutation of entry ids beside it. The two stay in step as the queue is
 * edited: an entry added while shuffle is on lands somewhere random in the
 * part of the order that has not played yet, rather than at the end where it
 * would be the last thing heard.
 *
 * Everything here is pure and takes its randomness as an argument, so the
 * tests can pin a sequence and assert the property that matters: a full pass
 * covers every track exactly once.
 */

export interface ShuffleOrder {
  /** Queue entry ids, in the order they will play. */
  readonly ids: readonly string[];
  /** Where in `ids` the current entry sits. -1 before anything has played. */
  readonly pos: number;
}

export type Random = () => number;

/** Fisher-Yates. Unbiased, in place on a copy, one pass. */
function shuffled(ids: readonly string[], random: Random): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/**
 * Start a pass. When something is already playing it keeps playing: it is
 * moved to the front and the rest are shuffled behind it.
 */
export function makeShuffleOrder(ids: readonly string[], currentId: string | null, random: Random = Math.random): ShuffleOrder {
  if (ids.length === 0) return { ids: [], pos: -1 };
  if (currentId === null || !ids.includes(currentId)) return { ids: shuffled(ids, random), pos: -1 };
  const rest = shuffled(
    ids.filter((id) => id !== currentId),
    random,
  );
  return { ids: [currentId, ...rest], pos: 0 };
}

/**
 * The next entry, or null when the pass is over and it should not start again.
 *
 * With repeat-all the pass restarts, reshuffled — a second identical pass
 * would not be a shuffle. The new pass avoids opening on the song that just
 * closed the old one, which is the one repeat a listener always hears.
 */
export function nextInShuffle(order: ShuffleOrder, repeatAll: boolean, random: Random = Math.random): { order: ShuffleOrder; id: string } | null {
  if (order.ids.length === 0) return null;
  const at = order.pos + 1;
  if (at < order.ids.length) {
    const id = order.ids[at]!;
    return { order: { ids: order.ids, pos: at }, id };
  }
  if (!repeatAll) return null;
  const last = order.ids[order.ids.length - 1] ?? null;
  let next = shuffled(order.ids, random);
  // One retry is enough: with two or more entries it almost always separates
  // them, and refusing to loop keeps this from hanging on a pathological random.
  if (order.ids.length > 1 && next[0] === last) next = shuffled(order.ids, random);
  return { order: { ids: next, pos: 0 }, id: next[0]! };
}

/** The entry before this one in the order actually heard, or null at the start of the pass. */
export function previousInShuffle(order: ShuffleOrder): { order: ShuffleOrder; id: string } | null {
  if (order.pos <= 0) return null;
  const at = order.pos - 1;
  return { order: { ids: order.ids, pos: at }, id: order.ids[at]! };
}

/**
 * Bring the order back in step with a queue that has been edited.
 *
 * Removed entries drop out. New entries are dealt into the part of the pass
 * that has not played yet, so adding a song while shuffle is on can put it
 * anywhere still to come rather than always last.
 */
export function syncShuffleOrder(order: ShuffleOrder, ids: readonly string[], random: Random = Math.random): ShuffleOrder {
  const present = new Set(ids);
  const currentId = order.pos >= 0 ? (order.ids[order.pos] ?? null) : null;
  const kept = order.ids.filter((id) => present.has(id));
  const known = new Set(kept);
  const added = ids.filter((id) => !known.has(id));

  const next = [...kept];
  // Everything from here on is unplayed; a new entry may land anywhere in it.
  let cursor = currentId !== null ? next.indexOf(currentId) : -1;
  for (const id of added) {
    const from = cursor + 1;
    const at = from + Math.floor(random() * (next.length - from + 1));
    next.splice(at, 0, id);
    if (currentId !== null) cursor = next.indexOf(currentId);
  }
  const pos = currentId !== null ? next.indexOf(currentId) : Math.min(order.pos, next.length - 1);
  return { ids: next, pos };
}

/**
 * The listener picked a track themselves. It becomes the current point in the
 * pass wherever it sits, so what follows is the rest of the shuffle rather
 * than a new one.
 */
export function jumpInShuffle(order: ShuffleOrder, id: string): ShuffleOrder {
  const at = order.ids.indexOf(id);
  return at === -1 ? order : { ids: order.ids, pos: at };
}

/** How much of this pass is left, for the Up next list to show. */
export function remainingInShuffle(order: ShuffleOrder): readonly string[] {
  return order.pos < 0 ? order.ids : order.ids.slice(order.pos + 1);
}
