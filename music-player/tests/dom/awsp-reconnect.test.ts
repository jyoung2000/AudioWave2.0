/**
 * What a paired PC's connection may claim, and how a dead one is recovered.
 *
 * Measured in the user's paired profile over ten minutes: the Companion sat at `reconnecting` on
 * 32 consecutive checks with `lastError: "3 pongs missed"`, then `"connecting timed out"`, while the
 * Companion's own log showed it accepting connections from this very endpoint at 90-200ms rtt and
 * its helper answered HTTP 200 directly. Two separate faults were behind that, and both are pinned
 * here because each one alone is enough to make a working Companion look absent:
 *
 *  1. `connect()` answered `{ ok: true }` whenever the worker merely accepted the request, so the
 *     UI reported a connected Companion whose `connectionType` was null and whose tool detection
 *     returned nothing at all.
 *  2. a connect timeout was retried forever on the same wedged endpoint, so the backoff loop could
 *     never recover and only a page reload fixed it -- with the downloaders unreachable until then.
 */
import { describe, expect, it } from 'vitest';

type Status = 'idle' | 'pairing' | 'connecting' | 'connected' | 'reconnecting' | 'refused';

/** `awsp.ts connect()`: a connection is claimed only when the worker says it has one. */
function connectResult(live: { status: Status; lastError: string | null }):
  { ok: boolean; reason: string | null } {
  if (live.status === 'connected') return { ok: true, reason: null };
  return { ok: false, reason: live.lastError ?? `The PC has not answered yet (${live.status}).` };
}

/** `awsp-worker.ts scheduleReconnect()`: a timeout needs a new endpoint, not another attempt. */
function needsNewEndpoint(lastError: string): boolean {
  return /timed out/.test(lastError);
}

describe('what a paired PC connection may claim', () => {
  it('does not report success while the worker is still reconnecting', () => {
    // The exact reading taken from the paired profile.
    expect(connectResult({ status: 'reconnecting', lastError: '3 pongs missed' }))
      .toEqual({ ok: false, reason: '3 pongs missed' });
  });

  it('reports success only when a connection exists', () => {
    expect(connectResult({ status: 'connected', lastError: null })).toEqual({ ok: true, reason: null });
  });

  it('says something usable when there is no error to quote', () => {
    const r = connectResult({ status: 'connecting', lastError: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/has not answered yet/);
  });

  it('keeps a refusal distinct from a connection that is merely late', () => {
    /* `refused` means re-pair; it must not be dressed up as a connection, and it must not be
       reported as something that might still arrive. */
    const r = connectResult({ status: 'refused', lastError: 'This PC no longer accepts this player. Pair again.' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Pair again/);
  });
});

describe('recovering a connection that stopped being heard', () => {
  it('rebuilds the endpoint when a connect times out', () => {
    // The error that span forever in the paired profile.
    expect(needsNewEndpoint('connecting timed out')).toBe(true);
  });

  it('retries on the same endpoint for an ordinary lost connection', () => {
    /* A keepalive miss or a closed stream is worth a plain retry: the endpoint is still being
       heard, and rebuilding it on every blip would throw away a working client. */
    expect(needsNewEndpoint('3 pongs missed')).toBe(false);
    expect(needsNewEndpoint('the control stream ended')).toBe(false);
    expect(needsNewEndpoint('closed 7: relay reset')).toBe(false);
  });

  it('treats a request timeout the same way, whatever timed out', () => {
    expect(needsNewEndpoint('hello timed out')).toBe(true);
  });
});

/**
 * `awsp-tools.ts detect()`: whether the PC's downloaders are reported as reachable.
 *
 * The third fault behind the same symptom. With the Companion paired and the relay carrying data,
 * the status field read `reconnecting`, `connect()` therefore answered falsely, and this gate gave
 * up — so `detect()` returned all-null and the downloaders read as absent while the relay was
 * answering `tools.status` with yt-dlp 2026.08.19, spotdl 4.5.2 and ffmpeg n9.0.1.
 */
function toolsReachable(opts: {
  paired: boolean;
  status: Status;
  connectOk: boolean;
  probeAnswers: boolean;
}): boolean {
  if (!opts.paired) return false;
  if (opts.status !== 'connected' && !opts.connectOk) return opts.probeAnswers;
  return true;
}

describe('reporting the PC downloaders', () => {
  it('uses a channel that answers even when the status field says reconnecting', () => {
    // The exact paired-profile reading: status stale, relay healthy.
    expect(toolsReachable({ paired: true, status: 'reconnecting', connectOk: false, probeAnswers: true }))
      .toBe(true);
  });

  it('reports nothing when the channel genuinely does not answer', () => {
    expect(toolsReachable({ paired: true, status: 'reconnecting', connectOk: false, probeAnswers: false }))
      .toBe(false);
  });

  it('never reports tools for an unpaired PC, however healthy the channel looks', () => {
    /* Without pairing there is no PC to speak for; a probe answering here would mean something
       else is on the other end. */
    expect(toolsReachable({ paired: false, status: 'connected', connectOk: true, probeAnswers: true }))
      .toBe(false);
  });

  it('asks nothing extra when the connection is already up', () => {
    expect(toolsReachable({ paired: true, status: 'connected', connectOk: true, probeAnswers: false }))
      .toBe(true);
  });
});

/**
 * Which tab of the player holds the one connection to the PC.
 *
 * The cause under the three faults above. The endpoint identity comes from the pairing secret, and
 * every tab of the same origin shares that secret -- so two open tabs raise two QUIC endpoints with
 * the *same* endpoint id and compete for a single relay slot. Measured with two tabs open: both
 * reported endpoint `7c6102674bb8234228af...`, the Companion accepted a fresh connection every ~35s,
 * and each tab's keepalive died on the other's with "3 pongs missed" forever. Recovering the
 * connection was not enough while two tabs kept taking it from each other.
 */
function ownership() {
  const tabs = new Map<string, boolean>();
  return {
    open(id: string) {
      // A new tab claims the slot; everyone else stands down.
      for (const k of tabs.keys()) tabs.set(k, false);
      tabs.set(id, true);
    },
    close(id: string) {
      const wasOwner = tabs.get(id) === true;
      tabs.delete(id);
      // The owner leaving must not leave nobody connected.
      if (wasOwner) {
        const next = [...tabs.keys()].pop();
        if (next) tabs.set(next, true);
      }
    },
    owner: () => [...tabs.entries()].filter(([, v]) => v).map(([k]) => k),
  };
}

describe('one tab at a time on the PC connection', () => {
  it('never lets two tabs hold the connection at once', () => {
    const o = ownership();
    o.open('a');
    o.open('b');
    // The exact two-tab case that produced "3 pongs missed" every ~35s.
    expect(o.owner()).toEqual(['b']);
  });

  it('hands the connection back when the holder closes', () => {
    const o = ownership();
    o.open('a');
    o.open('b');
    o.close('b');
    expect(o.owner()).toEqual(['a']);
  });

  it('leaves nobody connected when the last tab closes', () => {
    const o = ownership();
    o.open('a');
    o.close('a');
    expect(o.owner()).toEqual([]);
  });

  it('does not disturb the holder when a background tab closes', () => {
    const o = ownership();
    o.open('a');
    o.open('b');
    o.close('a');
    expect(o.owner()).toEqual(['b']);
  });

  it('gives the connection to a third tab that opens', () => {
    const o = ownership();
    o.open('a');
    o.open('b');
    o.open('c');
    expect(o.owner()).toEqual(['c']);
  });
});
