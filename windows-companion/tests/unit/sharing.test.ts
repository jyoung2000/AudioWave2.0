import { describe, expect, it } from 'vitest';
import { sharingIsOn } from '../../src/shared/sharing.js';

describe('sharing with a hub', () => {
  it('is on from pairing, when the hub grants it', () => {
    expect(sharingIsOn(null, true)).toBe(true);
    expect(sharingIsOn(undefined, true)).toBe(true);
    expect(sharingIsOn(true, true)).toBe(true);
  });

  it('stays off once it was turned off, until the hub is forgotten', () => {
    expect(sharingIsOn(false, true)).toBe(false);
    // Forgetting a hub clears the stored choice, so the next one starts as the first did.
    expect(sharingIsOn(null, true)).toBe(true);
  });

  it('is never on for a hub that did not grant the permission, or with no hub', () => {
    expect(sharingIsOn(true, false)).toBe(false);
    expect(sharingIsOn(null, false)).toBe(false);
  });
});
