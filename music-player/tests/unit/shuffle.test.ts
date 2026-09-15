import { describe, expect, it } from 'vitest';
import { jumpInShuffle, makeShuffleOrder, nextInShuffle, previousInShuffle, remainingInShuffle, syncShuffleOrder, type ShuffleOrder } from '../../src/lib/shuffle.js';

/** A pinned sequence, so a test asserts behaviour rather than luck. */
function sequence(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

const IDS = ['a', 'b', 'c', 'd', 'e'];

/** Walk a whole pass and collect what played, in order. */
function playThrough(order: ShuffleOrder, repeatAll = false, random = Math.random): string[] {
  const heard: string[] = [];
  let cursor = order;
  if (cursor.pos >= 0) heard.push(cursor.ids[cursor.pos]!);
  for (;;) {
    const step = nextInShuffle(cursor, repeatAll, random);
    if (!step) break;
    heard.push(step.id);
    cursor = step.order;
    if (heard.length > 200) throw new Error('a pass that never ends');
  }
  return heard;
}

describe('a shuffled pass', () => {
  it('plays every track exactly once, whatever the randomness', () => {
    // The property the old implementation broke: it picked a fresh random
    // index each time, so some tracks repeated while others never played.
    for (let seed = 0; seed < 60; seed += 1) {
      const random = sequence([seed / 60, (seed * 7) % 60 / 60, (seed * 13) % 60 / 60, 0.5, 0.01, 0.99]);
      const order = makeShuffleOrder(IDS, null, random);
      const heard = playThrough(order);
      expect(heard.slice().sort()).toEqual([...IDS].sort());
      expect(new Set(heard).size, 'no track plays twice in a pass').toBe(IDS.length);
    }
  });

  it('keeps playing what is already playing, and shuffles the rest behind it', () => {
    const order = makeShuffleOrder(IDS, 'c', sequence([0.9, 0.1, 0.7, 0.3]));
    expect(order.ids[0]).toBe('c');
    expect(order.pos).toBe(0);
    expect([...order.ids].sort()).toEqual([...IDS].sort());
    // And the rest of the pass still covers everything else exactly once.
    expect(playThrough(order).slice().sort()).toEqual([...IDS].sort());
  });

  it('ends the pass rather than looping, unless repeat-all is on', () => {
    const order = makeShuffleOrder(['a', 'b'], 'a', sequence([0]));
    const second = nextInShuffle(order, false)!;
    expect(second.id).toBe('b');
    expect(nextInShuffle(second.order, false), 'the queue is finished').toBeNull();

    const again = nextInShuffle(second.order, true, sequence([0.4, 0.6]));
    expect(again, 'repeat-all starts a fresh pass').not.toBeNull();
    expect(again!.order.pos).toBe(0);
  });

  it('does not open a new pass with the song that just closed the last one', () => {
    const start: ShuffleOrder = { ids: ['a', 'b', 'c'], pos: 2 };
    // A random that would otherwise leave 'c' first on the first try.
    const step = nextInShuffle(start, true, sequence([0.99, 0.99, 0.99, 0, 0.5, 0]));
    expect(step).not.toBeNull();
    expect(step!.id).not.toBe('c');
  });

  it('walks back through what was actually heard', () => {
    let order = makeShuffleOrder(IDS, 'a', sequence([0.2, 0.8, 0.4, 0.6]));
    const heard = [order.ids[0]!];
    for (let i = 0; i < 3; i += 1) {
      const step = nextInShuffle(order, false)!;
      order = step.order;
      heard.push(step.id);
    }
    const back = previousInShuffle(order)!;
    expect(back.id).toBe(heard[heard.length - 2]);
    expect(previousInShuffle({ ids: IDS, pos: 0 }), 'nothing before the first').toBeNull();
  });
});

describe('a pass that survives the queue being edited', () => {
  it('drops removed entries and keeps the current one current', () => {
    const order: ShuffleOrder = { ids: ['c', 'a', 'e', 'b', 'd'], pos: 1 };
    const synced = syncShuffleOrder(order, ['a', 'c', 'd'], sequence([0]));
    expect([...synced.ids].sort()).toEqual(['a', 'c', 'd']);
    expect(synced.ids[synced.pos]).toBe('a');
  });

  it('deals a newly queued track into the part that has not played yet', () => {
    const order: ShuffleOrder = { ids: ['c', 'a', 'e'], pos: 1 };
    for (const r of [0, 0.5, 0.999]) {
      const synced = syncShuffleOrder(order, ['c', 'a', 'e', 'new'], sequence([r]));
      const at = synced.ids.indexOf('new');
      expect(at, 'never behind the current track, where it could not play').toBeGreaterThan(synced.pos);
      expect(synced.ids[synced.pos]).toBe('a');
    }
  });

  it('still covers everything exactly once after an edit', () => {
    const order = makeShuffleOrder(IDS, 'b', sequence([0.3, 0.7, 0.1]));
    const synced = syncShuffleOrder(order, [...IDS, 'f'], sequence([0.5]));
    const heard = playThrough(synced);
    expect(heard.slice().sort()).toEqual([...IDS, 'f'].sort());
  });
});

describe('picking a track by hand', () => {
  it('continues the pass from there rather than starting a new one', () => {
    const order: ShuffleOrder = { ids: ['c', 'a', 'e', 'b', 'd'], pos: 0 };
    const jumped = jumpInShuffle(order, 'b');
    expect(jumped.pos).toBe(3);
    expect(jumped.ids, 'the order itself is untouched').toEqual(order.ids);
    expect(nextInShuffle(jumped, false)!.id).toBe('d');
  });

  it('leaves the order alone when the track is not in it', () => {
    const order: ShuffleOrder = { ids: ['a', 'b'], pos: 0 };
    expect(jumpInShuffle(order, 'zzz')).toEqual(order);
  });
});

describe('what is left of the pass', () => {
  it('is everything after the current track, for the Up next list', () => {
    expect(remainingInShuffle({ ids: ['c', 'a', 'e'], pos: 0 })).toEqual(['a', 'e']);
    expect(remainingInShuffle({ ids: ['c', 'a', 'e'], pos: -1 })).toEqual(['c', 'a', 'e']);
    expect(remainingInShuffle({ ids: ['c', 'a'], pos: 1 })).toEqual([]);
  });
});

describe('the edges', () => {
  it('handles an empty queue and a single track', () => {
    expect(makeShuffleOrder([], null)).toEqual({ ids: [], pos: -1 });
    expect(nextInShuffle({ ids: [], pos: -1 }, true)).toBeNull();
    const one = makeShuffleOrder(['only'], 'only');
    expect(one).toEqual({ ids: ['only'], pos: 0 });
    expect(nextInShuffle(one, false)).toBeNull();
    expect(nextInShuffle(one, true)!.id, 'repeat-all replays the only track').toBe('only');
  });
});
