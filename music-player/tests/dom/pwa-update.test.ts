/**
 * A new version must actually reach the listener.
 *
 * The registration and hand-over in `lib/pwa.ts` were already written and correct; what failed was
 * the trigger in the bridge. The reload was attached to a single `visibilitychange` -> hidden, so a
 * tab that stayed visible -- the ordinary case, a player left open on the radio -- kept serving the
 * cached build for as long as it was watched. A worker was observed parked at `waiting: true` while
 * the server was sending a newer build: a fix the listener had asked for sat installed and unused.
 *
 * `serviceWorkerApplies()` is deliberately false outside a production build and `import.meta.env`
 * cannot be rewritten from a test, so what these tests pin is the decision that was actually wrong:
 * WHEN a waiting build is taken. The rule is mirrored from bridge.ts rather than imported, because
 * it lives inside the registration callback; `npUpdateWhenQuiet` keeps the two in step.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { serviceWorkerApplies } from '../../src/lib/pwa.js';

/** The bridge's rule: take the first moment that interrupts nothing. */
function armUpdate(audio: HTMLAudioElement | null, reload: () => void): void {
  const playing = (): boolean => Boolean(audio && !audio.paused && !audio.ended);
  if (!playing()) { reload(); return; }
  const onHidden = (): void => { if (document.visibilityState === 'hidden') reload(); };
  const onceQuiet = (): void => { if (!playing()) reload(); };
  document.addEventListener('visibilitychange', onHidden, { once: true });
  audio?.addEventListener('ended', onceQuiet, { once: true });
  audio?.addEventListener('pause', onceQuiet, { once: true });
}

function fakeAudio(state: { paused: boolean; ended: boolean }): HTMLAudioElement {
  const el = document.createElement('audio');
  Object.defineProperty(el, 'paused', { get: () => state.paused });
  Object.defineProperty(el, 'ended', { get: () => state.ended });
  return el;
}

describe('a waiting version is taken at the first harmless moment', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('reloads at once when nothing is playing', () => {
    const reload = vi.fn();
    armUpdate(fakeAudio({ paused: true, ended: false }), reload);
    /* The case that used to hang forever: silent player, visible tab, new build parked. */
    expect(reload, 'an idle player takes the update immediately').toHaveBeenCalledTimes(1);
  });

  it('does not interrupt a playing track', () => {
    const reload = vi.fn();
    armUpdate(fakeAudio({ paused: false, ended: false }), reload);
    expect(reload, 'nothing is swapped out mid-track').not.toHaveBeenCalled();
  });

  it('takes it when the track ends', () => {
    const reload = vi.fn();
    const state = { paused: false, ended: false };
    const audio = fakeAudio(state);
    armUpdate(audio, reload);
    expect(reload).not.toHaveBeenCalled();

    state.ended = true;
    audio.dispatchEvent(new Event('ended'));
    expect(reload, 'the gap between tracks is a safe moment').toHaveBeenCalledTimes(1);
  });

  it('takes it when the listener pauses', () => {
    const reload = vi.fn();
    const state = { paused: false, ended: false };
    const audio = fakeAudio(state);
    armUpdate(audio, reload);

    state.paused = true;
    audio.dispatchEvent(new Event('pause'));
    expect(reload, 'a pause is also a safe moment').toHaveBeenCalledTimes(1);
  });

  it('still takes it when the tab is put away mid-track', () => {
    const reload = vi.fn();
    armUpdate(fakeAudio({ paused: false, ended: false }), reload);

    // The original trigger, kept rather than replaced: it was too narrow, not wrong.
    const was = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reload, 'a hidden tab is still a safe moment').toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { value: was, configurable: true });
  });

  it('registers no worker in a development build', () => {
    /* The guard that makes the registration itself untestable here is worth pinning: a dev page has
       no built worker, and registering one would serve the dist of some past build. */
    expect(serviceWorkerApplies(), 'no worker outside a production build').toBe(false);
  });
});
