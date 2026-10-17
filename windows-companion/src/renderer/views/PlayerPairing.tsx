import { useState } from 'react';
import type { HelperStatus, Preferences } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { Push, Status } from '../ui.js';
import { playerHelperAddress } from './player-pairing.js';

export function PlayerPairing({ helper, preferences }: { helper: HelperStatus | null; preferences: Preferences | null }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const address = playerHelperAddress(helper, preferences);

  const toggleToken = async () => {
    if (token) {
      setToken(null);
      setNote(null);
      return;
    }
    setBusy(true);
    try {
      const result = await invoke('helper:token', undefined);
      setToken(result.token);
      setNote(result.token ? null : 'Windows could not protect a token on this PC, so one is not available.');
    } catch {
      setNote('The Player token could not be read from Companion.');
    } finally {
      setBusy(false);
    }
  };

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setNote('Player address copied.');
    } catch {
      setNote('The address could not be copied.');
    }
  };

  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setNote('Player token copied. Keep it private.');
    } catch {
      setNote('The token could not be copied. Select it and copy it yourself.');
    }
  };

  return (
    <fieldset className="player-pairing" style={{ marginTop: 0 }}>
      <legend>Legacy local helper access</legend>
      <p className="hint">For older or local-only helper workflows. New Player installs should use the single Companion pairing address and one-time code above; this legacy token is not the pairing code.</p>
      <p className="note" role="status">
        {helper ? <Status kind={helper.running ? 'ok' : 'warn'}>{helper.running ? `Helper running on port ${helper.port}` : helper.reason ?? 'The local helper is starting.'}</Status> : 'Checking the local helper…'}
      </p>
      <div className="pref">
        <span className="k">Local helper address:</span>
        <div className="v">
          <code className="path">{address}</code>
          <Push onClick={() => void copyAddress()}>Copy address</Push>
          <span className="sub">Leave the Player address blank to discover this helper automatically; paste this address only if discovery fails.</span>
        </div>
        <span className="k">Legacy helper token:</span>
        <div className="v">
          {token ? <code className="path" aria-label="Player pairing token">{token}</code> : <span className="dim">Hidden until you choose Show token.</span>}
          <div className="barrow">
            <Push busy={busy} onClick={() => void toggleToken()}>{token ? 'Hide token' : 'Show token'}</Push>
            <Push disabled={!token} onClick={() => void copyToken()}>Copy token</Push>
          </div>
          <span className="sub">Use only for legacy direct-helper access on this PC. The unified Player pairing uses the address and one-time code above; the token is not sent to remote devices.</span>
        </div>
      </div>
      {note ? <p className="note" role="status">{note}</p> : null}
    </fieldset>
  );
}
